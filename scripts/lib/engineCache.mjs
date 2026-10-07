// May a restored neural-engine checkout be built against?
//
// WHY THIS DECISION IS SEPARATE FROM THE CLONE. `git clone` refuses a directory that exists — deliberately,
// and the refusal is right: a clone that reused whatever happened to be there would silently build the plugin
// against a revision nobody pinned, which is worse than the outage the cache exists to fix. But the engine's
// `Dependencies/eigen` submodule is hosted on GITLAB, which intermittently answers
//
//     remote error: GitLab is currently unable to handle this request due to load
//
// Two of the three audio-plugin runners (Windows and Linux ARM) died on exactly that on 2026-10-07; macOS got
// through; both failed runs passed when re-dispatched. The pin never changes, so every dispatch re-fetched a
// permanently-fixed commit over an unreliable host. The three workflows now restore $RUNNER_TEMP/namcore with
// `actions/cache` instead.
//
// ⚠️ AND A CACHE IS ONLY SAFE IF SOMETHING ANSWERS "IS THIS THE PINNED TREE?" BEFORE IT IS USED. Reusing a
// restored checkout on the assumption that a cache key was right would be exactly the silent-drift failure the
// clone's refusal prevents — the cache would have to be perfect forever, and a cache is not a proof. So the
// runner asks here, ONCE, before any build step runs, and this module answers with a reason.
//
//   reuse: true   the tree is what a clone of the pin would have produced; the target's clone step will skip it
//   reuse: false  clear it and let the clone run exactly as it always did — a cold cache costs time, never
//                 correctness, and the fallback can still reach GitLab
//
// The three runner scripts share this file so the pin, the submodule commit and the header path cannot drift
// between platforms: a verify-then-reuse copied three times is a cache that works on two runners.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// The pin, from the one module that owns it. Re-typing `0b3d3c9` here is how a cache outlives the pin it was
// keyed on — the one failure mode that is worse than a cold cache, because the build would be green.
import { NAMCORE_REF, NAMCORE_EIGEN_REF } from '../../server/src/lib/namPlugin.js';

/** NAMCore's gitlink for `Dependencies/eigen` at NAMCORE_REF, so a workflow key and this check name one value. */
export { NAMCORE_EIGEN_REF };

/** The file whose absence was the original `fatal error: 'Eigen/Dense' file not found`. */
export const EIGEN_HEADER = 'Dependencies/eigen/Eigen/Dense';

/**
 * Is `dir` a checkout of the pinned engine, eigen and all?
 *
 * BOTH HALVES ARE GIT FACTS, not an inference from the directory looking plausible. HEAD must be NAMCORE_REF,
 * and the eigen submodule must be checked out AT THE COMMIT NAMCORE'S OWN TREE PINS FOR IT — which is what a
 * `submodule update --init` produces, and which also means the header the engine includes is present. The
 * header is checked as well, on purpose: it is the specific file the outage surfaced, and a half-initialised
 * submodule whose HEAD happens to be right is not a tree anyone should compile.
 *
 * Every failure says WHY, so a run's log says whether the cache worked and what was wrong with it.
 */
export function engineCheckoutVerdict(dir) {
  if (!existsSync(join(dir, '.git'))) {
    return { reuse: false, reason: `${dir} is not a git checkout (no .git)` };
  }
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const commit = (head.stdout || '').trim();
  if (head.status !== 0 || !commit) {
    return { reuse: false, reason: `git could not read HEAD in ${dir}` };
  }
  // ⚠️ THE PIN IS A SHORT HASH AND HEAD IS FULL, so "equals" means HEAD STARTS WITH the pin. Comparing the
  // two strings directly would reject every cache hit — and that failure would look like a cache that never
  // works, which is how a correct guard gets "fixed" by loosening it.
  if (!commit.startsWith(NAMCORE_REF)) {
    return { reuse: false, reason: `HEAD is ${commit}, not the pinned ${NAMCORE_REF}` };
  }
  const eigen = join(dir, 'Dependencies', 'eigen');
  const eigenHead = spawnSync('git', ['-C', eigen, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const eigenCommit = (eigenHead.stdout || '').trim();
  if (eigenHead.status !== 0 || !eigenCommit) {
    return { reuse: false, reason: 'Dependencies/eigen is not an initialised submodule' };
  }
  if (eigenCommit !== NAMCORE_EIGEN_REF) {
    return { reuse: false, reason: `Dependencies/eigen is ${eigenCommit}, not the pinned ${NAMCORE_EIGEN_REF}` };
  }
  if (!existsSync(join(dir, EIGEN_HEADER))) {
    return { reuse: false, reason: `${EIGEN_HEADER} is missing` };
  }
  return { reuse: true, reason: `HEAD is ${NAMCORE_REF} and ${EIGEN_HEADER} is present` };
}
