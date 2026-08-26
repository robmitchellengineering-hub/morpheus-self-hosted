// Shared health check logic for deployed backends.
// Pings a deployed URL and returns whether it responds successfully.
// Used by checkDeployHealth backend function and can be imported by deployBackend
// for post-deploy verification.

export interface HealthCheckResult {
  healthy: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
  attempts: number;
}

/**
 * Pings a URL with a timeout and returns health status.
 * Retries up to `maxRetries` times with `retryDelayMs` between attempts.
 */
export async function checkHealth(
  url: string,
  options: { maxRetries?: number; retryDelayMs?: number; timeoutMs?: number } = {}
): Promise<HealthCheckResult> {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 5000;

  let lastError: string | null = null;
  let lastStatusCode: number | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json, text/plain, */*' },
      });
      clearTimeout(timeout);
      const responseTimeMs = Date.now() - start;
      lastStatusCode = res.status;

      // 2xx and 3xx are healthy; 4xx/5xx are not
      if (res.status < 400) {
        return { healthy: true, statusCode: res.status, responseTimeMs, error: null, attempts: attempt };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e: any) {
      clearTimeout(timeout);
      const responseTimeMs = Date.now() - start;
      lastError = e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : e.message;
      // Keep trying — the service may still be starting up
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  return { healthy: false, statusCode: lastStatusCode, responseTimeMs: null, error: lastError, attempts: maxRetries };
}

/**
 * Wraps an async deploy function with auto-retry logic.
 * If the deploy returns a result with status 'error', retries up to maxRetries times.
 * Returns the last result (success or final error).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  maxRetries: number = 2,
  retryDelayMs: number = 1500
): Promise<{ result: T; attempts: number; retried: boolean }> {
  let result: T;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    attempts = attempt;
    try {
      result = await fn();
      if (!shouldRetry(result) || attempt > maxRetries) {
        return { result, attempts, retried: attempt > 1 };
      }
    } catch (e) {
      result = { status: 'error', message: e.message, service: 'unknown' } as unknown as T;
      if (attempt > maxRetries) {
        return { result, attempts, retried: attempt > 1 };
      }
    }
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  return { result: result!, attempts, retried: attempts > 1 };
}