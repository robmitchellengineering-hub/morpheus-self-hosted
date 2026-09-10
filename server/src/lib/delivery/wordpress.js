// The 'wordpress' delivery adapter — how a change reaches a WordPress site
// that has the Morpheus plugin installed. The first target is
// valiantmusic.com.au (see the "Self-Dev as a Plugin" scope doc, §8).
//
// Split of responsibility:
//   Morpheus side (this file)  — diff + push + PR (shipChange), auto-merge
//     (mergePrWhenGreen), and after the merge, call the plugin's deploy
//     webhook so the site pulls the new tree. Roll back = revert the repo,
//     then trigger a redeploy. Health check = probe the store's key pages.
//   Plugin side (PHP, separate) — receives the webhook, fetches the commit
//     tree via the GitHub API, writes the changed files to disk with PHP,
//     applies the hard path-exclude (wp-config.php / wp-content/uploads /
//     cache — enforced in plugin code, not .gitignore), runs its own
//     health check and auto-rolls-back on failure.
//
// This adapter is not auto-selected for any project yet — the plugin-api
// (next) resolves a tenant to { repo, branch, deployWebhookUrl,
// deploySecret, siteUrl } from their encrypted connection and passes it as
// `config`.
import crypto from 'node:crypto';
import { PLUGIN_DENY_PATHS } from '../enginePolicy.js';
import { checkSyntax } from '../syntaxCheck.js';
import { revertCommit } from '../github.js';
import { mergePrWhenGreen } from '../engine/merge.js';
import { shipChange } from '../engine/ship.js';
import { probe } from './http.js';

const stripSlash = (u) => (u || '').replace(/\/+$/, '');

// A change may not create/modify/delete any of these, regardless of the
// pushed tree — the same list enginePolicy enforces, applied here as the
// ship `exclude` so a denied path never even reaches a branch.
function isDenied(path) {
  return PLUGIN_DENY_PATHS.some((re) => re.test(path));
}

// Sign a webhook body the way the PHP plugin verifies it:
//   X-Morpheus-Signature: sha256=<hmac(secret, rawBody)>
export function signDeployBody(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function triggerDeploy(config, { commitSha, reason }) {
  if (!config?.deployWebhookUrl || !config?.deploySecret) {
    return { triggered: false, reason: 'no deploy webhook configured' };
  }
  const raw = JSON.stringify({ commit: commitSha, reason: reason || 'morpheus', at: new Date().toISOString() });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(config.deployWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Morpheus-Signature': signDeployBody(config.deploySecret, raw) },
      body: raw,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { triggered: res.ok, status: res.status, plugin: body };
  } catch (err) {
    return { triggered: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

export const wordpressDelivery = {
  id: 'wordpress',
  label: 'WordPress plugin (webhook deploy)',

  describe(config = {}) {
    return {
      id: 'wordpress',
      label: this.label,
      repo: config.repo || null,
      branch: config.branch || 'main',
      previewKind: 'none',              // the target IS the live site — CI gates stand in
      shipKind: 'pr-auto-merge',        // same as self-dev; deploy is downstream of merge
      deployKind: 'plugin-webhook',     // POST /wp-json/<ns>/v1/deploy → PHP writes files
      rollbackKind: 'repo-revert + redeploy',
      supports: ['verify', 'ship', 'merge', 'healthCheck', 'rollback'],
    };
  },

  // Morpheus's backend has no PHP, so PHP lint runs in CI. Here: JS syntax
  // over any changed script files (admin-panel JS, block editor code), and
  // that's it — no esbuild bundle pass (no JS entry point on a WP site).
  async verify({ files }) {
    const scripts = (files || []).filter((f) => /\.(jsx?|tsx?|mjs|cjs)$/.test(f.path) && !isDenied(f.path));
    const errors = (await checkSyntax(scripts.map((f) => ({ path: f.path, content: f.content ?? '' }))))
      .map((e) => ({ phase: 'syntax', file: e.file, line: e.line, column: e.column, text: e.text }));
    return {
      ok: errors.length === 0,
      errorCount: errors.length,
      errors: errors.slice(0, 50),
      checkedFiles: scripts.length,
      note: 'PHP lint and the theme build run in CI; the plugin health-checks the live site after it writes the files.',
    };
  },

  // Diff the change against the customer's repo and open a PR. The hard
  // path deny-list is applied as the exclude, so a denied path is never
  // pushed. Never direct-to-main for a plugin tenant.
  async ship({ token, config, files, precheck }) {
    return shipChange(token, config.repo, {
      files,
      exclude: isDenied,
      baseBranch: config.branch || 'main',
      branchPrefix: 'morpheus/',
      directToMain: false,
      label: 'Morpheus',
      prNote: 'Gates run in CI before this can merge; the site health-checks itself after deploy.',
      precheck,
    });
  },

  // Auto-merge on green, then tell the site to pull the new tree.
  async merge({ token, config, prNumber, force = false }) {
    const result = await mergePrWhenGreen(token, config.repo, prNumber, {
      force,
      commitTitle: `Morpheus PR #${prNumber}`,
    });
    if (result.merged && !result.alreadyMerged) {
      result.deploy = await triggerDeploy(config, { commitSha: result.mergeCommitSha, reason: `merge PR #${prNumber}` });
    }
    return result;
  },

  // Revert the repo to the state before `commitSha`, then trigger a
  // redeploy so the site rolls back too. (The plugin also auto-rolls-back
  // on its own failed health check — this is the operator-initiated path.)
  async rollback({ token, config, commitSha }) {
    const r = await revertCommit(token, config.repo, commitSha);
    const deploy = await triggerDeploy(config, { commitSha: r.commitSha, reason: `rollback ${commitSha.slice(0, 7)}` });
    return {
      commitSha: r.commitSha,
      revertedToSha: r.revertedToSha,
      branch: r.branch,
      commitUrl: `https://github.com/${config.repo}/commit/${r.commitSha}`,
      repoFullName: config.repo,
      deploy,
    };
  },

  // Probe the live store: homepage responds and isn't a WordPress fatal
  // error, the REST API is up, and any operator-listed key routes work.
  async healthCheck({ config }) {
    const base = stripSlash(config?.siteUrl || '');
    if (!base) return { ok: false, checks: [], failing: ['site url'], detail: 'no siteUrl configured' };

    const routes = Array.isArray(config.healthPaths) && config.healthPaths.length
      ? config.healthPaths
      : ['/', '/wp-json/'];

    const checks = await Promise.all([
      probe('homepage', `${base}/`, { expect: [200], expectNotText: 'There has been a critical error' }),
      probe('rest api', `${base}/wp-json/`, { expect: [200] }),
      ...routes
        .filter((p) => p !== '/' && p !== '/wp-json/')
        .map((p) => probe(`route ${p}`, `${base}${p}`, { expect: [200, 301, 302] })),
    ]);

    return {
      ok: checks.every((c) => c.ok),
      checks,
      failing: checks.filter((c) => !c.ok).map((c) => c.name),
      siteUrl: base,
    };
  },

  // Exposed for the merge-watcher / a manual "redeploy now" control.
  triggerDeploy,
};
