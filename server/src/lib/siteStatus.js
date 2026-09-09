// On-demand live-site check (2026-09-09). No polling, no stored history —
// the operator hits "check" in the DOMAIN panel and gets a snapshot: does
// DNS resolve, does the site answer over HTTPS, is the TLS cert valid and
// for how long, and where do apex/www redirect. Continuous uptime
// monitoring is a separate feature (a generated scheduled GitHub Action in
// the operator's own repo — never Morpheus polling).
import dns from 'node:dns/promises';
import tls from 'node:tls';

const HTTP_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 8_000;
const MAX_HOPS = 6;

async function dnsCheck(host) {
  const out = { host, resolves: false, a: [], cname: [] };
  const [a, cname] = await Promise.allSettled([dns.resolve4(host), dns.resolveCname(host)]);
  if (a.status === 'fulfilled' && a.value.length) { out.a = a.value; out.resolves = true; }
  if (cname.status === 'fulfilled' && cname.value.length) { out.cname = cname.value; out.resolves = true; }
  if (!out.resolves) {
    // AAAA-only sites still count as resolving
    const aaaa = await dns.resolve6(host).catch(() => []);
    if (aaaa.length) { out.resolves = true; out.aaaa = aaaa; }
  }
  return out;
}

function tlsCheck(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const socket = tls.connect({ host, port: 443, servername: host, timeout: TLS_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      if (!cert || !cert.valid_to) return finish({ ok: false, error: authError || 'no certificate presented' });
      const expires = new Date(cert.valid_to);
      const daysLeft = Math.round((expires.getTime() - Date.now()) / 86_400_000);
      finish({
        ok: authorized,
        daysLeft,
        expires: expires.toISOString(),
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        error: authorized ? null : (authError || 'certificate not trusted'),
      });
    });
    socket.on('error', (e) => finish({ ok: false, error: e.message }));
    socket.on('timeout', () => { socket.destroy(); finish({ ok: false, error: `timeout after ${TLS_TIMEOUT_MS}ms` }); });
  });
}

async function httpCheck(startUrl) {
  const hops = [];
  let url = startUrl;
  let finalStatus = null;
  let error = null;
  const started = Date.now();
  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'MorpheusSiteCheck/1.0', Accept: 'text/html,*/*' } });
      } finally {
        clearTimeout(t);
      }
      const loc = res.headers.get('location');
      hops.push({ url, status: res.status, location: loc || null });
      finalStatus = res.status;
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      break;
    }
  } catch (e) {
    error = e.name === 'AbortError' ? `timeout after ${HTTP_TIMEOUT_MS}ms` : e.message;
  }
  return {
    ok: finalStatus != null && finalStatus < 400,
    status: finalStatus,
    finalUrl: hops.length ? hops[hops.length - 1].url : startUrl,
    responseTimeMs: Date.now() - started,
    hops,
    error,
  };
}

/**
 * @param {string} domain registrable domain, no protocol (e.g. "example.com")
 * @param {'apex'|'www'} canonical which hostname should be the destination
 */
export async function checkSite(domain, canonical = 'apex') {
  if (!domain) throw Object.assign(new Error('domain required'), { status: 400 });
  const apex = domain;
  const www = `www.${domain}`;
  const canonicalHost = canonical === 'www' ? www : apex;

  const [apexDns, wwwDns, tlsRes, apexHttp, wwwHttp] = await Promise.all([
    dnsCheck(apex),
    dnsCheck(www),
    tlsCheck(canonicalHost),
    httpCheck(`https://${apex}/`),
    httpCheck(`https://${www}/`),
  ]);

  // Does the non-canonical host redirect to the canonical one?
  const other = canonical === 'www' ? apexHttp : wwwHttp;
  const canonHost = canonicalHost.toLowerCase();
  let redirectOk = null;
  if (other.status != null) {
    try {
      redirectOk = other.hops.some((h) => h.location && new URL(h.location, h.url).host.toLowerCase().replace(/^www\./, '') === canonHost.replace(/^www\./, ''))
        || new URL(other.finalUrl).host.toLowerCase() === canonHost;
    } catch { redirectOk = false; }
  }

  const live = (canonical === 'www' ? wwwHttp : apexHttp).ok && tlsRes.ok;
  return {
    domain,
    canonicalHost,
    checkedAt: new Date().toISOString(),
    live,
    dns: { apex: apexDns, www: wwwDns },
    tls: tlsRes,
    http: { apex: apexHttp, www: wwwHttp },
    redirect: { expected: canonical, ok: redirectOk },
  };
}
