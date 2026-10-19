// The outcome of saving a compile release's artifacts — pure, no imports, so
// scripts/verify-compile-artifacts.mjs can assert it in CI's no-install guards
// job.
//
// WHY THIS EXISTS (2026-09-27)
//
// saveCompiledArtifacts.js accumulated per-asset failures in an `errors` array
// and then returned only `{ saved, files, artifacts }` — a partial save was
// indistinguishable from a complete one. CompilePanel.jsx tests only
// `saveResult?.error`, so for a glob target (rpi-distro / linux-distro release
// several assets: the image, the flasher, the READMEs) an `.img.gz` that failed
// while one small asset still saved produced "Build complete!" and handed the
// user a README with no image.
//
// The rule this encodes: a partial save keeps what DID land and reports what did
// not — it is never a hard error that discards the artifacts that saved. The
// honest all-saved path keeps its exact old shape, so every existing caller and
// the "Build complete!" copy are unchanged for a real success.

export function summarizeArtifactSave({ savedPaths = [], artifacts = [], failed = [], errors = [] } = {}) {
  const files = savedPaths.slice();
  const outcome = { saved: files.length, files, artifacts };

  // Every asset landed. Deliberately the same three keys as before this helper
  // existed — an all-saved build must be byte-identical to the old response.
  if (failed.length === 0) return outcome;

  // At least one asset did not land. Keep `files`/`artifacts` (the user keeps
  // what saved) and add the failures, named, so no caller can read this as
  // complete.
  return {
    ...outcome,
    partial: true,
    failed: failed.slice(),
    errors: errors.slice(),
  };
}
