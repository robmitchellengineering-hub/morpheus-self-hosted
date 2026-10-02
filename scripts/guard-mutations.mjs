// One honest sabotage per CLAIM: what breaks each guard's claim. A guard with several independent claims
// gets one mutation each — otherwise the second claim is unproven, which is the hole this file exists to
// close.
//
// WHY THIS EXISTS (hazard H19, and the afternoon of 2026-09-30 that proved it). This repo has 86 guards and
// **none of them proved it could fail**. Twice in one day that cost real time:
//
//   * `verify-usage-observability.mjs` REQUIRED a `resolvedModel` reference inside a catch where that name is
//     in its sibling try's temporal dead zone — so the guard demanded H18, which was replacing every provider
//     error in the product with a ReferenceError. A guard that pins a bug is worse than no guard.
//   * `verify-security-posture.mjs` asserted that the hardcoded-secret check fired for
//     `const K = "sk-live-…"` — a single-letter identifier, while the check keys on the *name* a value is
//     bound to. The assertion was right and the INPUT could never satisfy it, so **no mutation of the
//     subject would have found it**: break the check and the guard goes red for the wrong reason, leave it
//     and it passes. (That fixture was also the string that stopped the frontend deploying for half a day.)
//
// So: every claim below gets ONE mutation, in the file it actually reads, chosen so that the claim becomes
// false. `scripts/mutate-guards.mjs` applies it, runs the guard, and fails if the guard stays green.
// `scripts/verify-guard-mutations.mjs` keeps this registry honest in CI — completeness, no stale `find`, no
// two identical entries, and a ratchet so a new guard cannot arrive unproven.
//
// HOW TO ADD ONE. Pick the smallest edit that makes the claim false — rename a field, invert a condition,
// drop a case. Not a syntax error: a guard that dies on a missing file proves nothing. Keep the `find` long
// enough to occur EXACTLY ONCE in the file; the integrity guard fails a stale or ambiguous one.
//
// Import-free data, so both the runner and the CI guard can read it without an install.

export const MUTATIONS = [
  {
    guard: 'verify-security-posture.mjs',
    file: 'server/src/lib/securityPosture.js',
    why: 'Demotes a shipped .env from critical to a note — the guard\'s claim is that this is the finding which blocks a ship.',
    find: "    id: 'env-committed',\n    severity: 'critical',",
    replace: "    id: 'env-committed',\n    severity: 'note',",
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/lib/uiFeedback.js',
    why: 'Makes stripProse a no-op, so comments and string literals count as code — the exact prose-satisfies-the-check failure H19 records six times, and the property the whole conservative design rests on.',
    find: '  return cleaned;\n}',
    replace: '  return src;\n}',
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/lib/uiFeedback.js',
    why: 'Lets the checks run over every file again, so an Express server.js is examined as UI — how a real generated app got "unconfirmed delete" and "no progress" findings about a backend that has no screens.',
    find: '  const uiFiles = list.filter(isUiFile);',
    replace: '  const uiFiles = list;',
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/lib/uiFeedback.js',
    why: 'Tests JSX on the RAW source again, so HTML inside a string literal classifies a server file as UI — the real app\'s server.js (email HTML strings) and public/script.js (HTML template literals) were both examined this way.',
    find: '    const markup = stripProse(f.content);\n    return jsxTag.test(markup) || /\\bReact\\.createElement\\b/.test(markup);',
    replace: '    return jsxTag.test(f.content) || /\\bReact\\.createElement\\b/.test(f.content);',
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/lib/uiFeedback.js',
    why: 'Drops the API-receiver requirement, so a bare `.delete(` matches — a Map/Set/cache eviction becomes "your delete has no confirmation", the false finding measured on the real generated app.',
    find: "    if (!before.includes(';') && API_RECEIVER.test(before)) return true;",
    replace: '    if (true) return true;',
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/lib/uiFeedback.js',
    why: 'Stops recognising page chrome, so a nav/footer `.map(` is reported as a data list with no empty state — the other false finding measured on the real generated app.',
    find: '  return CHROME_WORD.test(receiver);',
    replace: '  return false;',
  },
  {
    guard: 'verify-ui-feedback.mjs',
    file: 'server/src/functions/chatWithMorpheus.js',
    why: 'Wires the report into control flow — an early return when there are findings — which is the enforcement the posture forbids and the shape a later "skip the build on findings" change would take.',
    find: '      const uiApp = isUiApp(projectFiles);\n      const findings = uiFeedbackFindings(projectFiles);',
    replace: '      const uiApp = isUiApp(projectFiles);\n      const findings = uiFeedbackFindings(projectFiles);\n      if (findings.length > 0) return;',
  },
  {
    guard: 'verify-export-promise.mjs',
    file: 'src/lib/exportPromise.js',
    why: 'Makes every verdict "ok", so an empty project reports itself runnable — the overclaim the module exists to prevent.',
    find: 'ok: blocking.length === 0 && parts.length > 0',
    replace: 'ok: true',
  },
  {
    guard: 'verify-client-env.mjs',
    file: 'netlify.toml',
    why: 'Drops a client variable from the secrets-scan omit list, so the list and the code disagree — the drift this guard exists to catch.',
    find: 'VITE_API_BASE_URL,',
    replace: '',
  },
  {
    guard: 'verify-no-secret-fixtures.mjs',
    file: 'scripts/verify-no-secret-fixtures.mjs',
    why: 'Blunts a detector so it can never fire. The guard\'s second section asserts its detectors still work precisely because a detector matching nothing passes section 1 for the wrong reason.',
    find: "{ name: 'Google OAuth client secret', re: /\\bGOCSPX-[A-Za-z0-9_-]{20,}/ },",
    replace: "{ name: 'Google OAuth client secret', re: /\\bNOMATCH-[A-Za-z0-9_-]{20,}/ },",
  },
  {
    guard: 'verify-review-budget.mjs',
    file: 'server/src/lib/reviewBudget.js',
    why: 'Raises the call ceiling to a number no allowance can exceed, which is the runaway review the budget was introduced to stop (12 calls / 473 credits).',
    find: '  maxCalls: 5,',
    replace: '  maxCalls: 99,',
  },
  {
    guard: 'verify-cloud-metering.mjs',
    file: 'server/src/lib/cloudMetering.js',
    why: 'Stops checking the gateway token\'s signature, so any token verifies. NOTE the first attempt at this entry renamed TOKEN_PREFIX and the guard correctly STAYED GREEN: the guard asserts `startsWith(TOKEN_PREFIX)` — the constant, not the literal — and nothing outside the module depends on `mgw_`, so that mutation broke no claim. A mutation must falsify a CLAIM, not merely change text, or it proves nothing about the guard.',
    find: "  const [payload, sig] = raw.slice(TOKEN_PREFIX.length).split('.');\n  if (!payload || !sig) return { ok: false, reason: REFUSALS.malformed };\n  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest());\n  if (!sameToken(sig, expected)) return { ok: false, reason: REFUSALS.signature };",
    replace: "  const [payload, sig] = raw.slice(TOKEN_PREFIX.length).split('.');\n  if (!payload || !sig) return { ok: false, reason: REFUSALS.malformed };\n  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest());\n  if (false) return { ok: false, reason: REFUSALS.signature };",
  },
  {
    guard: 'verify-generated-app.mjs',
    file: 'server/src/lib/generatedAppCheck.js',
    why: 'Renames the one dependency measured to be unbuildable, so a manifest declaring it reads as fine.',
    find: "'better-sqlite3': 'no prebuilt binary for this Node",
    replace: "'never-a-real-dep': 'no prebuilt binary for this Node",
  },
  {
    guard: 'verify-backend-chunk-context.mjs',
    file: 'server/src/lib/backendChunkContext.js',
    why: 'Raises the context ceiling past anything a probe can reach, so an over-limit context is no longer over the limit.',
    find: 'export const BACKEND_CONTEXT_MAX_BYTES = 60_000;',
    replace: 'export const BACKEND_CONTEXT_MAX_BYTES = 60_000_000;',
  },
  {
    guard: 'verify-incremental-persist.mjs',
    file: 'server/src/lib/incrementalPersist.js',
    why: 'Stops a delete from removing the file, so a stale backend path survives the write that was meant to clear it.',
    find: "    if (op.action === 'delete') { byPath.delete(normalizeBackendPath(op.path)); continue; }",
    replace: "    if (op.action === 'delete') { continue; }",
  },
  {
    guard: 'verify-delivery-posture.mjs',
    file: 'server/src/lib/infrastructureComponents.js',
    why: 'Points the cloud posture\'s auth at a self-hosted option, so the posture stops naming an account it really needs — the accounting the guard asserts.',
    find: "      auth: 'supabase-auth',",
    replace: "      auth: 'jwt-self',",
  },
  {
    guard: 'verify-registry-parity.mjs',
    file: 'base44/shared/infrastructureComponents.ts',
    why: 'Changes one value in the copy the frontend imports, so the two registries disagree — the drift that cost the posture feature its entire UI once.',
    find: "    id: 'container',",
    replace: "    id: 'container-x',",
  },
  {
    guard: 'verify-broker-minting.mjs',
    file: 'server/src/lib/brokerMinting.js',
    why: 'Lets a signed-in session mint for a different account, which is the one conditional standing between "the install serves its own operator" and "anyone can mint for anybody".',
    find: '    if (requested && requested !== session) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-build-gate-failopen.mjs',
    file: 'server/src/lib/reviewFailOpen.js',
    why: 'Returns no note when the review DID fail, so a failure reads as a pass — the exact inversion the fail-open contract forbids.',
    find: '  if (!failed) return null;',
    replace: '  if (failed) return null;',
  },
  {
    guard: 'verify-ai-roles.mjs',
    file: 'server/src/functions/chatWithMorpheus.js',
    why: 'Borrows the coder role for the file-shortlist pick — the exact misrouting already measured, where a reasoning model spent its budget thinking about a list of filenames. NOTE the first attempt at this entry mutated localRoleSettings.js and the guard correctly STAYED GREEN: verify-ai-roles reads chatWithMorpheus.js, not that file, so the mutation broke no claim of ITS.',
    find: "      // of filenames before answering.\n      role: 'classify',",
    replace: "      // of filenames before answering.\n      role: 'coder',",
  },
  {
    guard: 'verify-onramp.mjs',
    file: 'src/lib/onrampChecklist.js',
    why: 'Drops a step from the WordPress path, so the onboarding a non-technical visitor follows is no longer the one the guard checked.',
    find: "export const WORDPRESS_ROWS = ['site', 'copy'];",
    replace: "export const WORDPRESS_ROWS = ['site'];",
  },
  {
    guard: 'verify-google-reconnect.mjs',
    file: 'server/src/lib/googleReconnect.js',
    why: 'Removes the revoked-token reason, so the one failure that means "reconnect Google" stops being distinguishable from the others.',
    find: "export const GOOGLE_REFRESH_REASONS = ['revoked', 'not_configured', 'network'];",
    replace: "export const GOOGLE_REFRESH_REASONS = ['revoked', 'not_configured'];",
  },
  {
    guard: 'verify-billing-clamp.mjs',
    file: 'server/src/lib/billingClamp.js',
    why: 'Makes the take the LARGER of owed and available, so a charge can exceed the balance it is clamped against.',
    find: '  const take = Math.min(Math.max(0, owed), Math.max(0, available));',
    replace: '  const take = Math.max(Math.max(0, owed), Math.max(0, available));',
  },
  {
    guard: 'verify-deck-widget-build.mjs',
    file: 'server/src/lib/deckWidgetBuildState.js',
    why: 'Moves the staleness horizon ten times further out, so a build wedged for hours still reads as in progress.',
    find: 'export const STALE_BUILD_MS = 30 * 60 * 1000;',
    replace: 'export const STALE_BUILD_MS = 300 * 60 * 1000;',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    why: 'Renames a published build target to one that does not exist, so the surface search engines and AI answer engines read stops matching the compile targets that ship.',
    find: '"ios-app", "linux-binary", "linux-distro"',
    replace: '"ios-app", "linux-binary-x", "linux-distro"',
  },
  {
    guard: 'verify-bootstrap-sql.mjs',
    file: 'server/prisma/manual-supabase-init.sql',
    why: 'Removes a column the migrations add — exactly the drift that shipped: a fresh self-host came up missing seventeen columns and said nothing, because readers fall back to the pre-migration shape (H11).',
    find: 'ALTER TABLE project_files ADD COLUMN IF NOT EXISTS synced_sha TEXT;',
    replace: '',
  },
  {
    guard: 'verify-plan-reconciliation.mjs',
    file: 'server/src/lib/planReconciliation.js',
    why: 'Lets the rename pass accept TWO candidates, so it guesses which written file satisfies the plan. The guard exists to forbid exactly that: an eager reconciliation hides a real gap, which is the defect with the opposite sign.',
    find: '    if (ext && siblings === 1 && candidates.length === 1) {',
    replace: '    if (ext && siblings === 1 && candidates.length >= 1) {',
  },
  {
    guard: 'verify-applied-ops.mjs',
    file: 'server/src/lib/appliedOps.js',
    why: 'Puts a skip back into the allow-list, so an operation that wrote nothing counts as a change — the defect itself (a refused or skipped op reading as work in the UI, the log, the bill and a commit).',
    find: "export const APPLIED_ACTIONS = ['create', 'update', 'delete'];",
    replace: "export const APPLIED_ACTIONS = ['create', 'update', 'delete', 'skipped_no_content'];",
  },
  {
    guard: 'verify-app-selftest.mjs',
    file: 'server/src/lib/appSelfTest.js',
    why: 'Makes an unreadable result line report as "ok" — which is H17 in the one place it matters most: a self-test that printed nothing would read as a verified app on the machine of the person who installed it, where nobody is watching.',
    find: "  return { status: 'unknown', detail: `unreadable result line: ${last.slice(0, 80)}` };",
    replace: "  return { status: 'ok', detail: `unreadable result line: ${last.slice(0, 80)}` };",
  },
  {
    guard: 'verify-mac-app-arch.mjs',
    file: 'server/src/lib/compile-targets/mac-app.js',
    why: 'Puts the Python build back on macos-latest, which is the whole defect: PyInstaller compiles for the machine it runs on, so an Apple-silicon runner makes every macOS download arm64-only and an Intel Mac refuses it with "not supported on this Mac".',
    find: "    { runner: 'macos-15-intel', arch: 'intel' },",
    replace: "    { runner: 'macos-latest', arch: 'intel' },",
  },
  {
    guard: 'verify-user-manual.mjs',
    file: 'server/src/lib/appUserManual.js',
    why: 'Stops stripping the heredoc terminator out of the manual, so a project README containing that line ends the heredoc early and every line after it runs as shell in a workflow holding contents:write. This is the guard\'s only structural claim, and it is checked as an attack rather than as formatting.',
    find: "    .filter((line) => line.trim() !== delimiter)",
    replace: "    .filter(() => true)",
  },
  {
    guard: 'verify-build-failure-owner.mjs',
    file: 'server/src/lib/buildFailureOwner.js',
    why: 'Stops the classifier ever naming Morpheus as the owner, so the exact failure this change exists to catch — a Release step failing on the generated USER-MANUAL.txt — goes back to the AI fix path as an "app" failure: 40,365 input tokens, a 32,000-token call recorded `status: ok`, then OUTPUT_TRUNCATED and no diagnosis. The guard claims that failure is Morpheus-owned, so it must go red.',
    find: "    if (evidence) return buildResult('morpheus', signature.id, evidence);",
    replace: "    if (evidence) return buildResult('app', signature.id, evidence);",
  },
  {
    guard: 'verify-guard-mutations.mjs',
    file: 'scripts/guard-mutations.mjs',
    why: 'Raises this registry\'s own ratchet by one — precisely the edit that lets a new unproven guard through. The integrity guard exists to refuse that, so it must go red.',
    // The newlines are load-bearing: without them this text appears TWICE — in the declaration and inside
    // this very entry's own string. The ambiguity rule caught that on the first attempt, which is the rule
    // earning its place: `String.replace` takes the first match, so an ambiguous `find` can mutate the wrong
    // site, go red for the wrong reason, and be recorded as proof.
    find: '\nexport const UNPROVEN_BASELINE = 67;\n',
    replace: '\nexport const UNPROVEN_BASELINE = 68;\n',
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'server/src/lib/artifactSaveJob.js',
    why: 'Reports a save whose process is gone as still saving (dropping the staleness branch), so a backend restart mid-save leaves the panel polling forever and a dead job reads as progress — the exact lie the guard exists to prevent.',
    find: "  const phase = stale ? 'interrupted' : record.phase;",
    replace: '  const phase = record.phase;',
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'src/components/matrix/CompilePanel.jsx',
    why: 'Turns a save that failed into the BUILD FAILED heading — the 2026-10-02 incident verbatim: a build that succeeded reported as a failed build, on top of an app that already exists and is downloadable.',
    find: "BUILD SUCCEEDED — THE APP COULDN'T BE SAVED TO YOUR FILES",
    replace: "BUILD FAILED — THE APP COULDN'T BE SAVED TO YOUR FILES",
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'server/src/functions/saveCompiledArtifacts.js',
    why: 'Awaits the ~217 MB download/re-upload loop inside the request again, which is exactly the long HTTP request Cloudflare\'s ~100s proxy read timeout cut — the mechanical cause of the whole incident.',
    find: '  void runArtifactSave(record, plan, {',
    replace: '  await runArtifactSave(record, plan, {',
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'server/src/functions/getArtifactSaveStatus.js',
    why: 'Never retires a settled job record, so every project that ever compiles leaves a transient job row in platform_settings forever — the cleanup the guard claims exists.',
    find: "  if (record && response.phase !== 'saving'",
    replace: '  if (record && false',
  },
  {
    guard: 'verify-deck-play.mjs',
    file: 'src/pages/CommandDeck/game/playBank.js',
    why: 'Stops the bank spending what a game played, so play time is never used up — the arithmetic the whole reward rests on, and the one slip that hands out unlimited Asteroids.',
    find: '  return Math.max(0, creditedSeconds(credits) - playedSeconds(scores));',
    replace: '  return Math.max(0, creditedSeconds(credits));',
  },
];

/**
 * Guards a find/replace mutation CANNOT express, with the reason. Not an allowlist and not a home — the
 * visible part of the gap that a text edit genuinely cannot reach. The rest of the gap is covered by the
 * ratchet below, so this list does not have to name 70 guards to be honest.
 */
export const NOT_YET_PROVEN = [
  { guard: 'boot-smoke.mjs', why: 'needs server/node_modules, so it cannot run in the no-install guards job and a mutation could not be demonstrated there' },
  { guard: 'verify-context.mjs', why: 'asserts that every verify-*.mjs is registered in verify.mjs and ci.yml; falsifying it needs a new FILE, which the find/replace shape does not express' },
  { guard: 'verify-guards-no-install.mjs', why: 'reads the CI workflow and the guards\' real import graph; falsifying it needs a broken import, not a text edit' },
  { guard: 'verify-lint-coverage.mjs', why: 'walks eslint.config.js against the tree; falsifying it needs a new directory or a new file, not a text edit' },
  { guard: 'verify-server-imports.mjs', why: 'resolves the real import graph; a text edit that leaves the graph valid proves nothing about it' },
  { guard: 'verify-prisma-fields.mjs', why: 'reads prisma/schema.prisma and the query sites; the honest falsification is a removed field, which changes the schema\'s meaning rather than a line' },
];

/**
 * How many guards may be unproven. **This may only go DOWN.** Add a mutation and lower it by one.
 *
 * The rule it enforces is the one that matters: a NEW guard added without a mutation raises the unproven
 * count and turns CI red, so nobody can quietly add an unproven check again. Add the mutation with the
 * guard — which is the whole point — or raise this number in the same reviewable edit and say why.
 */
export const UNPROVEN_BASELINE = 67;
