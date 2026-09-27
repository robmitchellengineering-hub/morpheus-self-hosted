// The decisions behind "Take it live" — server/src/functions/deployFrontend.js.
//
// 2026-09-28, the owner: "it's always the customer's connection — we are just
// facilitating and aggregating and synthesizing data." The handler deploys a
// built web app into the user's OWN Netlify account with the user's OWN token;
// there is no Morpheus-owned account and no platform fallback token anywhere on
// that path. This module holds the three questions that decide whether a deploy
// may run at all, kept pure and free of imports so
// scripts/verify-frontend-deploy.mjs can exercise them for real (a source-only
// guard would pass on a handler that merely mentions the right words) while
// still running in CI's no-install guards job (scripts/verify-guards-no-install.mjs).
//
// The gap this closes: until now a web-app construct's end state was
// `_compiled/release.zip` plus DNS guidance, so Morpheus could build an app and
// could not host it.

// The deploy record, mirroring deployBackend.js's `backend/.deploy.json`
// convention. A project file rather than a new Prisma column or table: the
// artifact rows already carry what we need (path + file_url), and the record is
// read back to reuse the SAME Netlify site on every re-deploy.
export const FRONTEND_DEPLOY_PATH = 'frontend/.deploy.json';

/** Milliseconds since epoch for a Prisma Date / ISO string, or 0 when unknown. */
function time(value) {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

// The compiled frontend artifact's saved path.
//
// The web-app adapter names its release asset `web-app.zip` (artifactName in
// lib/compile-targets/web-app.js) and saveCompiledArtifacts.js stores it under
// `_compiled/<artifactName>`. `release.zip` is the workflow's own filename
// before that rename, kept as a candidate so an artifact saved by an older
// build still deploys instead of reading as "nothing compiled".
export function frontendArtifactCandidates(artifactName) {
  const names = [];
  if (artifactName) names.push(artifactName);
  for (const fallback of ['web-app.zip', 'release.zip']) {
    if (!names.includes(fallback)) names.push(fallback);
  }
  return names.map((n) => `_compiled/${n}`);
}

/**
 * The compiled frontend artifact for this project, newest first.
 *
 * Several `_compiled/` rows can exist at once (a glob target releases more than
 * one asset, and a rebuild replaces rows asynchronously), so the choice is by
 * `created_date` and never by list order: a re-deploy after a rebuild must
 * publish the build that was just made, not the previous one — that is H14's
 * "an artifact lookup keyed on the project rather than the build means every
 * recompile silently keeps serving the first build ever saved".
 *
 * Falls back to any `_compiled/*.zip` when neither candidate name is present,
 * so a rename does not turn into a confusing "nothing compiled yet".
 */
export function pickArtifact(rows, artifactName) {
  const candidates = frontendArtifactCandidates(artifactName);
  const byNewest = (a, b) => time(b?.created_date) - time(a?.created_date);
  const named = (rows || []).filter((r) => candidates.includes(r?.path)).sort(byNewest);
  if (named.length) return named[0];
  const zips = (rows || [])
    .filter((r) => typeof r?.path === 'string' && r.path.startsWith('_compiled/') && r.path.toLowerCase().endsWith('.zip'))
    .sort(byNewest);
  return zips[0] || null;
}

/**
 * Does this project file count as frontend SOURCE for the staleness check?
 *
 * Excluded, each for a reason that produced a false "stale" the moment it was
 * not: the compiled artifacts themselves (they are the build); `backend/`
 * (a backend edit does not rebuild the frontend, and the backend has its own
 * deploy); and the `.deploy.json` / `.plan.json` bookkeeping rows, which are
 * WRITTEN BY A DEPLOY — without this, the first successful deploy would mark
 * the artifact stale by writing its own record and every re-deploy would be
 * refused.
 */
export function isFrontendSourcePath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.startsWith('_compiled/')) return false;
  if (path.startsWith('backend/')) return false;
  if (path.endsWith('.deploy.json') || path.endsWith('.plan.json')) return false;
  return true;
}

/** The most recent edit to any frontend source file, as epoch ms (0 when none). */
export function newestFrontendSourceTime(rows) {
  let newest = 0;
  for (const row of rows || []) {
    if (!isFrontendSourcePath(row?.path)) continue;
    const t = time(row.updated_date ?? row.created_date);
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * Is the compiled artifact older than the source it was built from?
 *
 * A build time we cannot read is NOT treated as stale: the honest failure here
 * is publishing a slightly old build, and the dishonest one is refusing a good
 * deploy because a timestamp was missing.
 */
export function isArtifactStale(artifact, rows) {
  const built = time(artifact?.updated_date ?? artifact?.created_date);
  if (!built) return false;
  return newestFrontendSourceTime(rows) > built;
}

/**
 * Does this construct have backend source? Then hosting the frontend alone
 * would publish a site pointing at an API that does not exist, so the handler
 * says so and points at the backend deploy instead.
 *
 * Only real source counts: `backend/.plan.json` (the planner's note) and
 * `backend/.deploy.json` (the deploy record) can both exist with no backend
 * code, and deployBackend.js itself draws the line in exactly this place.
 */
export function hasBackendSource(rows) {
  return (rows || []).some(
    (r) => typeof r?.path === 'string'
      && r.path.startsWith('backend/')
      && r.path !== 'backend/.plan.json'
      && r.path !== 'backend/.deploy.json',
  );
}

/**
 * Has the backend actually gone live? Reads the same two signals
 * checkDeployHealth.js trusts, in the same order: a deployed component in
 * `backend/.deploy.json`, or a configured custom domain on BackendConfig
 * (checked by the caller, which owns the database). A malformed stored blob is
 * false, never a throw — it must not take the frontend path down.
 */
export function backendIsLive(deployJsonContent) {
  if (!deployJsonContent) return false;
  let info = null;
  try { info = JSON.parse(deployJsonContent); } catch { return false; }
  const results = Array.isArray(info?.results) ? info.results : [];
  return results.some((r) => r?.status === 'deployed' && r?.url);
}
