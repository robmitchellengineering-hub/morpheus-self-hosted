// Post-deploy smoke check (self-dev v2, gap A4.1).
//
// verifySelfDev catches syntax + import/export breakage before a push;
// the deploy watcher catches a *failed* Northflank build/deploy. Neither
// catches "the deploy went green but the change broke a live endpoint" —
// e.g. the chat route now 500s, or the frontend bundle 404s. This hits the
// real, just-deployed production URLs black-box and reports which critical
// paths still respond. SelfDev.jsx runs it once when the deploy watcher
// flips to 'deployed'; a failure feeds the same auto-diagnose flow a failed
// deploy does.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';

const stripSlash = (u) => (u || '').replace(/\/+$/, '');

async function probe(name, url, { method = 'GET', expect = [200], expectText = null, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'User-Agent': 'Morpheus-smoke' }, signal: ctrl.signal });
    const body = expectText ? await res.text() : '';
    const statusOk = expect.includes(res.status);
    const textOk = !expectText || body.includes(expectText);
    return { name, ok: statusOk && textOk, detail: `${method} ${url} → ${res.status}${!textOk ? ' (body check failed)' : ''}` };
  } catch (err) {
    return { name, ok: false, detail: `${method} ${url} → ${err.name === 'AbortError' ? 'timed out' : err.message}` };
  } finally {
    clearTimeout(t);
  }
}

export async function runSmokeCheckSelfDev(user) {
  const apiBase = stripSlash(process.env.BACKEND_PUBLIC_URL) || 'https://api.morpheus.nz';
  const frontendBase = stripSlash((process.env.CORS_ORIGIN || '').split(',')[0].trim()) || 'https://morpheus.nz';

  const checks = await Promise.all([
    // API is up and is the Morpheus server (not a stale/other process).
    probe('api health', `${apiBase}/api/health`, { expectText: 'morpheus-server' }),
    // Auth middleware is alive — an unauthenticated call must be a clean 401,
    // not a 500 (route threw) or 502 (process down).
    probe('api auth guard', `${apiBase}/api/auth/me`, { expect: [401] }),
    // A public function endpoint still routes and runs (dispatcher + DB).
    probe('api functions', `${apiBase}/api/functions/browseTemplates`, { method: 'POST', expect: [200] }),
    // Frontend bundle is served and is the app shell.
    probe('frontend', `${frontendBase}/`, { expectText: 'id="root"' }),
  ]);

  const ok = checks.every((c) => c.ok);
  const failing = checks.filter((c) => !c.ok).map((c) => c.name);

  try {
    const project = await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });
    if (project) await logUsage(user.id, 'self_dev_smoke', project.id, project.name, { ok, failing });
  } catch { /* logging is best-effort */ }

  return { ok, checks, failing, apiBase, frontendBase };
}

export default async function handler({ user }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runSmokeCheckSelfDev(user);
}
