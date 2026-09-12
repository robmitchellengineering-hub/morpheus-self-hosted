// Self-dev / build-pipeline external API pre-flight check (KNOWN-HAZARDS.md
// candidate, motivated by the Alice-stats incident, 2026-09-12): the planner
// can flag a real HTTP endpoint it intends to have the coder call; this
// module actually calls it — for real, before any code is written against
// it — so a hallucinated route (404, wrong host, wrong param name) is caught
// as ground truth instead of discovered by the operator days later, staring
// at a page that hangs on "Loading..." forever.
//
// This is a genuinely new capability: letting AI-directed output trigger a
// live outbound HTTP request from the server. That's a real SSRF surface —
// a hallucinated (or adversarial) "verify this API" URL must never be able
// to reach this deployment's own internal services, a cloud metadata
// endpoint, or anything on a private network. GET-only, no redirects
// followed blindly, timeout- and size-capped, every resolved IP checked
// against the private/reserved ranges before the request is allowed to
// proceed — not just the hostname's string shape, which DNS rebinding can
// trivially spoof.
import dns from 'node:dns/promises';
import net from 'node:net';

const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2000;
const MAX_URLS_PER_TURN = 5;
const UA = 'MorpheusSelfDevApiCheck/1.0 (+https://morpheus.nz)';

// IPv4/IPv6 ranges that must never be reached from a server-side "check
// this URL for me" primitive: loopback, link-local (169.254.0.0/16 covers
// the AWS/GCP/Azure metadata IP, 169.254.169.254), private RFC1918/ULA
// space, and the unspecified address.
function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true; // unspecified / "this network"
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower === '::') return true; // unspecified
    if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA (fc00::/7)
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // couldn't parse — refuse rather than guess
}

async function resolvesToPrivateIp(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.some((r) => isPrivateOrReservedIp(r.address));
  } catch {
    return true; // DNS failure — refuse rather than proceed against an unresolvable host
  }
}

/**
 * Actually call a URL the planner flagged, and report what's really there.
 * GET only, one hop (no following a redirect to a second, unvetted host).
 *
 * @param {{url: string, why?: string}} call
 * @returns {Promise<{url, ok, blocked?, status?, contentType?, shapeHint?, bodyPreview?, error?}>}
 */
export async function verifyExternalApiCall({ url, why }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, why, ok: false, blocked: true, error: 'Not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url, why, ok: false, blocked: true, error: `Refused — only http/https are allowed (was "${parsed.protocol}").` };
  }
  if (await resolvesToPrivateIp(parsed.hostname)) {
    return { url, why, ok: false, blocked: true, error: 'Refused — this host resolves to a private/internal address.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'manual', // a redirect to a second host would skip the check above — surface it, don't follow it blindly
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    });
    if (res.status >= 300 && res.status < 400) {
      return { url, why, ok: false, status: res.status, error: `Redirects to ${res.headers.get('location') || '(unknown)'} — not followed; verify the real endpoint directly if that's where it actually lives.` };
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    const bodyPreview = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '…[truncated]' : text;
    let shapeHint = null;
    if (contentType.includes('json')) {
      try {
        const parsed_ = JSON.parse(text);
        shapeHint = Array.isArray(parsed_) ? `array[${parsed_.length}]` : (parsed_ && typeof parsed_ === 'object' ? Object.keys(parsed_) : typeof parsed_);
      } catch { /* not actually valid JSON despite the content-type — bodyPreview still shows the real text */ }
    }
    return { url, why, ok: res.ok, status: res.status, contentType, shapeHint, bodyPreview };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return { url, why, ok: false, error: timedOut ? 'Timed out.' : (err.message || 'Request failed.') };
  } finally {
    clearTimeout(timer);
  }
}

/** Verify up to MAX_URLS_PER_TURN flagged calls in parallel. */
export async function verifyExternalApiCalls(calls) {
  const capped = (Array.isArray(calls) ? calls : []).filter((c) => c?.url).slice(0, MAX_URLS_PER_TURN);
  return Promise.all(capped.map(verifyExternalApiCall));
}

/** Render the results as a prompt block the coder is handed as ground truth. */
export function formatApiCheckBlock(results) {
  if (!results.length) return '';
  const lines = results.map((r) => {
    if (r.blocked) return `- ${r.url}${r.why ? ` (${r.why})` : ''} — NOT CHECKED: ${r.error}`;
    if (!r.ok) return `- ${r.url}${r.why ? ` (${r.why})` : ''} — DOES NOT WORK: ${r.status ? `HTTP ${r.status}` : r.error}. Do not write code that calls this exact URL — find the real endpoint or ask the operator.`;
    return `- ${r.url}${r.why ? ` (${r.why})` : ''} — WORKS. HTTP ${r.status}, ${r.contentType || 'unknown content-type'}${r.shapeHint ? `, shape: ${JSON.stringify(r.shapeHint)}` : ''}. Real response sample:\n  ${r.bodyPreview?.replace(/\n/g, '\n  ') || '(empty body)'}`;
  });
  return `\n\nVERIFIED EXTERNAL APIS — these URLs were actually called just now; this is their REAL current behavior, not a recollection. Write code against what's shown here, not what you remember about this API:\n${lines.join('\n')}\n`;
}
