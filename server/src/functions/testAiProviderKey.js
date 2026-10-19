// Settings -> AI Provider "Test connection" (both the Guided Free Setup
// flow and manual Custom mode). A user is about to paste a base URL + API
// key they may have mistyped or copied wrong; this gives them a pass/fail
// answer right there instead of a silent failure on their next real chat
// turn.
//
// Deliberately independent of ai.js's resolveEndpoint()/discoverLatestModel()
// — that function SHORT-CIRCUITS for a generativelanguage.googleapis.com
// base URL (returns the official 'gemini-flash-latest' alias without ever
// checking the key), which is the right call for its own job (cheap, no
// network round-trip on the hot path) but useless as a connectivity test.
// This always makes one real authenticated request.
export default async function handler({ body }) {
  const baseUrl = String(body?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(body?.apiKey || '').trim();
  if (!baseUrl || !apiKey) throw Object.assign(new Error('baseUrl and apiKey required'), { status: 400 });
  if (!/^https:\/\//i.test(baseUrl)) throw Object.assign(new Error('baseUrl must be https'), { status: 400 });

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try { message = JSON.parse(text)?.error?.message?.slice(0, 300) || message; } catch { /* not JSON, use raw text */ }
      return { ok: false, status: res.status, message: message || `The endpoint returned HTTP ${res.status}.` };
    }
    const data = await res.json().catch(() => null);
    const count = Array.isArray(data?.data) ? data.data.length : 0;
    return { ok: true, modelsFound: count };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || /timeout/i.test(err.message || '');
    return { ok: false, message: timedOut ? 'The endpoint took too long to respond.' : (err.message || 'Could not reach the endpoint.') };
  }
}
