// Runs after navigation reached DOMContentLoaded and returns one result item.
// Ported from the Apify "pageFunction" of voila-auditing-automation: the item has the same fields,
// so the n8n "Analyze Browser Results" node reads it unchanged.

// A resource that answered 429/502/503/504 while the page was loading is requested again, one at a time and
// slowly, from the same browser context (same cookies and IP). If it now answers < 400 the first answer was
// rate limiting caused by the burst of parallel page loads, not a broken file. The result is stored in
// `recheck` on the entry of qa.bad; the caller decides what to report.
const RECHECK_STATUSES = [429, 502, 503, 504];
const RECHECK_MAX_URLS = 15;
const RECHECK_WAITS_MS = [3000, 8000];
export const RECHECK_BUDGET_MS = 60000; // total per page; run.mjs adds it to the page timeout

async function recheckBad(page, qa, statuses, bypass) {
  const seen = new Map();
  for (const b of qa.bad) {
    if (!statuses.includes(b.status) || b.resourceType === 'document' || seen.has(b.url)) continue;
    if (seen.size >= RECHECK_MAX_URLS) break;
    seen.set(b.url, null);
  }
  const deadline = Date.now() + RECHECK_BUDGET_MS;
  for (const url of seen.keys()) {
    let last = null;
    for (let attempt = 0; attempt < RECHECK_WAITS_MS.length && Date.now() < deadline; attempt++) {
      await page.waitForTimeout(RECHECK_WAITS_MS[attempt]);
      try {
        const res = await page.context().request.get(url, { timeout: 15000, failOnStatusCode: false, maxRedirects: 3, headers: bypassHeadersFor(bypass, url) });
        last = { status: res.status(), attempts: attempt + 1 };
        await res.dispose().catch(() => {});
      } catch (e) {
        last = { status: 0, attempts: attempt + 1, error: String((e && e.message) || e).split('\n')[0].slice(0, 120) };
      }
      if (last.status > 0 && last.status < 400) break;
    }
    seen.set(url, last);
  }
  for (const b of qa.bad) if (seen.get(b.url)) b.recheck = seen.get(b.url);
}

import { bypassHeadersFor } from './bypass.js';

export async function checkPage(page, qa, url, { loadWaitMs, settleMs, recheckStatuses = RECHECK_STATUSES, resolvedBypass = null }) {
  // Navigation returned at DOMContentLoaded; give the full "load" event a bounded wait.
  let loadTimedOut = false;
  await page.waitForLoadState('load', { timeout: loadWaitMs }).catch(() => { loadTimedOut = true; });

  // Bounded wait for late scripts, lazy content and XHR after the load event.
  await page.waitForTimeout(settleMs);

  const dom = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const loaders = [...document.querySelectorAll(
      '[class*="preloader" i],[class*="spinner" i],[class*="loader" i],[id*="preloader" i],[id*="loader" i],[aria-busy="true"]'
    )].filter(isVisible);

    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    const resources = performance.getEntriesByType('resource');

    const brokenImages = [...document.images]
      .filter((img) => {
        const src = img.currentSrc || img.src;
        return src && !src.startsWith('data:') && img.complete && img.naturalWidth === 0;
      })
      .map((img) => (img.currentSrc || img.src).slice(0, 500));

    const links = [...new Set(
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.href)
        .filter((h) => /^https?:/i.test(h))
        .map((h) => h.split('#')[0])
    )].slice(0, 400);

    const text = (document.body && document.body.innerText) || '';
    const describe = (el) => el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

    return {
      title: document.title,
      textLength: text.trim().length,
      h1Count: document.querySelectorAll('h1').length,
      hasMain: !!document.querySelector('main, [role="main"]'),
      loaderVisible: loaders.slice(0, 3).map(describe),
      brokenImages: [...new Set(brokenImages)].slice(0, 30),
      links,
      perf: {
        ttfb: Math.round(nav.responseStart || 0) || null,
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0) || null,
        load: Math.round(nav.loadEventEnd || 0) || null,
        fcp: paint ? Math.round(paint.startTime) : null,
        lcp: window.__qaPerf && window.__qaPerf.lcp ? Math.round(window.__qaPerf.lcp) : null,
        cls: window.__qaPerf ? Math.round(window.__qaPerf.cls * 1000) / 1000 : null,
        requests: resources.length + 1,
        transferKB: Math.round((resources.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav.transferSize || 0)) / 1024),
      },
    };
  });

  if (recheckStatuses.length) await recheckBad(page, qa, recheckStatuses, resolvedBypass).catch(() => {});

  return {
    url,
    loadedUrl: page.url(),
    nav: qa.nav,
    loadTimedOut,
    consoleErrors: qa.console,
    consoleWarnings: qa.warnings,
    pageErrors: qa.pageErrors,
    failedRequests: qa.failed,
    badResponses: qa.bad,
    ...dom,
  };
}
