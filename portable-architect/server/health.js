// Lightweight HTTP health probe for a deployed backend URL.
export async function checkHealth(url, { timeoutMs = 10000 } = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return { url, healthy: res.ok, statusCode: res.status, responseTimeMs: Date.now() - start, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { url, healthy: false, statusCode: 0, responseTimeMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}