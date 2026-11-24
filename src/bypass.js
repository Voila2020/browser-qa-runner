// Optional "trusted monitor" header. A site behind a CDN/WAF (Cloudflare) can answer 429 or a challenge to
// a datacenter IP; the site owner then adds a rule "header <name> equals <secret> -> skip rate limiting".
// This module sends that header, and only to the hosts of the job's own URLs (never to third parties).
//
// Job option:  "bypass": { "headerName": "x-qa-token", "secretName": "QA_TOKEN_SITE" }
// The secret VALUE is never part of the job: it is read from the repository secret `secretName`, which the
// workflow passes in QA_SECRETS (JSON of all secrets). Names must start with QA_TOKEN_ so a job cannot
// ask for another secret (e.g. the callback secret).

const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_PREFIX = 'QA_TOKEN_';

export function resolveBypass(job, env = process.env) {
  const b = job.bypass;
  if (!b || !b.secretName) return null;
  const warn = (m) => { console.log(`Bypass header not used: ${m}`); return null; };
  if (!HEADER_RE.test(String(b.headerName || ''))) return warn('invalid headerName');
  if (!String(b.secretName).startsWith(SECRET_PREFIX)) return warn(`secretName must start with ${SECRET_PREFIX}`);
  let secrets = {};
  try { secrets = JSON.parse(env.QA_SECRETS || '{}'); } catch (e) { return warn('QA_SECRETS is not valid JSON'); }
  const value = String(secrets[b.secretName] || '');
  if (!value || /[\r\n]/.test(value)) return warn(`secret ${b.secretName} is missing or empty`);
  const hosts = [...new Set(job.urls.map((u) => new URL(u).host))];
  console.log(`Bypass header ${b.headerName} is sent to: ${hosts.join(', ')}`);
  return { name: String(b.headerName).toLowerCase(), value, hosts };
}

// Headers to add to a request made outside the browser (APIRequestContext), if its host is covered.
export function bypassHeadersFor(bypass, url) {
  if (!bypass) return undefined;
  try { return bypass.hosts.includes(new URL(url).host) ? { [bypass.name]: bypass.value } : undefined; } catch (e) { return undefined; }
}

// Adds the header to every browser request to the covered hosts, through CDP request interception limited
// to those URL patterns (other hosts are not intercepted, so they never see the header).
export async function attachBypass(page, bypass) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Fetch.requestPaused', (ev) => {
    const headers = Object.entries(ev.request.headers || {})
      .filter(([k]) => k.toLowerCase() !== bypass.name)
      .map(([name, value]) => ({ name, value: String(value) }));
    headers.push({ name: bypass.name, value: bypass.value });
    cdp.send('Fetch.continueRequest', { requestId: ev.requestId, headers }).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: bypass.hosts.map((h) => ({ urlPattern: `*://${h}/*`, requestStage: 'Request' })) });
}
