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
// an esbuild import. verify.js imports `coverageError`; the WordPress delivery
// adapter imports `coverageVerdict`, because for a tenant's PHP theme a clean pass
// over zero read files has to read as "not verified" rather than "failed".
// scripts/verify-verifier-coverage.mjs asserts both.

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

/**
 * The verdict to REPORT, not just an error to append.
 *
 * WHY THIS IS SEPARATE FROM coverageError. `verify.js` folds the coverage problem
 * into its error list, which is right for a repo whose verifier is expected to
 * read everything. A target whose normal change is in a language this backend
 * cannot check (a WordPress theme's PHP, an Arduino sketch, a .NET project) must
 * not be told "failed" — that is a gate that cries wolf, and a gate that cries
 * wolf gets switched off. It must be told "not verified", which is a third state:
 * not a pass, not a failure, and never silently either.
 *
 * `code` follows the repo's convention for a verifier's exit/report status
 * (verify.mjs, scripts/check-settings.mjs, scripts/verify-schema-prod.mjs):
 *   0 = passed · 1 = failed · 2 = not verified (`code === 2` is NEVER a pass)
 *
 * @param {{errors?: Array, codeFiles?: number, files?: number}} [input]
 * @returns {{ok: boolean, verified: boolean,
 *            status: 'passed'|'failed'|'not_verified', code: 0|1|2,
 *            coverage: {phase: string, file: null, line: null, text: string} | null}}
 */
export function coverageVerdict({ errors = [], codeFiles = 0, files = 0 } = {}) {
  // Coverage is decided FIRST. An error list that is empty because nothing was
  // read is not a clean bill of health, and one that is non-empty is not "failed
  // the check" either — the check never ran.
  const coverage = coverageError({ codeFiles, files });
  if (coverage) return { ok: false, verified: false, status: 'not_verified', code: 2, coverage };
  if ((Array.isArray(errors) ? errors : []).length > 0) {
    return { ok: false, verified: true, status: 'failed', code: 1, coverage: null };
  }
  return { ok: true, verified: true, status: 'passed', code: 0, coverage: null };
}
