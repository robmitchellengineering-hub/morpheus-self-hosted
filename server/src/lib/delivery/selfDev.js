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
import { shipChange } from '../engine/ship.js';
import { probe } from './http.js';

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

  // Diff the workspace against the self-dev repo and push the delta — to a
  // `self-dev/<ts>` branch + PR by default, or straight to main when
  // `directToMain` (force / hotfix). Returns the engine's ship result; the
  // caller handles self-dev's side effects (chat note, usage log, decision
  // stamp, manual regen, migration apply).
  //
  // `scopeExclude` (optional): an extra exclude predicate composed on top
  // of the always-applied shouldExclude — for a scoped build (e.g.
  // WIDGET_BUILD), enginePolicy.js's scopeExcludeFor() makes any path
  // outside the policy's own allow-list structurally invisible to this
  // push's diff/deletion computation, independent of the local
  // workspace's freshness (KNOWN-HAZARDS.md H9). Absent for Rob's own
  // unscoped pushes — zero behavior change there.
  async ship({ user, files, directToMain = false, precheck, scopeExclude }) {
    const token = await getGithubToken(user.id);
    return shipChange(token, SELF_DEV_REPO_FULL_NAME, {
      files,
      exclude: (path) => shouldExclude(path) || (scopeExclude ? scopeExclude(path) : false),
      baseBranch: SELF_DEV_BRANCH,
      branchPrefix: 'self-dev/',
      directToMain,
      label: 'Self-dev',
      prNote: 'Local esbuild verification passed before this PR was opened',
      precheck,
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
