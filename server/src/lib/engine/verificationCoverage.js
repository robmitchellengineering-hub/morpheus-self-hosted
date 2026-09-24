// Did the verifier actually look at anything?
//
// WHY THIS EXISTS
//
// `verifyProject` returned `ok: true, errorCount: 0, checkedFiles: 0` for the
// WikiData Batch Uploader — 37 files of Python, a `windows-exe` target. Every pass
// inside it had nothing to look at, because it reads only JS/TS, and the success
// condition is "no errors were found". Zero files examined produces zero errors,
// which is indistinguishable from a clean bill of health.
//
// That is hazard H17 with a new coat on: "nothing failed" is not "nothing to
// check". A pass from a check that examined nothing is not a pass, and it is the
// single most dangerous thing a verifier can say, because it is the one answer
// nobody goes back and questions.
//
// The decision lives here, pure and import-free, for the usual reason: the guards
// job installs nothing, so logic that has to be asserted in CI cannot live behind
// an esbuild import. verify.js imports this; scripts/verify-verifier-coverage.mjs
// asserts it.

/**
 * @param {{codeFiles?: number, files?: number}} counts
 *        `codeFiles` — files the verifier can actually read (JS/TS)
 *        `files`     — files present after the caller's exclude filter
 * @returns {{phase: string, file: null, line: null, text: string} | null}
 *          an error to add, or null when the verifier genuinely had something to do
 */
export function coverageError({ codeFiles = 0, files = 0 } = {}) {
  if (codeFiles > 0) return null;
  return {
    phase: 'coverage',
    file: null,
    line: null,
    text: files > 0
      ? `nothing was verified — ${files} file(s) present and none of them JS/TS, which is all this verifier reads. A pass from a check that examined nothing is not a pass.`
      : 'nothing was verified — there were no files to check at all. A pass from an empty check is not a pass.',
  };
}
