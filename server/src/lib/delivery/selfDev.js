// The 'self-dev' delivery adapter — how a self-dev change reaches
// production: push to a `self-dev/<ts>` branch → PR → auto-merge on green →
// Northflank + Netlify deploy from `main` → post-deploy smoke check →
// tree-revert to roll back.
//
// Today this file owns the post-deploy health check (moved here from
// smokeCheckSelfDev.js so the engine has one place to call). verify / ship
// / merge / rollback still live in server/src/functions/*SelfDev*.js and
// are delegated to there; they move here in the shared-engine extraction.
import { SELF_DEV_REPO_FULL_NAME, SELF_DEV_BRANCH, shouldExclude } from '../selfDevRepo.js';
import { getGithubToken, revertCommit } from '../github.js';
import { verifyProject, DEFAULT_ENTRY_POINTS } from '../engine/verify.js';
import { mergePrWhenGreen } from '../engine/merge.js';

const stripSlash = (u) => (u || '').replace(/\/+$/, '');

// `base44/` is a real repo dir a few frontend files import from, but
// self-dev deliberately keeps it out of the workspace (shouldExclude), so
// esbuild can't resolve it during verify — mark those imports external
// rather than flag a false-positive "could not resolve".
const externalBase44 = {
  name: 'external-base44',
  setup(build) {
    build.onResolve({ filter: /(^|\/)base44\// }, (args) => ({ path: args.path, external: true }));
  },
};

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

  // Does the workspace parse, bundle from the real entry points, and keep
  // its cross-file exports intact? `files` is the whole workspace
  // ([{ path, content }]); the caller loads it.
  async verify({ files }) {
    return verifyProject(files, {
      exclude: shouldExclude,
      entryPoints: DEFAULT_ENTRY_POINTS,
      esbuildPlugins: [externalBase44],
    });
  },

  // Poll the self-dev PR's checks and squash-merge it once green. Returns
  // the engine's merge result; the caller handles self-dev's side effects
  // (chat note, usage log, manual regen, migration apply).
  async merge({ user, prNumber, force = false }) {
    const token = await getGithubToken(user.id);
    return mergePrWhenGreen(token, SELF_DEV_REPO_FULL_NAME, prNumber, {
      force,
      commitTitle: `Self-dev PR #${prNumber} (via Morpheus)`,
    });
  },

  // Point main at the tree from just before `commitSha`, as one new commit
  // (github.js revertCommit — refuses if the branch head has moved since).
  // Northflank + Netlify redeploy from it. The caller handles the chat
  // note, usage log, and KNOWN-HAZARDS.md stub.
  async rollback({ user, commitSha }) {
    const token = await getGithubToken(user.id);
    const r = await revertCommit(token, SELF_DEV_REPO_FULL_NAME, commitSha);
    return {
      commitSha: r.commitSha,
      revertedToSha: r.revertedToSha,
      branch: r.branch,
      commitUrl: `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${r.commitSha}`,
      repoFullName: SELF_DEV_REPO_FULL_NAME,
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
