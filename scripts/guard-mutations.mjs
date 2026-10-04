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
    guard: 'verify-onramp.mjs',
    file: 'src/lib/compileTargets.js',
    // THE INVISIBLE-TARGET FAILURE, as a mutation. This is not hypothetical: the audio plugin route shipped
    // exactly like this — in the server registry, absent from the picker, unchoosable — and every other
    // guard stayed green, because a target that cannot be selected is only visible by comparing two lists.
    why: 'Removes the macOS audio plugin route from the picker, so a target the server can build cannot be chosen — the state the route actually shipped in.',
    find: "  { value: 'audio-plugin-macos', create: 'macOS audio plugin — VST3, AU or CLAP (build locally)', import: 'macOS audio plugin — VST3, AU or CLAP', bar: 'mac audio plugin' },\n",
    replace: '',
  },
  {
    guard: 'verify-onramp.mjs',
    file: 'src/lib/compileTargets.js',
    // The wording claim on its own: the route is still pickable, but a musician on Windows can no longer
    // tell it is not for them until after they have built it.
    why: 'Drops the platform from the audio plugin route\'s label, so a macOS-only plugin is advertised as though it were built for whatever machine the reader is on.',
    find: "create: 'macOS audio plugin — VST3, AU or CLAP (build locally)', import: 'macOS audio plugin — VST3, AU or CLAP', bar: 'mac audio plugin' },",
    replace: "create: 'Audio plugin (build locally)', import: 'Audio plugin', bar: 'audio plugin' },",
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
    guard: 'verify-deck-widget-build.mjs',
    file: 'src/lib/deckWidgetBuildCard.js',
    why: 'Makes a finished build card effectively permanent again — the exact state Rob reported ("we still have that failed widget in my settings"), where the only way out was an X that did not survive a cache clear.',
    find: 'export const TERMINAL_BUILD_VISIBLE_MS = 24 * 60 * 60 * 1000;',
    replace: 'export const TERMINAL_BUILD_VISIBLE_MS = 365 * 24 * 60 * 60 * 1000;',
  },
  {
    guard: 'verify-deck-widget-build.mjs',
    file: 'src/lib/deckWidgetBuildCard.js',
    why: 'Lets a stored dismissal hide a build that is still RUNNING, so pressing X on an old card could swallow live progress.',
    find: '  if (!isTerminalBuildStatus(build.status)) return true;',
    replace: '  if (!isTerminalBuildStatus(build.status)) return !(dismissedId && build.id && String(build.id) === String(dismissedId));',
  },
  {
    guard: 'verify-deck-widget-order.mjs',
    file: 'src/pages/CommandDeck/deckWidgetOrder.js',
    why: 'Un-pins brain dump, so anything can be moved above it again — the second half of what Rob reported.',
    find: "  return String(key || '') !== PINNED_WIDGET_KEY;",
    replace: '  return true;',
  },
  {
    guard: 'verify-deck-widget-order.mjs',
    file: 'src/pages/CommandDeck/deckWidgetOrder.js',
    why: 'Lets the pinned widget back into the list the swap operates on, so a widget below can trade places with it and the arrows can move brain dump off the top. NOTE: breaking the `canReorderWidget` refusal on its own does NOT change the behaviour — the pinned row is excluded from the swapped list as well, deliberately, so the two refusals are independent. This mutation attacks the one that decides.',
    find: '  const movable = ordered.filter((w) => w.widget_key !== PINNED_WIDGET_KEY);',
    replace: '  const movable = ordered.filter((w) => w.widget_key !== "__never_matches__");',
  },
  {
    guard: 'verify-deck-widget-order.mjs',
    file: 'src/pages/CommandDeck/DeckSettings.jsx',
    // THE ACTUAL OUTAGE, as a mutation. This is precisely what shipped in #502: the call is present
    // and correct, and the name is simply not imported — `ReferenceError` in production, on a page
    // that then renders nothing, with every other gate green.
    why: 'Removes the imported name while leaving the call in place — the exact shape of the production break (#502): a correct call to a function that was never imported, which no other gate resolves.',
    find: "import { canReorderWidget, orderDeckWidgets } from './deckWidgetOrder';",
    replace: "import { canReorderWidget } from './deckWidgetOrder';",
  },
  {
    guard: 'verify-lint-coverage.mjs',
    file: 'eslint.config.js',
    // The root cause, as a mutation: the frontend block stops re-spreading the recommended rules, so
    // `no-undef` silently stops applying to all of src/** while every file still "matches a block".
    why: 'Drops the recommended-rules re-spread from the frontend block, which is how src/** silently lost no-undef (and every other eslint-recommended rule) to the React config spread that replaced it.',
    find: '      ...pluginJs.configs.recommended.rules,\n      "no-unused-vars": "off",',
    replace: '      "no-unused-vars": "off",',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-macos.js',
    // THE COLLAPSED-SCRIPT BUG. A literal backslash-n instead of a newline turns the whole verification
    // shell script into ONE LINE carrying escape sequences — so the check that exists to catch an empty
    // plugin bundle cannot run at all, which is worse than not having it.
    why: 'Turns the verification script into one line of escape sequences, so the check that catches an empty plugin bundle cannot run.',
    find: "        ].join('\\n'),\n      },\n\n      {\n        name: 'Package',",
    replace: "        ].join('\\\\n'),\n      },\n\n      {\n        name: 'Package',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginProject.js',
    // A moving ref is the quiet one: the build keeps working, and two people building the same project
    // on different days get different binaries from a dependency they did not choose and cannot see.
    // (Repointed when the pin moved into the shared module the two audio routes generate from.)
    why: 'Un-pins the plugin wrappers from a fixed commit to a branch, so the same project builds differently over time and an upstream force-push changes what a user ships.',
    find: "const CLAP_WRAPPER_REF = '1cca996e96f29ab2be7ae9f8cfe532bbc92e1dd6';",
    replace: "const CLAP_WRAPPER_REF = 'main';",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-macos.js',
    // THE empty-bundle failure, as a mutation: the check degrades from "there is a Mach-O inside this
    // bundle" to "this directory exists", which is exactly the check that passed while a 4 KB VST3 shell
    // sat on disk where a 1.3 MB plugin should have been.
    why: 'Weakens the artifact check from the binary inside the bundle to the bundle directory, which is the check that would have passed on the empty .vst3 the spike actually produced.',
    find: "          '  test -f \"$bin\" || { echo \"BUNDLE HAS NO BINARY: $b\"; exit 1; }',",
    replace: '          `  test -d "$b" || { echo "no bundle"; exit 1; }`,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // Without this the standalone's Objective-C++ shell cannot be generated and configuration fails with
    // an error naming CMake rather than the missing language.
    why: 'Drops the Objective-C++ language from the generated CMakeLists, so the standalone target cannot be configured and the failure names CMake instead of the missing language.',
    find: '  enable_language(OBJCXX)\n',
    replace: '',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginProject.js',
    // Regenerating over somebody's DSP is the worst thing this target could do, so the guard asserts it
    // cannot happen. This mutation makes the scaffold overwrite whatever is already there.
    // (Repointed when the scaffold moved into the shared module the two audio routes generate from — and
    // the indentation with it: it is a top-level function there, not a method on the target object.)
    why: 'Lets the scaffold overwrite files that already exist, so compiling a project Morpheus generated earlier would silently replace the edits the user made to their own plugin.',
    find: '    if (hasFile(out, path)) return;\n',
    replace: '',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-macos-build.yml',
    // THE COST GATE, as a mutation. Nothing about the build stops working when this line appears — it just
    // starts running on every pull request, on a runner that bills at 10x, which is a bill rather than a
    // failure. That is exactly the kind of edit a guard has to catch, because nothing else would notice.
    why: 'Adds a pull_request trigger to the manual-only audio-plugin build, so a macOS bill at 10x starts on every branch instead of when someone dispatches it.',
    find: 'on:\n  workflow_dispatch:',
    replace: 'on:\n  pull_request:\n  workflow_dispatch:',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-macos-build.yml',
    // The run would still be green while shipping three formats of four: the standalone is the one format no
    // local machine has ever built, so a missing zip has to fail the job rather than quietly not be there.
    why: 'Drops the failure-on-missing-artifact setting, so a run that produced no standalone still uploads three plugins and passes.',
    find: '          if-no-files-found: error\n',
    replace: '',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-macos-runner-build.mjs',
    // THE DRIFT FAILURE, as a mutation: a transcribed command keeps the runner green after the target has
    // moved on, so the job proves a build nobody ships. The claim is that the commands come from the target.
    why: 'Replaces the target\'s own step with a hand-written command, so the runner build can drift from what the target generates and still pass.',
    find: "['-c', step.run]",
    replace: "['-c', 'cmake --build build --target morpheus_plugin_clap -j4']",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-windows.js',
    // ⭐ THE ANTI-DRIFT CLAIM, and the reason the generator is shared rather than copied. Both routes must
    // generate the same project; the moment one of them adds a file of its own, that route is building a
    // plugin the other route's evidence does not cover — and both guards still pass.
    why: 'Gives the Windows route a scaffold that generates one extra file, so the two routes stop building the same plugin while every other check stays green.',
    find: '  validate: validatePlugin,\n  scaffold: scaffoldPlugin,',
    replace: "  validate: validatePlugin,\n  scaffold: (files) => { const r = scaffoldPlugin(files); return { ...r, files: [...r.files, { path: 'Source/WindowsOnly.cpp', content: '// windows only\\n' }] }; },",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-windows.js',
    // THE LAYOUT THE GENERATOR OWNS. Run four looked for `<dir>/<name>.vst3` and found nothing, because the
    // Visual Studio generator is multi-config and appends `Release/`. Widen the search to the whole assets
    // directory and the check is no longer looking where the artifacts are expected.
    why: 'Points the Windows verification at the whole assets directory instead of each format\'s own folder, so it checks somewhere the artifacts are not expected.',
    find: 'const clapDir = `${WINDOWS_ASSETS}/CLAP`;',
    replace: 'const clapDir = `${WINDOWS_ASSETS}`;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-windows.js',
    // Trusting the file extension is how a 0-byte or wrongly-linked artifact passes. The MZ/PE read is the
    // whole content of the claim that this is a plugin binary rather than a file with the right name.
    why: 'Stops reading the PE signature, so any file with the right extension satisfies the verification.',
    find: 'if ($br.ReadUInt16() -ne 0x5A4D) { return $false }   # MZ',
    replace: 'if ($false) { return $false }   # MZ',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-windows.js',
    // The platform in the words a user reads, on the half of the pair where a VST3 is a format the reader's
    // own machine might also take — so the label is the only thing telling them which route is theirs.
    why: 'Removes the platform from the Windows route\'s label, so a Windows-only plugin is advertised as a plugin for whatever machine the user is on.',
    find: "  label: 'Audio Plugin — Windows (VST3 · CLAP)',",
    replace: "  label: 'Audio Plugin (VST3 · CLAP)',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-windows-build.yml',
    // The cost gate on the other OS — 2x rather than 10x, and still a bill rather than a slow build.
    why: 'Adds a pull_request trigger to the manual-only Windows audio plugin build, so a Windows bill starts on every branch instead of when someone dispatches it.',
    find: 'on:\n  workflow_dispatch:',
    replace: 'on:\n  pull_request:\n  workflow_dispatch:',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-macos-runner-build.mjs',
    // The refusal that makes the job mean anything. Left in place with the condition defeated, the script
    // still prints its summary and exits 0 on a machine that produced three formats — which is exactly the
    // green run this job exists to make impossible. Note this is why the assertion is on the CONDITION and
    // the exit, not on the message text: a message-shaped check survived this very mutation.
    why: 'Defeats the standalone refusal, so a run that produced no standalone still reports success instead of failing.',
    find: 'if (!standalone) {',
    replace: 'if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-macos.js',
    // The label a user reads in the picker and the workspace. Dropping the OS is the whole product defect:
    // the route still builds macOS-only bundles, and now nothing says so until the downloads arrive.
    why: 'Removes the platform from the target\'s own label, so the route reads as a plugin for whatever machine the user is on.',
    find: "  label: 'Audio Plugin — macOS (VST3 · AU · CLAP)',",
    replace: "  label: 'Audio Plugin (VST3 · AU · CLAP)',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/appUserManual.js',
    // The manual is the last place a user finds out, and the first line is the one that has to be
    // unmissable — a Windows user reading three paragraphs down has already downloaded the wrong thing.
    why: 'Softens the manual\'s opening line so it no longer says the plugin is macOS only, which is the one fact a Windows user needs before downloading.',
    find: "      'THIS PLUGIN IS FOR MACOS ONLY. It will not load on Windows or Linux — there is no Audio Unit',",
    replace: "      'This plugin is for macOS. It will not load on Windows or Linux — there is no Audio Unit',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-linux-arm.js',
    // The CPU is as much of the answer as the OS is: an x86-64 Linux desktop and a Raspberry Pi are both
    // "Linux", and this route produces a plugin for exactly one of them. Dropping ARM from the label is how
    // someone downloads a plugin their machine cannot load and has nothing to point at.
    why: 'Removes the CPU from the Linux route\'s label, so a Pi build reads as a plugin for any Linux machine.',
    find: "  label: 'Audio Plugin — Linux ARM (VST3 · CLAP)',",
    replace: "  label: 'Audio Plugin — Linux (VST3 · CLAP)',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-linux-arm.js',
    // ⭐ THE ASSERTION THIS WHOLE ROUTE EXISTS FOR, removed the way it would really be removed: not deleted
    // loudly, but simplified until it always agrees — which is what a green build looks like when the
    // artefact was compiled for the wrong machine.
    why: 'Replaces the readelf architecture check with a constant, so a plugin built for the wrong CPU passes every assertion.',
    find: 'machine=$(readelf -h "$hit" | sed -n "s/^ *Machine: *//p")',
    replace: 'machine=AArch64',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-linux-arm.js',
    // The pipefail trap, reintroduced: `head` closes the pipe, `find` takes SIGPIPE, and `set -e` aborts a
    // search that found exactly what it was looking for. It looks like a missing artifact.
    why: 'Goes back to `find | head -n 1`, which trips pipefail on a successful search and reports a format that was built as missing.',
    find: 'find ${LINUX_ASSETS} -type f -name "$file" -print -quit',
    replace: 'find ${LINUX_ASSETS} -type f -name "$file" | head -n 1',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-linux-arm-build.yml',
    // An x86-64 runner would build a plugin for the wrong machine and every file-exists check would pass —
    // the single most likely way this route ships something that cannot load on the hardware it names.
    why: 'Points the Linux ARM build at an x86-64 runner, where it would produce a plugin no Raspberry Pi can load and still go green.',
    find: '    runs-on: ubuntu-24.04-arm',
    replace: '    runs-on: ubuntu-latest',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'AGENTS.md',
    // With one shared generator, a change to it invalidates all three routes' evidence at once. The one
    // place that says so is where a session reads it before dispatching.
    why: 'Drops the Linux ARM job from the list of workflows AGENTS.md says must all be dispatched after a shared change, so a shared edit leaves one route proven against code that no longer exists.',
    find: '.github/workflows/audio-plugin-linux-arm-build.yml',
    replace: '.github/workflows/audio-plugin-linux-build.yml',
  },
  {
    guard: 'verify-audio-measure.mjs',
    file: 'server/src/lib/audio/analysis.js',
    // THE CLASSIC WINDOWING BUG, as a mutation: dropping the window's coherent gain makes every amplitude read
    // low by exactly that factor (a Hann window halves it), so a -6 dBFS tone reports as -12. Nothing throws,
    // and every level in the report is wrong by a constant — which is the worst kind of wrong for a meter.
    why: 'Drops the coherent-gain correction from the amplitude spectrum, so every level the instrument reports is low by the window factor.',
    find: 'const scale = (k === 0 || k === half ? 1 : 2) / (n * gain);',
    replace: 'const scale = (k === 0 || k === half ? 1 : 2) / n;',
  },
  {
    guard: 'verify-nam-quantize.mjs',
    file: 'server/src/lib/audio/namModel.js',
    // THE BLOCKING CLAIM, as a mutation: stepping by the whole array means one scale covers everything, which is
    // the thing block scales exist to avoid — and it leaves every weight past the first block unquantized.
    why: 'Quantizes the whole weight array as a single block, so the per-block scales that make low bit widths usable stop existing.',
    find: '  for (let start = 0; start < values.length; start += blockSize) {',
    replace: '  for (let start = 0; start < values.length; start += values.length) {',
  },
  {
    guard: 'verify-nam-quantize.mjs',
    file: 'server/src/lib/audio/namModel.js',
    // A CONTAINER WITH NO SCALE IS NOT A MODEL. Dropping the scales leaves integers that cannot be turned back
    // into numbers, and the failure would surface as "the audio is wrong" rather than as a parse error.
    why: 'Drops the scales from the deployment container, leaving codes that cannot be dequantized.',
    find: '        scales: Array.from(q.scales),',
    replace: '        scales: undefined,',
  },
  {
    guard: 'verify-render-check.mjs',
    file: 'scripts/dev-app-render.mjs',
    // A SAFETY INTERLOCK, as a mutation — the class of edit a guard is really for. Nothing about the
    // render check stops working when this line goes; it simply stops refusing to seed an account into
    // a database that is not the rig's. That is the failure where everything downstream still looks
    // fine, which is why the removal has to be loud.
    why: 'Drops the loopback refusal from the render check, so it would seed an account onto whatever database host server/.env names rather than refusing anything that is not local.',
    find: "  if (!['localhost', '127.0.0.1', '::1'].includes(host)) fail(`refusing to run: database host \"${host}\" is not loopback.`);",
    replace: '',
  },
  {
    guard: 'verify-render-check.mjs',
    file: 'scripts/dev-app-render.mjs',
    // The silent-degradation mutation. Collecting 5xx responses and never using them is the shape this
    // check was in for its first hour: it listed the failures among "not fatal" while `/deck/settings`
    // rendered an empty state over a backend that was 500ing on every read.
    why: 'Stops an API 5xx from failing the render check, so a page that renders an empty state over a broken backend reads as a pass.',
    find: '        serverErrors.push(`${res.status()} ${url.replace(BASE, \'\').split(\'?\')[0]}`);',
    replace: '        void res.status();',
  },
  {
    guard: 'verify-deck-widget-order.mjs',
    file: 'src/pages/CommandDeck/deckWidgets.js',
    why: "Takes brain dump back out of the top of the registry, which is the position a brand-new account seeds its first widget from — the exact thing Rob saw on a new user's deck.",
    find: "  { key: 'brain_dump', label: 'Brain dump', defaultEnabled: true },\n",
    replace: '',
  },
  {
    guard: 'verify-deck-widget-order.mjs',
    file: 'src/pages/CommandDeck/DeckSettings.jsx',
    why: 'Disables the up arrow on row 1 again, which is a dead button for any account whose deck has no brain dump instance at row 0.',
    find: 'disabled={i === firstMovableIndex}',
    replace: 'disabled={i === 1}',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    why: 'Renames a published build target to one that does not exist, so the surface search engines and AI answer engines read stops matching the compile targets that ship.',
    find: '"ios-app", "linux-binary", "linux-distro"',
    replace: '"ios-app", "linux-binary-x", "linux-distro"',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    why: 'Renames the assistant to an unnamed one, which is the state the surface was actually in: every machine-readable file was generated from a capability list that never said "Jarvis", so an AI asked about the personal assistant could not answer.',
    find: '{ "title": "Jarvis — the personal assistant"',
    replace: '{ "title": "The personal assistant"',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    why: 'Changes the published widget count so the landing page and llms.txt quote a number the widget registry does not have — the "6 platforms" drift, one number smaller. (The count is read from src/pages/CommandDeck/deckWidgets.js, so a widget added without updating the copy fails the same check.)',
    find: 'with 15 widgets — the five life streams',
    replace: 'with 16 widgets — the five life streams',
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
    guard: 'verify-build-failure-owner.mjs',
    file: 'server/src/functions/diagnoseIssue.js',
    why: 'Removes the gate that keeps the ownership verdict behind the caller\'s own credential branch. With it gone, a credential failure whose logs also carry a Morpheus signature returns the Morpheus sentence and skips the credential action — the precedence the header claims and section 8 of the guard pins as an order the code executes, not a comment.',
    find: '  if (!isAuthError(error)) {\n    const ownership = classifyBuildFailure(',
    replace: '  if (true) {\n    const ownership = classifyBuildFailure(',
  },
  {
    guard: 'verify-guard-mutations.mjs',
    file: 'scripts/guard-mutations.mjs',
    why: 'Raises this registry\'s own ratchet by one — precisely the edit that lets a new unproven guard through. The integrity guard exists to refuse that, so it must go red.',
    // The newlines are load-bearing: without them this text appears TWICE — in the declaration and inside
    // this very entry's own string. The ambiguity rule caught that on the first attempt, which is the rule
    // earning its place: `String.replace` takes the first match, so an ambiguous `find` can mutate the wrong
    // site, go red for the wrong reason, and be recorded as proof.
    find: '\nexport const UNPROVEN_BASELINE = 65;\n',
    replace: '\nexport const UNPROVEN_BASELINE = 66;\n',
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
  {
    guard: 'verify-deck-play.mjs',
    file: 'src/pages/CommandDeck/game/Asteroids.jsx',
    why: 'Takes the radius back off the ship — which is THE bug Rob reported (2026-10-03: "when you fly off the screen you should apear on the othe side"). Without it the wrap compares a position against `undefined`, every comparison is NaN-false, and the ship flies away for ever while the asteroids keep wrapping correctly, so nothing looks broken until you fly off an edge.',
    find: 'r: SHIP_RADIUS, alive: true',
    replace: 'alive: true',
  },
  {
    guard: 'verify-deck-play.mjs',
    file: 'src/pages/CommandDeck/game/wrapAround.js',
    why: 'Makes the wrap a no-op, so leaving an edge is still leaving the game — the behaviour Rob asked for, removed, with the function still present and plausible. This is also the state the ship was unknowingly in for every object without a radius.',
    find: '  if (value >= -radius && value <= span + radius) return value;',
    replace: '  return value;',
  },
  {
    guard: 'verify-murbah-money.mjs',
    file: 'server/src/lib/murbahBooking.js',
    why: 'Drops the exclusive-end off-by-one, so a booking that ends on the 5th ends on the 5th in Calendar — every Murbah booking silently a day short, in the place Rob actually reads it.',
    find: '  d.setUTCDate(d.getUTCDate() + 1);',
    replace: '  d.setUTCDate(d.getUTCDate());',
  },
  {
    guard: 'verify-life-files.mjs',
    file: 'src/pages/CommandDeck/lifeFiles.js',
    why: 'Calls every attachment an image, so a scanned PDF renders as a broken <img> in the stream — the direction this deliberately errs away from.',
    find: "    is_image: type.startsWith('image/'),",
    replace: '    is_image: true,',
  },
  {
    guard: 'verify-jarvis-voice.mjs',
    file: 'src/hooks/useMorpheusVoice.js',
    why: 'Plays the butler voice at normal speed again — the 23%-slower delivery that made the old deck feel faster, and a change no test would otherwise notice. (2026-10-04: the assignment moved into `startAudio`, the ONE place both the whole-message path and the streamed one get their audio, so its indentation changed with it.)',
    find: '  audio.playbackRate = PLAYBACK_RATE;',
    replace: '  audio.playbackRate = 1;',
  },
  {
    guard: 'verify-jarvis-voice.mjs',
    file: 'server/src/lib/jarvisPersona.js',
    why: 'Softens the ribbing back to "it lands because they know you mean it" — the EXACT drift that happened before. Rob, 2026-10-03: "the bite is good when its with love"; the guard then pinned the wit but not the affection, so a Jarvis who is cutting without being kind could ship with every check green. This mutation is that history, made to fail on purpose.',
    find: 'because it comes from love',
    replace: 'because they know you mean it',
  },
  {
    guard: 'verify-jarvis-voice.mjs',
    file: 'server/src/lib/jarvisCareers.js',
    why: 'Drops "ninja" from the careers list. Rob gave a FIXED set of 36 (2026-10-03) and named it as the thing Jarvis draws on; a list is exactly what an edit trims without anyone noticing, and a single missing entry changes who he is rather than breaking anything visible. This is the one-entry version of that failure. (2026-10-04: retargeted from jarvisPersona.js to the register, which is now the only copy of the names.)',
    find: "'Brazilian jiu-jitsu instructor', 'ninja',",
    replace: "'Brazilian jiu-jitsu instructor',",
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/jarvisCareers.js',
    why: 'Turns the doctor\'s `check:` line into a note. That section is the one that stops a card asserting doses and interactions from memory — the facts most worth having and the ones a hand-written brief gets wrong within a year. Without it the card still reads perfectly well and is quietly more dangerous, which is why the section set is asserted rather than trusted.',
    find: 'check: doses, interactions and guidelines change',
    replace: 'note: doses, interactions and guidelines change',
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/deckSnapshotGate.js',
    why: 'Lets the selector trust a career name the register does not have. The classifier would then be able to put arbitrary text into the prompt through a field the persona interpolates — the register must be the only thing that decides what a career is called.',
    find: '    if (!CAREER_KEYS.includes(key)) continue;',
    replace: '    if (!key) continue;',
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/jarvisPersona.js',
    why: 'Replaces the exhaustion contract with permission to hand over — the reflex Rob asked him NOT to have (2026-10-04: "exhast all efforts and reseach if necessary first to get a resolution before off loading to a professional"). Nothing visible breaks: he still answers, still sounds like Jarvis, and just stops working the problem before referring it.',
    find: 'Exhaust a problem before you hand it to anyone.',
    replace: 'Answer briefly, and refer anything difficult to a professional.',
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/deckSnapshotGate.js',
    why: 'Removes the research cap, so the classifier can ask for an unbounded number of web searches before every reply — the latency the cap exists to bound, on the path the operator waits on.',
    find: '    if (queries.length >= MAX_RESEARCH_QUERIES) break;',
    replace: '    if (queries.length >= 99) break;',
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/jarvisCareers.js',
    why: 'Renames the ninja brief so one of the 36 has none. The persona still names the hat, so Jarvis still says "ninja hat:" and then has nothing to work from — the silent-shrink failure the coverage check exists for, now that every career is supposed to have a brief.',
    find: '  ninja: `NINJA',
    replace: '  ninjaaa: `NINJA',
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/webResearch.js',
    why: 'Puts the grounded-search failure back to silence. This is the exact production state measured 2026-10-04 — a healthy key, every grounded call 429, and research quietly answering from Wikipedia instead. An invisible outage of a capability Jarvis is told to rely on.',
    find: '        warnGroundedUnavailable(`HTTP ${res.status}${await errorDetail(res)}`);',
    replace: '        // failure swallowed again',
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/lib/searchResults.js',
    why: 'Stops filtering the adverts. Measured in production: the top TWO results for "2008 RAV4 idle squeal cause" were `duckduckgo.com/y.js?ad_domain=` ads ahead of the real answer, so without this the turn spends its page budget on a shop listing and hands Jarvis an advert as a source.',
    find: "  if (host === 'duckduckgo.com' && (path.startsWith('/y.js') || path.startsWith('/l/'))) return true;",
    replace: '  if (false) return true;',
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/lib/searchResults.js',
    why: 'Drops the official-source preference, so a mortgage broker\u2019s summary of the land tax threshold outranks the tax office\u2019s own page — which is the entire reason this search replaced grounding rather than merely being cheaper.',
    find: '    .sort((a, b) => (a.official - b.official) || (a.index - b.index))',
    replace: '    .sort((a, b) => a.index - b.index)',
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/lib/searchResults.js',
    why: 'Makes every cached entry count as fresh, so a rate or a deadline cached an hour ago is served as current. A static fact is fine stale; the facts this feature exists to look up are exactly the ones that are not.',
    find: '  return nowMs - at < ttlMs;',
    replace: '  return true;',
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/lib/webResearch.js',
    why: 'Puts the word back in the User-Agent — which is the EXACT production failure Rob found (2026-10-04). DuckDuckGo answers a self-described bot with `202 Accepted` and a challenge page, so search returns nothing; Jarvis falls through to Wikipedia and answered whether a dingo may be kept in NSW from memory, with the law backwards.',
    find: "const UA = 'MorpheusResearch/1.0 (+https://morpheus.nz)';",
    replace: "const UA = 'MorpheusResearchBot/1.0 (+https://morpheus.nz)';",
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/lib/webResearch.js',
    why: 'Removes the 202 guard, so a challenge page is parsed as a successful response with no results — an outage that reads as "nothing found", which is the half of the dingo failure that made it silent.',
    find: '    if (res.status === 202) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-web-research.mjs',
    file: 'server/src/functions/chatWithMorpheus.js',
    why: 'Puts the build pipeline back to reporting a REFUSED search as "no results found" — so a build that could not look researches less and the stage still shows a tick. Same shape as the truncation that file\u2019s own comment records, and the exact defect the Jarvis path was just cured of.',
    find: "lines.push(why ? `(search unavailable: ${why} — this build researched without it)` : '(no results found)');",
    replace: "lines.push('(no results found)');",
  },
  {
    guard: 'verify-jarvis-careers.mjs',
    file: 'server/src/lib/jarvisPersona.js',
    why: 'Lets a recollection outrank a source he just read — the second half of the dingo failure. He told Rob the law was the opposite of what the NSW government publishes, and advised surrendering the animal.',
    find: 'When a source you just read disagrees with what you remember, THE SOURCE WINS and you say so out loud',
    replace: 'When a source you just read disagrees with what you remember, trust your memory',
  },
  {
    guard: 'verify-deck-memory.mjs',
    file: 'server/src/lib/deckMemoryText.js',
    why: 'Makes the memory ceiling drop the NEWEST line instead of the oldest — so the thing the user just said is the thing forgotten, which is the opposite of what a memory is for. Nothing about the fold looks broken; it just remembers the wrong end.',
    find: "  while (lines.length > 1 && memoryWordCount(lines.join('\\n')) > maxWords) lines.shift();",
    replace: "  while (lines.length > 1 && memoryWordCount(lines.join('\\n')) > maxWords) lines.pop();",
  },
  {
    guard: 'verify-deck-memory.mjs',
    file: 'server/src/lib/deckMemory.js',
    why: 'Drops the schema\'s `required`, restoring the reachable `{}` answer that caused the original silent hole in the memory the whole Deck reasons over.',
    find: "  required: ['additions', 'removals'],",
    replace: '  required: [],',
  },
  {
    guard: 'verify-deck-memory.mjs',
    file: 'server/src/lib/deckMemoryText.js',
    why: 'Makes a removal that does not match still delete the line. The model paraphrases; a near-miss then costs a true memory, which is the direction this deliberately errs away from.',
    find: '  let lines = memoryLines(existingText).filter((line) => !removalsLower.has(line.toLowerCase()));',
    replace: '  let lines = removals.length ? [] : memoryLines(existingText);',
  },
  {
    guard: 'verify-doc-export.mjs',
    file: 'src/pages/CommandDeck/exportDoc.js',
    why: 'Stops a filename falling back when everything was stripped, so exporting a reply with no usable title produces a file called ".pdf" — a real download with a confusing name, which is the case the fallback exists for.',
    find: '  return base || fallback;',
    replace: '  return base;',
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/deckSnapshotGate.js',
    why: 'Inverts the gate\'s failure direction: an unusable classifier answer (undefined, junk, a string) now DROPS the snapshot instead of including it, so a timeout answers a real question blind — the one direction the guard exists to forbid.',
    find: '  return classifierResult?.needsSnapshot !== false;',
    replace: '  return classifierResult?.needsSnapshot === true;',
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/jarvisPersona.js',
    why: 'Makes the without-snapshot persona claim the live snapshot anyway — data dropped, sentence kept: the hallucination machine the two honest variants exist to prevent.',
    find: '  const dataClaim = hasSnapshot ? SNAPSHOT_CLAIM : NO_SNAPSHOT_CLAIM;',
    replace: '  const dataClaim = SNAPSHOT_CLAIM;',
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/jarvisPersona.js',
    why: 'Gives the without-snapshot persona the energy-log guidance that assumes it was handed one, so it is told to scan days it never received and will report patterns from nothing.',
    find: '    ...(hasSnapshot ? [ENERGY_GUIDANCE] : []),',
    replace: '    ENERGY_GUIDANCE,',
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/deckSnapshotText.js',
    why: 'Makes the truncation note always empty, so every capped list reads as the whole picture again — the lie the guard asserts in both directions.',
    find: "  return total > shown ? `, newest ${shown} shown` : '';",
    replace: "  return '';",
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/deckSnapshotText.js',
    why: 'Makes the energy log always claim "every day logged" even when the query capped it at 3650 — the persona\'s own false promise, back in the line that renders the data.',
    find: '  const energyCapped = energyLog.total > energyShown;',
    replace: '  const energyCapped = false;',
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/lib/deckInsightPayload.js',
    why: 'Stops a truncation from winning over a valid-looking payload, so a cut-off JSON object that still parses is stored as a finished insight — the half-answer H6 forbids.',
    find: "  if (truncated) return { ok: false, reason: 'truncated' };",
    replace: "  if (false) return { ok: false, reason: 'truncated' };",
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/functions/runJarvisSynthesis.js',
    why: 'Moves the manual synthesis off the role that resolves to the persona\'s decided model and onto classify, i.e. flash — the exact "move the persona to flash" this change says it is not doing.',
    find: "      schema: SCHEDULED_SCHEMA,\n      role: 'planner',",
    replace: "      schema: SCHEDULED_SCHEMA,\n      role: 'classify',",
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/functions/runJarvisSynthesis.js',
    why: 'Stores the raw model payload instead of the interpreted decision, so a truncated or declined answer that never passed synthesisMessageToStore reaches the Deck as a Suggestions card.',
    find: "    data: { created_by_id: user.id, role: 'jarvis_synthesis', content: decision.content },",
    replace: "    data: { created_by_id: user.id, role: 'jarvis_synthesis', content: result.insight },",
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/functions/chatWithJarvis.js',
    why: 'Borrows the coder role for the snapshot-need boolean on the hot path of every message — the same hidden-reasoning trap the widget-build classifier was moved off, and a role change that silently moves the gate onto a slower model.',
    find: "schema: SNAPSHOT_NEED_SCHEMA, role: 'classify'",
    replace: "schema: SNAPSHOT_NEED_SCHEMA, role: 'coder'",
  },
  {
    guard: 'verify-jarvis-snapshot-gate.mjs',
    file: 'server/src/functions/chatWithJarvis.js',
    why: 'Flips the handler\'s turn-context catch to `includeSnapshot: false`, so a failed classifier DROPS the snapshot and Jarvis answers a real question blind — the failure direction the guard asserts in the wiring as well as in the rule. (2026-10-04: the catch returns all three decisions now, so it is the field rather than the whole return value.)',
    find: '          return { includeSnapshot: true, careers: [], researchQueries: [] };',
    replace: '          return { includeSnapshot: false, careers: [], researchQueries: [] };',
  },
  {
    guard: 'verify-project-divergence.mjs',
    file: 'server/src/lib/projectDivergence.js',
    why: 'Stops excluding `_compiled/*`, so Morpheus\'s own build artifacts count as repo-ahead and every healthy project is warned about a divergence that does not exist — the noise this exclusion exists to remove.',
    find: "  if (p.startsWith('_compiled/')) return true;",
    replace: "  if (p.startsWith('_compiled/')) return false;",
  },
  {
    guard: 'verify-project-divergence.mjs',
    file: 'server/src/lib/projectDivergence.js',
    why: 'Stops comparing CONTENT, so a file edited on both sides (and any file whose bytes differ) reads as in-sync — the whole detection silently disarmed while still claiming to have checked.',
    find: '    if (gitBlobSha(repo.get(path)) !== gitBlobSha(construct.get(path))) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-project-divergence.mjs',
    file: 'server/src/lib/projectDivergence.js',
    why: 'Weakens the unusable-input gate from OR to AND, so a missing file list on one side is compared as if it were empty — a check that cannot answer would claim construct-ahead instead of unknown.',
    find: "  if (!isFileList(repoFiles) || !isFileList(constructFiles)) return unknownDivergence('unusable-input');",
    replace: "  if (!isFileList(repoFiles) && !isFileList(constructFiles)) return unknownDivergence('unusable-input');",
  },
  {
    guard: 'verify-project-divergence.mjs',
    file: 'server/src/lib/projectDivergence.js',
    why: 'Drops \'repo-ahead\' from the gate predicate, so the ordinary case (the repo has files the construct lacks) no longer stops the fix loop or warns at compile — the exact incident this change exists to prevent.',
    find: "  return assessment?.state === 'repo-ahead' || assessment?.state === 'both';",
    replace: "  return assessment?.state === 'both';",
  },
  {
    guard: 'verify-project-divergence.mjs',
    file: 'server/src/lib/repoDivergence.js',
    why: 'Removes the truncated-tree refusal, so a partial recursive tree is compared as if it were the whole repo — files past the truncation read as absent and produce a false divergence claim (H17).',
    find: "    if (tree.truncated) return unknownDivergence('tree-truncated');",
    replace: "    if (false) return unknownDivergence('tree-truncated');",
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/lib/jarvisReplyBudget.js',
    why: 'Stops an over-long reply from ever being repaired, so the 743-token answer Rob complained about sails through the budget untouched — the boundary claim asserted at exactly the target and one character over it.',
    find: '  return text.length > targetChars;',
    replace: '  return false;',
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/lib/jarvisReplyBudget.js',
    why: 'Lets a TRUNCATED rewrite past the decision, so a cut-off JSON object that still parses replaces a complete original — the half-answer H6 forbids, and the exact case the truncation-wins rule exists for.',
    find: "  if (truncated) return { repaired: false, reply: before, reason: 'truncated' };",
    replace: "  if (false) return { repaired: false, reply: before, reason: 'truncated' };",
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/lib/jarvisReplyBudget.js',
    why: 'Accepts a bare string as the rewrite again, so a junk payload the schema call should never return is stored as Jarvis\'s reply — the exact bug the strict object-shape check was written for.',
    find: "  const candidate = result && typeof result === 'object' && typeof result.reply === 'string'\n    ? result.reply.trim()\n    : '';",
    replace: '  const candidate = extractReply(result);',
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/lib/jarvisReplyBudget.js',
    why: 'Drops the long-form exemption, so a user who explicitly asked for a report or a plan gets their answer shortened — the narrowing the module header and the budget both promise not to do.',
    find: '  if (longForm) return false;',
    replace: '  if (false) return false;',
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/functions/chatWithJarvis.js',
    why: 'Moves the persona\'s reply call onto the cheap draft role — the "move Jarvis to flash" decision Rob already made against, and the role-assignment the guard pins as planner (pro @ 0.7, the default it already ran on).',
    find: "schema: REPLY_SCHEMA, role: 'planner', maxTokens: MAX_REPLY_TOKENS });",
    replace: "schema: REPLY_SCHEMA, role: 'draft', maxTokens: MAX_REPLY_TOKENS });",
  },
  {
    guard: 'verify-jarvis-reply-length.mjs',
    file: 'server/src/functions/chatWithJarvis.js',
    why: 'Logs a zero reply size, so the measurement that proves the loop closed (a shorter stored reply is a smaller conversation block next turn) reads as an empty answer — a length line that lies.',
    find: 'chars=${reply.length} target=${CONVERSATIONAL_REPLY_TARGET_CHARS}',
    replace: 'chars=0 target=${CONVERSATIONAL_REPLY_TARGET_CHARS}',
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'server/src/lib/jarvisReplyStream.js',
    why: 'Makes the stream opt-in unconditional, so EVERY caller — an older deployed bundle, curl, a script that sends no `stream` field — suddenly gets NDJSON it never asked for, which is the one guarantee the whole change rests on.',
    find: '  return body?.stream === true;',
    replace: '  return true;',
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'server/src/lib/jarvisReplyStream.js',
    why: 'Lets a TRUNCATED STREAM store its fragment, so a body that died mid-sentence is written down as Jarvis\'s answer instead of falling back to the blocking call — H6, seen from the transport.',
    find: "  if (!complete) return { action: 'fallback', reason: 'stream-truncated' };",
    replace: "  if (false) return { action: 'fallback', reason: 'stream-truncated' };",
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'server/src/lib/aiStream.js',
    why: 'Stops the `[DONE]` sentinel from terminating the stream, so a body that ended properly reads as truncated and every reply is re-asked for — the framing rule that decides which streams are complete at all.',
    find: "  if (payload === '[DONE]') return { ...s, done: true };",
    replace: "  if (payload === '[DONE]') return s;",
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'server/src/lib/aiStream.js',
    why: 'Stops the reply envelope\'s value from ever closing, so the decoded prose swallows the rest of the JSON and streams `Done."}` to the operator — the one field extraction the whole visible-words path depends on.',
    find: '    if (c === \'"\') return { text: out, complete: true, found: true };',
    replace: '    if (false) return { text: out, complete: true, found: true };',
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'src/lib/jarvisSpeech.js',
    why: 'Speaks a half-written sentence, so the voice reads a fragment aloud and then continues with text the listener already heard — the boundary that makes "speak behind the stream" safe rather than gibberish.',
    find: "  if (!m) return { segment: '', spokenChars: from };",
    replace: '  if (!m) return { segment: rest.trim(), spokenChars: full.length };',
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'src/lib/jarvisStream.js',
    why: 'Drops the streamed fragments, so the deck shows an empty bubble with a live clock while the words never appear — the exact complaint ("it doesnt look like its doing anything") this reducer exists to answer.',
    find: '    return { ...live, text: live.text + evt.text };',
    replace: '    return live;',
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
  { guard: 'verify-server-imports.mjs', why: 'resolves the real import graph; a text edit that leaves the graph valid proves nothing about it' },
  { guard: 'verify-prisma-fields.mjs', why: 'reads prisma/schema.prisma and the query sites; the honest falsification is a removed field, which changes the schema\'s meaning rather than a line' },
];

/**
 * How many guards may be unproven. **This may only go DOWN.** Add a mutation and lower it by one.
 *
 * The rule it enforces is the one that matters: a NEW guard added without a mutation raises the unproven
 * count and turns CI red, so nobody can quietly add an unproven check again. Add the mutation with the
 * guard — which is the whole point — or raise this number in the same reviewable edit and say why.
 *
 * 67 → 66 on 2026-10-04: `verify-deck-memory.mjs` was in the unproven pile — it guarded the silent-hole
 * incident with no mutation of its own, so nothing proved it could fail. Rewriting it for the memory
 * stall added mutations (the ceiling dropping the newest line, a loose removal, a dropped `required`),
 * so the gap shrank by one and the ratchet comes down with it.
 *
 * 66 → 65 on 2026-10-04 (same day, later): `verify-lint-coverage.mjs` was recorded as "falsifying it
 * needs a new directory or a new file, not a text edit". That was wrong, and believing it cost an
 * outage — `#502` reached production with `orderDeckWidgets is not defined`, because the guard checked
 * that every file MATCHES a lint block and never that the block's rules were still switched on. It now
 * also asserts each `rules:` block re-spreads the recommended set, so the falsification is a plain
 * text edit (drop the spread) and the guard joins the proven pile.
 */
export const UNPROVEN_BASELINE = 65;
