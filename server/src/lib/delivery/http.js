// Shared black-box probe used by delivery adapters' healthCheck(). One GET
// (or HEAD/POST), with optional status / body-includes / body-excludes
// assertions. Never throws — a network failure is just { ok: false }.
export async function probe(name, url, opts = {}) {
  const {
    method = 'GET',
    expect = [200],
    expectText = null,      // body MUST contain this
    expectNotText = null,   // body MUST NOT contain this (e.g. a WP fatal-error page)
    timeoutMs = 10000,
  } = opts;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'User-Agent': 'Morpheus-healthcheck' }, signal: ctrl.signal });
    const needBody = expectText || expectNotText;
    const body = needBody ? await res.text() : '';
    const statusOk = expect.includes(res.status);
    const textOk = !expectText || body.includes(expectText);
    const notTextOk = !expectNotText || !body.includes(expectNotText);
    const ok = statusOk && textOk && notTextOk;
    const why = !statusOk ? '' : !textOk ? ' (missing expected text)' : !notTextOk ? ' (error text present)' : '';
    return { name, ok, detail: `${method} ${url} → ${res.status}${why}` };
  } catch (err) {
    return { name, ok: false, detail: `${method} ${url} → ${err.name === 'AbortError' ? 'timed out' : err.message}` };
  } finally {
    clearTimeout(t);
  }
}
