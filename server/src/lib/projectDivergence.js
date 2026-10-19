// Is the construct (a project's ProjectFile rows) still the same tree as its
// linked GitHub repo — or did something edit the repo directly since the last
// sync?
//
// WHY THIS EXISTS. compileProject.js pushes the construct to GitHub one way
// before every build, trusting the database as truth. Anything that edited the
// repo directly — a manual push from another tool, a human, a session that
// fixed the generated app on the repo side — is silently overwritten by the next
// compile. syncProjectFromGithub.js is the missing PULL half; this module is the
// DETECTION half, so the fix loop can warn before it spends on a construct whose
// edits the next compile is about to discard. See KNOWN-HAZARDS.md H9 (the
// self-dev sibling of this same architecture gap) and H17 (a check that cannot
// answer must say so rather than read as a clean bill).
//
// Content, not timestamps: GitHub's tree API gives no reliable per-file mtime,
// and two copies of a file written a second apart are not "divergent" if their
// bytes match. The comparison is git's own blob object id — the same `sha` the
// GitHub tree reports and the same hasher lib/selfDevRepo.js already uses — so
// the two halves can never disagree about what "identical" means.
//
// PURE. No network, no model, no database, no package imports (only the relative
// import of selfDevRepo.js, which itself imports nothing but node:crypto). The
// half that talks to GitHub lives in lib/repoDivergence.js, so this file is
// testable with fixture file lists.
import { gitBlobSha, shouldExclude } from './selfDevRepo.js';

export const DIVERGENCE_STATES = ['in-sync', 'repo-ahead', 'construct-ahead', 'both', 'unknown'];

// Every value `reason` can carry when state is 'unknown'. A stable slug rather
// than prose, so a caller can log or branch on it, and a guard can pin it.
export const UNKNOWN_DIVERGENCE_REASONS = [
  'unusable-input',      // a file list is missing, not an array, or an entry has no path
  'no-linked-repo',      // the project has no Project.github_repo
  'no-token',            // GitHub is not connected (or the stored token will not decrypt)
  'github-api-error',    // the repo/tree/blob request failed, or the response was unreadable
  'tree-truncated',      // GitHub returned a PARTIAL tree (>~100k entries); we cannot see it all
  'blob-fetch-failed',   // a blob we needed in order to compare content could not be read
];

// The real button label, kept as one constant so the warning text and the UI
// cannot drift. scripts/verify-project-divergence.mjs asserts this string still
// appears verbatim in src/components/matrix/ShareDialog.jsx.
export const SYNC_ACTION_LABEL = 'Sync from GitHub (pull in edits made directly on the repo)';
export const SYNC_ACTION = `Share → "${SYNC_ACTION_LABEL}"`;

/**
 * Paths Morpheus itself generates on the repo side and never mirrors as a
 * ProjectFile row, so a divergence report full of them would be noise with no
 * fix:
 *   - the rendered GitHub Actions workflow, which compileProject writes into its
 *     own push and regenerates on every compile;
 *   - the `_compiled/*` artifacts, which saveCompiledArtifacts writes locally.
 * Everything else Morpheus owns (base44/, lockfiles, node_modules, binaries) is
 * already handled by selfDevRepo.shouldExclude.
 */
export function isMorpheusGeneratedPath(path) {
  const p = String(path ?? '');
  if (!p) return false;
  if (p.startsWith('_compiled/')) return true;
  if (p === '.github/workflows/build.yml') return true;
  return false;
}

/** Should this path take part in the divergence comparison at all? */
export function shouldComparePath(path) {
  if (typeof path !== 'string' || !path) return false;
  return !shouldExclude(path) && !isMorpheusGeneratedPath(path);
}

/** The shape returned when we cannot answer. `ahead`/`behind` are empty — we claim nothing. */
export function unknownDivergence(reason) {
  return { state: 'unknown', ahead: [], behind: [], reason: String(reason || 'unusable-input') };
}

/** A file list is usable only if every entry has a non-empty path string. */
function isFileList(files) {
  return Array.isArray(files)
    && files.every((f) => f && typeof f.path === 'string' && f.path.length > 0);
}

/** Comparand maps, filtered to the paths this check is allowed to judge. */
function comparableByPath(files) {
  const map = new Map();
  for (const f of files) {
    if (!shouldComparePath(f.path)) continue;
    map.set(f.path, f.content ?? '');
  }
  return map;
}

function reasonFor(state, ahead, behind) {
  switch (state) {
    case 'in-sync': return 'every compared file matches on both sides';
    case 'repo-ahead': return `the repo has ${ahead.length} file(s) the construct does not`;
    case 'construct-ahead': return `the construct has ${behind.length} file(s) the repo does not`;
    default: return `both sides moved: ${ahead.length} path(s) changed on the repo, ${behind.length} on the construct`;
  }
}

/**
 * Compare two file lists by CONTENT (git blob sha).
 *
 *   ahead  — paths the REPO has that the construct does not, by presence or by
 *            content. These are the files the next compile would overwrite.
 *   behind — paths the CONSTRUCT has that the repo does not. These are the files
 *            the next compile would push.
 *
 * A path whose content differs on both sides appears in BOTH lists: neither side
 * is a superset of the other, and calling it only one of them would under-report
 * real work.
 *
 * Returns `{ state, ahead, behind, reason }`. `state` is one of:
 *   'in-sync' | 'repo-ahead' | 'construct-ahead' | 'both' | 'unknown'.
 *
 * 'unknown' is a first-class answer, not an error: a missing file list (or a
 * malformed entry) means we do not know, and the caller must behave exactly as
 * it did before this check existed. Never claim divergence without evidence.
 */
export function assessDivergence({ repoFiles, constructFiles } = {}) {
  if (!isFileList(repoFiles) || !isFileList(constructFiles)) return unknownDivergence('unusable-input');

  const repo = comparableByPath(repoFiles);
  const construct = comparableByPath(constructFiles);

  const ahead = [];
  const behind = [];

  for (const path of [...repo.keys()].sort()) {
    if (!construct.has(path)) { ahead.push(path); continue; }
    if (gitBlobSha(repo.get(path)) !== gitBlobSha(construct.get(path))) {
      ahead.push(path);
      behind.push(path);
    }
  }
  for (const path of construct.keys()) {
    if (!repo.has(path)) behind.push(path);
  }
  ahead.sort();
  behind.sort();

  const state = ahead.length === 0 && behind.length === 0 ? 'in-sync'
    : ahead.length > 0 && behind.length > 0 ? 'both'
      : ahead.length > 0 ? 'repo-ahead'
        : 'construct-ahead';

  return { state, ahead, behind, reason: reasonFor(state, ahead, behind) };
}

/**
 * The one predicate the callers gate on. True exactly when the repo holds work
 * the construct does not — the state in which fixing files here costs credits on
 * an answer the next compile will discard. False for 'in-sync', for
 * 'construct-ahead' (the construct is simply newer; today's behaviour), and for
 * 'unknown' (we could not answer, so we change nothing).
 */
export function repoAhead(assessment) {
  return assessment?.state === 'repo-ahead' || assessment?.state === 'both';
}

/**
 * The fix loop's `needsUserAction` entry when the repo is ahead. Plain language,
 * the count, why the fix would not stick, and the exact action to take first.
 */
export function divergenceNeedsAction(count) {
  const n = Number(count) || 0;
  return {
    component: 'github',
    label: 'Direct edits on the repo',
    issue: `GitHub has ${n} file(s) the construct does not. Fixing files here would be overwritten by the next compile — sync first (${SYNC_ACTION}), then run the diagnosis again.`,
    steps: [
      `Open the construct and press ${SYNC_ACTION}`,
      'Then run the diagnosis again — the fixes will be based on the synced files.',
    ],
    severity: 'external',
  };
}

/**
 * The compile result's warning when the repo is ahead. It is a WARNING, not a
 * refusal: pressing COMPILE is the user's explicit instruction, so the push still
 * happens (whether it should become pull-then-push is a separate, undecided
 * question), but the overwrite is never silent.
 */
export function compileDivergenceWarning(count) {
  const n = Number(count) || 0;
  return `${n} file(s) changed directly on GitHub will be overwritten by this build's push. To keep those edits, run ${SYNC_ACTION} before compiling.`;
}
