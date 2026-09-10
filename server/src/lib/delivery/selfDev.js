// The 'self-dev' delivery adapter — how a self-dev change reaches
// production: push to a `self-dev/<ts>` branch → PR → auto-merge on green →
// Northflank + Netlify deploy from `main` → post-deploy smoke check →
// tree-revert to roll back.
//
// Today this file owns the post-deploy health check (moved here from
// smokeCheckSelfDev.js so the engine has one place to call). verify / ship
// / merge / rollback still live in server/src/functions/*SelfDev*.js and
// are delegated to there; they move here in the shared-engine extraction.
import { SELF_DEV_REPO_FULL_NAME, SELF_DEV_BRANCH } from '../selfDevRepo.js';

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

export const selfDevDelivery = {
  id: 'self-dev',
  label: 'Self-dev → Northflank + Netlify',

  describe() {
    return {
      id: 'self-dev',
      label: this.label,
      repo: SELF_DEV_REPO_FULL_NAME,
      branch: SELF_DEV_BRANCH,
      previewKind: 'netlify-deploy-preview',   // per-PR, on Rob's Netlify
      shipKind: 'pr-auto-merge',               // pushSelfDevToGithub → mergeSelfDevPr
      deployKind: 'northflank-auto',            // Northflank deploys main on push
      rollbackKind: 'tree-revert',             // github.js revertCommit
      supports: ['verify', 'ship', 'merge', 'healthCheck', 'rollback'],
    };
  },

  // Black-box probe of the just-deployed production URLs. A failure feeds
  // the same auto-diagnose flow a failed deploy does.
  async healthCheck() {
    const apiBase = stripSlash(process.env.BACKEND_PUBLIC_URL) || 'https://api.morpheus.nz';
    const frontendBase = stripSlash((process.env.CORS_ORIGIN || '').split(',')[0].trim()) || 'https://morpheus.nz';

    const checks = await Promise.all([
      probe('api health', `${apiBase}/api/health`, { expectText: 'morpheus-server' }),
      probe('api auth guard', `${apiBase}/api/auth/me`, { expect: [401] }),
      probe('api functions', `${apiBase}/api/functions/browseTemplates`, { method: 'POST', expect: [200] }),
      probe('frontend', `${frontendBase}/`, { expectText: 'id="root"' }),
    ]);

    return {
      ok: checks.every((c) => c.ok),
      checks,
      failing: checks.filter((c) => !c.ok).map((c) => c.name),
      apiBase,
      frontendBase,
    };
  },
};
