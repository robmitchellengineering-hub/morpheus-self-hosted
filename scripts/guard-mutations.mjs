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
    guard: 'verify-deck-widget-backend.mjs',
    file: 'server/src/lib/widgetBackendFunctions.js',
    // The claim: an endpoint no widget invokes is REPORTED, so a delete that leaves one behind is
    // caught. Neutered, the real incident fixture (`widgetEnergySparkline` surviving PR #439) reports
    // nothing and the leftover file reads as clean — H19's "green because it examined nothing".
    why: 'Makes orphan detection return nothing, so the endpoint that actually outlived its widget (widgetEnergySparkline, PR #439) reads as owned and the guard goes green on the exact state it exists to catch.',
    find: '  return [...new Set(fileNames)].filter((name) => !referenced.has(name)).sort();',
    replace: '  return [];',
  },
  {
    guard: 'verify-deck-widget-backend.mjs',
    file: 'server/src/lib/widgetBackendFunctions.js',
    // The other half: the widget's own invocation is what proves the endpoint is the widget's to
    // remove. Without it a deletion would name nothing (the bug) — and with a looser reader it could
    // name a function the widget never called. The positive fixtures in section 1 fail on this.
    why: 'Stops reading the widget\'s own invoke() call, so the endpoint a widget owns is never named for removal and a delete silently leaves it behind — the shipped bug, as a mutation.',
    find: '  return [...names].sort();',
    replace: '  return [];',
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
    // ⚠️ REPOINTED when the workflow grew a SECOND upload — the gain build and the amp build each carry this
    // setting, so a bare `if-no-files-found` line matched twice. The guard now requires it on EVERY upload
    // step, which is why removing it from this one is enough to fail.
    why: 'Drops the failure-on-missing-artifact setting, so a run that produced no standalone still uploads three plugins and passes.',
    find: '          name: audio-plugin-macos\n          path: ${{ runner.temp }}/audio-plugin-build/build/assets/*.zip\n          if-no-files-found: error\n',
    replace: '          name: audio-plugin-macos\n          path: ${{ runner.temp }}/audio-plugin-build/build/assets/*.zip\n',
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
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-linux-arm.js',
    // Packaging, not building — and it is the difference between a download a musician can use and one they
    // have to work out. `zip` stores the path it is handed, so this ships `build/assets/<name>.vst3/…`.
    why: 'Goes back to zipping the path find returned, so the VST3 archive contains a build/ tree instead of a plugin folder.',
    find: '( cd ${LINUX_ASSETS} && zip -qr plugin-linux-arm-vst3.zip ${qVst3Dir} )',
    replace: 'zip -qr ${LINUX_ASSETS}/plugin-linux-arm-vst3.zip "$vst3"',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // The failure that cost the first Linux build, as a mutation: the VST3 SDK's static library is no longer
    // built position-independent, so the shared-object link dies with R_AARCH64_ADR_PREL_PG_HI21.
    why: 'Turns position-independent code back off for the Linux subtree, which is exactly the state the first ARM build failed in — a linker error naming a relocation rather than the cause.',
    find: 'set(CMAKE_POSITION_INDEPENDENT_CODE ON CACHE BOOL "Linux plugins are shared objects" FORCE)',
    replace: 'set(CMAKE_POSITION_INDEPENDENT_CODE OFF CACHE BOOL "Linux plugins are shared objects" FORCE)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // ⚠️ THE BUG THE LOCAL clang -fsyntax-only CAUGHT: macros in the header, no declaration of the symbols.
    why: 'Drops the extern declaration of the embedded model bytes, leaving the plugin referencing symbols only the .cpp defines — a compile error in every project that has a model.',
    find: 'extern const unsigned char morpheus_model_data[];',
    replace: '/* declaration removed */',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // Two engines, one comparison: the CLI renders the reference WAV and the plugin plays the model. Move one
    // pin and the offline proof is measuring two different implementations.
    why: 'Moves the plugin\u2019s engine pin off the commit the measurement CLI builds, so the reference render and the plugin are no longer the same code.',
    find: "export const NAMCORE_REF = '0b3d3c9';",
    replace: "export const NAMCORE_REF = 'deadbee';",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // Eigen is a submodule. Without this line the build fails on a missing header inside a library the user
    // has never heard of, several minutes in.
    why: 'Skips the submodule update, so Eigen is never fetched and the engine cannot compile.',
    find: 'git -C "$RUNNER_TEMP/namcore" submodule update --init --depth 1',
    replace: 'echo "skipping the engine submodules"',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // The model data is a translation unit; leaving it out of the library links nothing that defines it.
    why: 'Leaves ModelData.cpp out of the plugin library, so the embedded model is never compiled in.',
    // ⚠️ THE LINE GREW A FILE when the cabinet landed, and this mutation went STALE — a find that matches
    // nothing is a guard that is no longer proven, and the harness is right to refuse it. It now drops only
    // ModelData.cpp, which is still the thing it is about, while the cabinet's own mutation drops CabIr.cpp.
    find: 'Source/Plugin.cpp Source/ModelData.cpp Source/CabIr.cpp \\${MORPHEUS_GUI_SOURCE})',
    replace: 'Source/Plugin.cpp Source/CabIr.cpp)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // NAM_SAMPLE lives in a macro INSIDE the library, so it decides the signature of the function the plugin
    // calls. A target that disagrees does not get a warning; it gets a link error naming a mangled symbol.
    why: 'Stops pinning the sample type, so the plugin and the engine can disagree about process()\u2019s signature.',
    find: 'target_compile_definitions(morpheus_plugin-impl PRIVATE NAM_SAMPLE_FLOAT)',
    replace: 'target_compile_definitions(morpheus_plugin-impl PRIVATE MORPHEUS_NO_SAMPLE_TYPE)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // One instance per channel, because a .nam is mono and the port declaration promises two channels.
    why: 'Reduces the plugin to a single model instance, which silently collapses every stereo source to mono while the descriptor still advertises two channels.',
    find: 'nam::DSP *model[2];',
    replace: 'nam::DSP *model[1];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // A model that will not load must not take the plugin with it — but a silent fallback is the worse failure.
    why: 'Removes the message a host\u2019s log gets when a model fails to load, leaving a gain stage and no reason for it.',
    find: 'could not load the NAM model from',
    replace: 'running without the model',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-linux-arm-runner-build.mjs',
    // Without this the runner cannot build the modelled project at all, so the model path is proven only by a
    // guard that reads text.
    why: 'Stops the ARM runner seeding a model into the workspace, so the model path is never built on hardware.',
    find: 'path: `models/${basename(modelArg)}`',
    replace: 'path: `models/unused.nam`',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-linux-arm-build.yml',
    // And without the dispatch step above it, the same thing: a guard-only proof.
    why: 'Drops the modelled build from the ARM workflow, so a project with a model is never compiled for a Pi.',
    find: '--model .cache/models/wavenet_a1_standard.nam',
    replace: '--model .cache/models/absent.nam',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-linux-arm-runner-build.mjs',
    // The modelled builds died on `git clone ... already exists` because one job builds several times. The fix
    // clears clap-wrapper rather than weakening the clone; the engine is now CACHED and verified instead, so the
    // mutation defeats the wrapper's clearing — the half that must still happen on every run.
    why: 'Stops clearing the previous build\u2019s clap-wrapper, so a later modelled build in the same job dies on a clone that already exists.',
    find: 'if (existsSync(wrapper)) {',
    replace: 'if (false) {',
  },
  // ── the engine cache (2026-10-07): the GitLab outage, and the pair of guarantees that make a cache safe ──
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-macos-build.yml',
    // ⚠️ THE EIGEN HALF OF THE KEY. NAMCore's own tree pins its eigen submodule, so the engine pin is not the
    // only way the cached tree goes stale — a key naming only NAMCORE_REF would keep serving the old eigen
    // checkout. The guard requires BOTH pins; this removes one and leaves the other.
    why: 'Drops the eigen submodule pin from the cache key, so a cached checkout would survive NAMCore moving its eigen submodule.',
    find: 'key: namcore-${{ runner.os }}-0b3d3c9-bc3b39870ecb690a623a3f49149a358b95c5781d',
    replace: 'key: namcore-${{ runner.os }}-0b3d3c9',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-windows-build.yml',
    // A cache of the wrong directory restores nothing the runner reads, so the GitLab fetch the cache was meant
    // to remove happens anyway — and the run still says a cache step ran.
    why: 'Caches a directory the runner never reads, so the cache restores nothing and the fetch returns silently.',
    find: 'path: ${{ runner.temp }}/namcore',
    replace: 'path: ${{ runner.temp }}/namcore-cache',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/lib/engineCache.mjs',
    // ⭐ THE CLAIM THE WHOLE CACHE RESTS ON: a restored checkout is reused only when HEAD IS THE PIN. Defeating
    // the comparison is how the cache would serve a different revision — the one outcome worse than the outage
    // it fixes — and the build would be green.
    why: 'Accepts any HEAD as the pinned commit, so a restored checkout from a different revision would be built against.',
    find: 'if (!commit.startsWith(NAMCORE_REF)) {',
    replace: 'if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/lib/engineCache.mjs',
    // The file whose absence was the original `fatal error: 'Eigen/Dense' file not found`. A submodule whose
    // HEAD is right but whose working tree was never written is still a build that dies minutes later.
    why: 'Stops checking that the eigen header is present, so a checkout whose submodule has no working tree is reused.',
    find: 'if (!existsSync(join(dir, EIGEN_HEADER))) {',
    replace: 'if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-macos-runner-build.mjs',
    // ⭐ BLIND REUSE, as a mutation: the runner still logs a HIT and clears nothing, so whatever the cache
    // restored is built against without the pin ever being read. The guard asserts the CALL, not the log line.
    why: 'Replaces the verification with a trust-all verdict, so a restored checkout is reused without checking the pin.',
    find: 'const verdict = engineCheckoutVerdict(engine);',
    replace: "const verdict = { reuse: true, reason: 'assumed' };",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // The other half of a safe reuse: the clone step must not try to clone into the directory the runner kept,
    // or a verified cache would fail the step outright. Skipping a checkout that is NOT there restores the
    // `destination path already exists` failure the cache was supposed to make impossible.
    why: 'Stops the clone step skipping a verified checkout, so a cache hit makes `git clone` fail on a directory that exists.',
    find: 'if [ -d "$RUNNER_TEMP/namcore/.git" ]; then',
    replace: 'if [ -d "$RUNNER_TEMP/namcore/never" ]; then',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // The block size is the one difference between the two signal paths that has nothing to do with the
    // plugin: ours ramps per sample, `render` uses 64. Move it and the comparison measures the block size.
    why: 'Stops the plugin render from using the reference renderer\u2019s block size, so the null test measures the difference between two block sizes instead of the plugin.',
    find: 'export const REFERENCE_BLOCK_SIZE = 64;',
    replace: 'export const REFERENCE_BLOCK_SIZE = 512;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // The comparison arithmetic itself. `+` instead of `-` is the shape of an implementation that would find
    // two copies of the same signal different and two different signals equal.
    why: 'Subtracts the two signals with the wrong sign, so the null test no longer measures their difference.',
    find: 'const d = reference[i] - candidate[i];',
    replace: 'const d = reference[i] + candidate[i];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // Interleaving is the part that goes wrong quietly: a wrong frame count gives a reader that runs off the
    // end of one channel into the next and reports two plausible signals.
    why: 'Writes the wrong frame count into the MRAW header, so every reader de-interleaves across the wrong boundary.',
    find: 'head.writeUInt32LE(interleaved.length / channels, 16);',
    replace: 'head.writeUInt32LE(interleaved.length, 16);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    why: 'Passes a different block size to the host than the reference renderer uses, which is exactly the difference the constant exists to remove.',
    find: "'--blocksize', String(REFERENCE_BLOCK_SIZE)",
    replace: "'--blocksize', String(256)",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // ⚠️ THE BUG THE FIRST RUN OF THIS CHECK ACTUALLY HIT: `wav.h` exists twice in that tree, so compiling the
    // tool with the engine's include order makes `dsp::wav` undeclared. The fix is the tool's own order first.
    why: 'Puts the reference tool back on the engine\u2019s include order, where `#include "wav.h"` resolves to the engine\u2019s file and render.cpp fails to compile.',
    find: "`-I${adt}`, ...namIncludes, '-c',",
    replace: "...namIncludes, '-c',",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // The engine's wav.cpp and the tool's wav.cpp produce the same object filename, so one shared directory
    // silently loses one of them and the link fails on a missing engine symbol.
    why: 'Compiles both groups into one object directory, where the two wav.cpp files write the same wav.o and the link loses the engine\u2019s.',
    find: "const objTool = join(work, 'obj-tool');",
    replace: "const objTool = join(work, 'obj-nam');",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // The standard belongs in the shared flag list: leaving it out compiles the engine as C++17.
    why: 'Drops the C++ standard from the shared compile flags, so the engine\u2019s sources are compiled as C++17 and do not build.',
    find: "const COMPILE_FLAGS = ['-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT'];",
    replace: "const COMPILE_FLAGS = ['-O2', '-w', '-DNAM_SAMPLE_FLOAT'];",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⚠️ THE CORRUPTION IN THE PARAMETER DOMAIN, as a mutation. Dropping the stable ordering makes the
    // parameter list follow the stages again, so a pedalboard reorder re-numbers the controls — and a host's
    // automation lane, which is keyed by that number, follows the wrong knob. Nothing throws.
    why: 'Makes the parameter order follow the stages again, so reordering a block renumbers the controls a host has automated.',
    find: 'export function chainParamsStable(chain, manifest = {}) {',
    replace: 'export function chainParamsStable(chain, manifest = {}) { return chainParams(chain, manifest);\\n  // eslint-disable-next-line no-unreachable\\n  const unused = () => {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⚠️ THE CORRUPTION THIS ID EXISTS TO PREVENT, as a mutation. Two stages sharing an id is not a type
    // error and nothing fails to build: a saved value, a MIDI binding or an automation lane attached to one
    // silently applies to the other, which is a board that misbehaves only after a user rearranges it.
    why: 'Gives the cabinet the model\u2019s id, so two stages share an identity and anything keyed to it follows the wrong block.',
    find: "{ id: 'cab', kind: 'cab' },",
    replace: "{ id: 'model', kind: 'cab' },",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // 0.001 dB of coefficient error measured as -55 dB of residual against the design; 1e-6 measures -140.
    why: 'Puts the tone coefficients back on a thousandth-of-a-decibel update threshold, which the measurement showed leaves the filter visibly wrong.',
    find: '#define MORPHEUS_TONE_EPS 0.000001',
    replace: '#define MORPHEUS_TONE_EPS 0.001',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // An unknown chain that becomes the amp is a project silently building a plugin nobody asked for.
    why: 'Makes every project the amp chain, so a manifest asking for something this version does not have gets it anyway.',
    find: "if (asked === 'amp') return AMP_CHAIN;",
    replace: 'return AMP_CHAIN;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    why: 'Gives the tone stack one filter state instead of two, so the two channels share it and bleed into each other.',
    find: 'biquad_t tone[2][',
    replace: 'biquad_t tone[1][',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    // ⚠️ REPOINTED — BOTH THE FILE AND THE ANCHOR — when the model became a block call. The flag moved out of
    // the chain text and into the template's process loop, so a mutation that kept naming ampChain.js would
    // have gone stale, which reads as coverage. The property is unchanged: the generated source must not
    // change shape when a project carries a model.
    file: 'server/src/lib/audioPluginTemplate.js',
    why: 'Takes the model out from behind MORPHEUS_HAS_MODEL, so the plugin source changes shape when a project carries one.',
    // ⚠️ REPOINTED when a board could take the model out of the path: the flag is now chosen by a ternary, so
    // the anchor has to carry the ternary. The property is identical — the emitted guard must still be the
    // model's own flag.
    find: "${modelInPath ? '#if MORPHEUS_HAS_MODEL' : '#if 0'}\n      // ── THE MODEL, ONCE PER CHUNK PER CHANNEL",
    replace: "${modelInPath ? '#if 1' : '#if 0'}\n      // ── THE MODEL, ONCE PER CHUNK PER CHANNEL",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // `IDX_OUTPUT` is the name the test bench's patch and the output multiply both rely on.
    why: 'Renames the plain plugin\u2019s parameter key, so the emitted C++ indexes an identifier that does not exist and the bench stops matching the output line.',
    // ⚠️ REPOINTED when a chain became a list of stages: the plain plugin's one control is no longer a
    // returned literal but a stage's `param`, so the mutation follows the text rather than the shape.
    // ⚠️ REPOINTED when a bypassed block's control had to say so in its own name: the emitted name grew a
    // suffix. The claim is unchanged — the key a parameter is indexed by must stay `output`.
    find: "out.push({ ...stage.param, name: stage.param.name ?? String(manifest.paramName || 'Gain'), module });",
    replace: "out.push({ ...stage.param, key: 'gain', name: stage.param.name ?? String(manifest.paramName || 'Gain'), module });",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // The drift this check exists for: a corner frequency that is right in the design and wrong in the build.
    why: 'Hardcodes a band\u2019s corner frequency instead of emitting it from the design, so the filters that run and the design the measurement checks against disagree.',
    find: '${num(b.freq)}, ${num(b.q)}, p->tone_last',
    replace: '120.0, ${num(b.q)}, p->tone_last',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-testbench.mjs',
    why: 'Puts the bench\u2019s self-test patch back on the plugin shape that no longer exists, so it would silently patch nothing and pass a broken plugin.',
    find: 'const APPLIED_GAIN = ',
    replace: 'const APPLIED_GAIN_UNUSED = ',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // The mistake the test bench caught on its first local run: the output level emitted both inside the
    // channel loop and on the final line, so a +6 dB setting measured +11.85 dB.
    why: 'Applies the output level twice, which is exactly the defect that measured a +6 dB setting as +11.85 dB.',
    find: 'process->audio_outputs[0].data32[0][k] = (float)(in_l * db_to_linear(p->smoothed[IDX_OUTPUT]));',
    replace: 'process->audio_outputs[0].data32[0][k] = (float)(in_l * db_to_linear(p->smoothed[IDX_OUTPUT]) * db_to_linear(p->smoothed[IDX_OUTPUT]));',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/audio-plugin-linux-arm.js',
    // A proof that is written and never published is a file nobody receives — the defect this whole feature
    // exists to fix, reintroduced one line at a time.
    why: 'Stops declaring the proof file for release, so the build writes it and the download does not carry it.',
    find: '    proofFile: BUILD_PROOF_FILE,',
    replace: '    proofFile: null,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/compile-targets/workflow-renderer.js',
    why: 'Stops the workflow publishing any proof file, so every route builds one and none of them reaches a user.',
    find: '  const proofSection = artifact.proofFile ?',
    replace: '  const proofSection = false ?',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/buildProof.js',
    // The header must carry no facts: a template that says "AArch64" would say it for a build that produced
    // an x86-64 plugin, which is the difference between evidence and a claim.
    why: 'Puts a fact into the header the generator writes, so the proof states something the build never checked.',
    // Anchored on the RETURN line: the title also appears inside the `=`-repeat expression directly below it,
    // so the bare string matches twice and the harness refuses an ambiguous mutation — which is what happened.
    find: '  return `MORPHEUS BUILD PROOF — ${target}',
    replace: '  return `MORPHEUS BUILD PROOF — ${target} (AArch64)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/buildProof.js',
    why: 'Stops printing the proof into the build log, so the evidence exists only as a file nobody has downloaded yet.',
    find: 'export const proofShowBash = `cat ${BUILD_PROOF_FILE}`;',
    replace: 'export const proofShowBash = `true`;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/buildProof.js',
    why: 'Removes the no-model line, so a build without a model prints a heading and then nothing — which reads as a fact that went missing.',
    find: "else echo '        (none: this is the gain plugin, which is a supported state and not a failure)'",
    replace: "else echo ''",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⚠️ THE DEFECT THIS CHECK EXISTS FOR, and it shipped: the cabinet was emitted BEFORE the model while its
    // own comment said "after the model", so a speaker was convolved in front of the amplifier driving it.
    // Every check that only looks for a stage's PRESENCE passed.
    why: 'Emits a marker nothing replaces instead of the cabinet\u2019s stage, so the speaker is not in the path at all \u2014 the shape the defect really had, where the cabinet\u2019s line and the model\u2019s were one apart.',
    // ⚠️ REPOINTED THREE TIMES, and every time by the emitted text moving rather than the claim. It was
    // emitted by `chainPostCpp`; when the chain order became DATA (2026-10-07) the legacy cabinet moved to its
    // own `legacyCabCpp`, because it is the one cabinet with no stage behind it and so nothing a reorder can
    // move. The property this protects is unchanged: the cabinet's DSP must be emitted, and after the model.
    find: "  return cabInPath && !stages.some((s) => s.kind === 'cab') ? '__CAB_STAGE__' : '';",
    replace: "  return cabInPath && !stages.some((s) => s.kind === 'cab') ? '__MODEL_STAGE__' : '';",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-testbench.mjs',
    // ⚠️ THE BUG THAT MADE THE BENCH MEASURE NOTHING: taking the host's LAST reported object, which stopped
    // being the plugin's descriptor when the host grew a timing report. Every run read `undefined` for the
    // plugin's name and crashed before a single measurement.
    why: 'Reads the host\u2019s last JSON object again, which is the timing report rather than the plugin descriptor \u2014 so the bench crashes before measuring anything.',
    find: "  const info = reported.find((o) => o && typeof o.id === 'string');",
    replace: '  const info = reported[reported.length - 1];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // OFF must be a BYPASS, because the tone rows null against the chain with no gate at all.
    why: 'Runs the gate at every threshold including its off position, so the default plugin is an envelope follower rather than bit-for-bit the chain without one.',
    find: 'if (p->smoothed[IDX_GATE] > (double)MORPHEUS_GATE_OFF_DB + 0.001) {',
    replace: 'if (true) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    why: 'Makes the gate default to a 0 dB threshold, which with a real signal is a gate that never opens — a plugin that is silent by default.',
    // ⚠️ REPOINTED for the same reason: the gate's parameter now sits inside its stage object, so the
    // line it is on ends differently. The claim is identical — the gate must default to OFF, not to 0 dB.
    find: "param: { key: 'gate', name: 'Gate', min: GATE_OFF_DB, max: 0, def: GATE_OFF_DB, role: 'gate', unit: 'dB' } },",
    replace: "param: { key: 'gate', name: 'Gate', min: GATE_OFF_DB, max: 0, def: 0, role: 'gate', unit: 'dB' } },",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-amp-chain-check.mjs',
    // ⭐ The metric that reported a SPEAKER as a gate failure: with a cabinet in the chain the loud section
    // moves the level, so an absolute comparison calls a working gate a volume control.
    why: 'Measures the gate against the dry signal instead of relative to the loud section, so the cabinet\u2019s own gain reads as a gate that never opens.',
    find: '    gateRow = { thresholdDb, loudChangeDb, quietChangeDb, relativeDb: quietChangeDb - loudChangeDb };',
    replace: '    gateRow = { thresholdDb, loudChangeDb, quietChangeDb, relativeDb: quietChangeDb };',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-linux-arm-runner-build.mjs',
    why: 'Builds a plain plugin when a cabinet is asked for, so the cabinet is silently absent and the chain check measures something else entirely.',
    find: '--cab needs --chain',
    replace: '--cab without --chain',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-linux-arm-build.yml',
    why: 'Stops proving the chain on the ARM runner, which is the only place a Pi-class CPU can be asked whether the gate, the tone stack and the speaker are their designs.',
    find: '            --chain-check',
    replace: '            --chain-check-disabled',
  },
  {
    guard: 'verify-cabinet-upload.mjs',
    file: 'server/src/lib/cabinetFile.js',
    // ⚠️ THE SSRF BOUNDARY. A row's file_url is data; a compile that dials whatever a row says is a fetch
    // primitive aimed by whoever can write a row.
    why: 'Accepts any storage URL, so a compile would fetch an address out of a database row — the thing the allowlist exists to prevent.',
    find: "  return storagePrefixes(env).some((prefix) => u.startsWith(`${prefix}/`) || (prefix.startsWith('http') && u.startsWith(prefix)));",
    replace: '  return true;',
  },
  {
    guard: 'verify-cabinet-upload.mjs',
    file: 'server/src/lib/cabinetFile.js',
    // The bytes, not the extension. A file named .wav that is not one convolves rubbish, and the user's only
    // clue would be that the cabinet "sounds wrong".
    why: 'Stops checking the RIFF/WAVE magic, so anything named .wav is accepted as a cabinet.',
    find: "  if (magic !== 'RIFF' || form !== 'WAVE') {",
    replace: '  if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/cabIr.js',
    // ⚠️ MEASURED, NOT PREFERRED: summing 4096 float products into a float nulled against the JavaScript
    // reference at -116 dB; in double it is -148 dB. The whole of that residual was accumulation.
    why: 'Accumulates the convolution in float again, which the measurement showed leaves -116 dB of residual that is arithmetic rather than filtering.',
    find: '  double y = 0.0;',
    replace: '  float y = 0.0f;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/cabIr.js',
    // ⚠️ A `${...}` inside a C++ `#if` is not guarded — the JavaScript runs first. This is the line that
    // crashed the generator on a MONO cabinet with `undefined.length`.
    why: 'Emits the right channel even for a mono cabinet, which crashed the generator before any C++ existed.',
    find: '  const right = channels[1]',
    replace: '  const right = true',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    why: 'Leaves CabIr.cpp out of the plugin library, so nothing defines the taps the plugin links against.',
    // ⚠️ THE LIBRARY TYPE IS NOT PART OF THIS CLAIM, and matching on it made this mutation go STALE the moment
    // the library became an OBJECT one — and a stale mutation reads as coverage while proving nothing. The find
    // is the SOURCE LIST, which is what the check it falsifies is actually about.
    find: 'Source/Plugin.cpp Source/ModelData.cpp Source/CabIr.cpp \\${MORPHEUS_GUI_SOURCE}',
    replace: 'Source/Plugin.cpp Source/ModelData.cpp \\${MORPHEUS_GUI_SOURCE}',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/cabIr.js',
    // A silent WAV is not a cabinet. Convolving it is a plugin that outputs nothing, with no explanation.
    why: 'Accepts a silent impulse response, which is a plugin that produces silence and says nothing about why.',
    find: "  if (!(peak > 0)) return { ok: false, reason: 'is silent (every sample is zero)' };",
    replace: '  if (false) return { ok: false, reason: "is silent" };',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/cabIr.js',
    // ⭐ THE LEVEL RULE, AS A MUTATION. Leaving the taps at the file's own level looks harmless, and every
    // guard that existed before this one still passes — they measured shapes and nulls, never loudness, which
    // is exactly how a cabinet came to be +15 dB loud and clip the moment it was switched on.
    why: 'Stops normalising the cabinet, so a baked IR keeps whatever level the file arrived at and a dense one clips.',
    find: '  const gain = bins > 0 ? Math.sqrt(power / bins) : 0;',
    replace: '  const gain = 1;',
  },

  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-linux-arm-runner-build.mjs',
    // ⭐ The check that stops the whole exercise being vacuous: a model that does nothing nulls perfectly
    // against a reference that also does nothing.
    why: 'Disables the check that the model actually changes the signal, so a comparison between two copies of the dry file would pass as a perfect null.',
    find: 'if (Number.isFinite(expectEffectDb) && !(result.dryVsReference.nullDb > expectEffectDb)) {',
    replace: 'if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-linux-arm-runner-build.mjs',
    // ⭐ THE SWITCH PROOF, ON THE CPU THE PLUGIN SHIPS TO. Replacing the call with an empty row list is the
    // H17 shape exactly: the loop runs zero times, nothing fails, and the run still says the switches are a
    // true bypass — a check that never ran reading as a check that passed.
    why: 'Stops dispatching the toggle proof, so a build that never compared a switched-off block to its absence reports that it did.',
    find: "  const toggles = toggleCheck({ work: join(OUT, 'toggle-check') });",
    replace: '  const toggles = { rows: [] };',
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'server/src/functions/getBuildProof.js',
    // ⭐ The whole point of the feature: the panel shows the BUILD'S text. A panel that composed its own
    // summary would be a claim again — it would say "AArch64" for a build that produced an x86-64 plugin,
    // which is the thing BUILD-PROOF.txt exists to avoid.
    why: 'Makes the proof endpoint write its own summary instead of returning the build\u2019s file, so what the panel shows states things the build never checked.',
    find: 'const proof = await res.text();',
    replace: "const proof = 'MORPHEUS BUILD PROOF — a summary Morpheus wrote';",
  },
  {
    guard: 'verify-artifact-save-background.mjs',
    file: 'src/components/matrix/CompilePanel.jsx',
    why: 'Renders the proof block unconditionally, so every build that published no proof shows an empty box where the evidence should be.',
    find: '{status?.proof && (',
    replace: '{true && (',
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
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/namCapture.js',
    // THE OFFSET BUG, which this repository has already paid for once in `bestLag`: the delay is measured
    // relative to the start of the scan window, so dropping that term reports the window's own index instead
    // of the delay. It is the worst shape of wrong — a plausible number of the right sign and a magnitude off
    // by a constant — and a pre-flight that reports a 1 039-sample round trip for a 39-sample one sends the
    // user off to re-record an interface that was fine.
    why: 'Reports the impulse scan\u2019s own index as the delay, so every alignment the tool predicts is wrong by the lookahead.',
    find: '  const delay = first + startLooking - iRel;',
    replace: '  const delay = first;',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/namCapture.js',
    // THE TRIGGER HAS TWO BRANCHES AND THE QUIET ONE IS THE ONE THAT HIDES. Pinning the threshold to the
    // absolute floor makes every quiet capture check out, which is exactly the case the official input takes —
    // so a test suite built only on silence would still pass. On a real high-gain capture the amp's own hiss
    // then trips the scan on its first sample and the trainer reports a delay of -lookahead.
    why: 'Pins the impulse trigger to the absolute floor, so a loud amp\u2019s noise floor can no longer raise it.',
    find: '  const threshold = Math.max(background + info.absThreshold, (1 + info.relThreshold) * background);',
    replace: '  const threshold = info.absThreshold;',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/namCapture.js',
    // A CHECK THAT NEVER RUNS READS AS A CHECK THAT PASSED (H17). v3 can tell whether the amp held still,
    // because its input carries the same validation signal at both ends; removing that comparison leaves a
    // take with a knob moved halfway through reporting as a pair that will train, and the model comes back
    // wrong with nothing in the report to explain it.
    why: 'Skips the replicate-ESR comparison, so a take whose amp drifted is reported as one that will train.',
    find: '    if (!(facts.replicateEsr <= 0.01)) {',
    replace: '    if (false) {',
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
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⭐ THE REGRESSION THIS WHOLE CHANGE EXISTS TO PREVENT, as a mutation. One sample at a time produces the
    // SAME AUDIO and costs 2.6x more CPU, so nothing about the output says it happened — the plugin simply
    // stops fitting on the machine it was measured for.
    why: 'Puts the model back to one sample per call, which changes no audio and costs 2.6x the CPU.',
    // ⚠️ REPOINTED when the model gained a switch: the call is now written three times (the fully-on path,
    // the fade path and the no-switch fallback), so the find carries the guard that makes it the ONE this
    // mutation is about — the path every existing proof takes. The claim is unchanged.
    find: '               if (on_model >= 1.0 || !p->model_dry[c] || model_frames > (int)p->model_dry_cap) {\n                  p->model[c]->process(io, io, model_frames);',
    replace: '               if (on_model >= 1.0 || !p->model_dry[c] || model_frames > (int)p->model_dry_cap) {\n                  p->model[c]->process(io, io, 1);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // THE CAST THAT IS ONLY SOUND WHILE NAM_SAMPLE IS FLOAT. Without the assert, turning off NAM_SAMPLE_FLOAT
    // makes NAM_SAMPLE double, and reinterpreting a float32 port as double* is undefined behaviour — not a
    // compile error, and not necessarily a crash either. It would read garbage and sound like a broken model.
    why: 'Drops the static_assert tying the in-place cast to NAM_SAMPLE being float, turning a compile error into undefined behaviour.',
    find: '         static_assert(sizeof(NAM_SAMPLE) == sizeof(float), "the model runs in place on a float32 port");\n',
    replace: '',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    // ⚠️ THE EMITTED LINE IS BUILT IN ampChain.js, not written in the template — the template holds
    // `${smoothCpp('IDX_OUTPUT')}`. So this points at the module that owns the text; the first version aimed
    // at the template and was stale on arrival.
    file: 'server/src/lib/ampChain.js',
    // THE OUTPUT RAMP, stepped in the wrong pass. Stepping it in pass 1 as well as pass 2 doubles its rate;
    // stepping it only in pass 1 runs it a block ahead. Both are inaudible at 64 frames and both are wrong.
    why: 'Stops pass 1 skipping the output smoother, so the output ramp is stepped twice per sample and settles at twice the rate.',
    find: '...(skipIdx ? [`            if (k == ${skipIdx}) continue;`] : []),',
    replace: '',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-linux-arm-build.yml',
    // A PIN THAT ONLY HALF THE WORKFLOW HONOURS IS NOT A PIN. Fetching example models from `main` while the
    // engine is pinned lets a model arrive that the pinned engine cannot load, and it would fail inside a
    // build rather than here.
    why: 'Puts the example-model download back on a moving branch while the engine stays pinned, so a model the pinned engine cannot load can reach a build.',
    find: 'NeuralAmpModelerCore/0b3d3c9/example_models',
    replace: 'NeuralAmpModelerCore/main/example_models',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // ⭐ THE GATE ON ONE FORMAT, as a mutation: dropping the container branch sends a SlimmableContainer back
    // through the flat-weight check, which rejects the format NAM is moving to and reports it as though the
    // file were corrupt. That is the state this repository was actually in until 2026-10-05.
    why: 'Removes the SlimmableContainer branch, so NAM A2\u2019s own file format is refused as a corrupt model.',
    find: "  const isContainer = String(raw.architecture) === 'SlimmableContainer';",
    replace: "  const isContainer = false;",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // A CONTAINER MUST NOT BECOME A HOLE. The flat check refuses a non-finite weight because a null becomes a
    // plausible zero in the plugin and the model plays something that was never trained; skipping that per
    // submodel would reopen it exactly where a truncated file is hardest to notice.
    why: 'Stops checking submodel weights for non-finite values, so a null weight reaches the plugin through the container path.',
    find: '      const bad = m.weights.findIndex((w) => typeof w !== \'number\' || !Number.isFinite(w));',
    replace: '      const bad = -1;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/namPlugin.js',
    // THE PROJECTION IS WHAT THE PRODUCT SEES. `inspectModel` knowing about submodels is worth nothing if
    // `resolveModel` drops them on the way to the scaffold — which it did, and the format validated while
    // nothing downstream could act on it.
    why: 'Drops the slimmable flag from the projection the scaffold reads, so a container validates but nothing knows it can be resized.',
    find: '      slimmable: inspected.slimmable === true,',
    replace: '      slimmable: false,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // ⭐ THE DIRECTION OF THE ANSWER, as a mutation. Swapping the division reports a machine that cannot keep up
    // as one with headroom to spare, and every null test in the run still passes — the plugin is right, it just
    // does not fit. That is the failure that only shows up on the device.
    why: 'Inverts the real-time factor to audio-over-wall, so a CPU that cannot keep up is reported as one with headroom to spare.',
    find: 'return { realTimeFactor: processSeconds / audioSeconds, timesFaster: audioSeconds / processSeconds };',
    replace: 'return { realTimeFactor: audioSeconds / processSeconds, timesFaster: processSeconds / audioSeconds };',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'tools/clap-offline/clap_offline.cpp',
    // A MEASUREMENT THAT MEASURES THE WRONG THING IS WORSE THAN NONE. Timing from before the file is read and
    // the plugin is constructed makes "throughput" a report on process startup, and on a four-second render the
    // startup is a real fraction of it.
    why: 'Starts the clock before the plugin is loaded, so the reported throughput is partly a measurement of process startup.',
    find: '  const auto processStart = std::chrono::steady_clock::now();',
    replace: '  const auto processStart = processStartEarly;',
  },
  {
    guard: 'verify-license-terms.mjs',
    file: 'LICENSE',
    // ⭐ THE POSTURE ITSELF, as a mutation. Deleting the prohibition changes nothing that runs: the build
    // passes, the site deploys, the portable bundle still downloads — and the project becomes "publicly
    // readable with no terms", which is the ambiguous middle this file exists to end.
    why: 'Deletes the prohibition on reuse, so the repository is publicly readable with no terms stated and the notice reads as permission.',
    find: 'No licence is granted except as set out below.',
    replace: 'You are free to use this software for any purpose.',
  },
  {
    guard: 'verify-license-terms.mjs',
    file: 'server/package.json',
    // ⚠️ THE DIRECTION IT ACTUALLY WENT WRONG. A manifest is what a tool reads and a LICENSE is what a person
    // reads; a permissive value in the manifest grants the rights the notice withholds, and it wins silently.
    why: 'Puts a permissive licence back in a manifest, granting through the file a tool reads the rights the notice withholds.',
    // No trailing comma: `license` is the last key in the manifest, and the first version of this find
    // included one and matched nothing.
    find: '"license": "SEE LICENSE IN ../LICENSE"',
    replace: '"license": "MIT"',
  },
  {
    guard: 'verify-license-terms.mjs',
    file: 'LICENSE',
    // THE CARVE-OUT THAT KEEPS THE NOTICE FROM CONTRADICTING THE PRODUCT. Losing this section would let the
    // notice be read as claiming a user's own generated project, against the promise the product is sold on.
    why: 'Deletes the carve-out for generated applications, so the notice can be read as claiming the user\u2019s own project.',
    find: '1. APPLICATIONS MORPHEUS GENERATES ARE YOURS.',
    replace: '1. Applications Morpheus generates remain subject to this notice.',
  },
  {
    guard: 'verify-netlify-cost.mjs',
    file: 'netlify.toml',
    // ⭐ THE BILL, as a mutation — and the one that has actually happened twice. Removing the ignore command
    // puts a full site build on every push to every pull request, which cost Rob two rounds of buying credits.
    // Nothing goes red: the site builds, the previews look fine, and the money leaves quietly.
    why: 'Removes the deploy-preview skip, so every push to every pull request builds and deploys the whole site again.',
    find: '  ignore = "test \\"$CONTEXT\\" = \\"deploy-preview\\""\n',
    replace: '',
  },
  {
    guard: 'verify-netlify-cost.mjs',
    file: 'netlify.toml',
    // THE TRAP THE FILE ALREADY WARNS ABOUT, as a mutation: the path-based form is the obvious way to save
    // more, and an incomplete path list leaves the deployed site SILENTLY stale.
    why: 'Swaps the deploy-context rule for a path-based one, the shape that leaves the live site quietly stale when the path list is wrong.',
    find: '  ignore = "test \\"$CONTEXT\\" = \\"deploy-preview\\""',
    replace: '  ignore = "git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF scripts/ server/"',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    // ⭐ THE DRIFT ROB NAMED, as a mutation: a plugin format exists on more than one platform, so a page that
    // describes a route's machine while the picker's own label says a different one is the "builds for
    // whatever you are on" failure in its purest form — and it is one word, in a string nobody re-reads.
    why: 'Moves the macOS audio route onto Windows in the published copy, so the page describes one machine while the target it names builds for another.',
    find: '        "platform": "macOS",',
    replace: '        "platform": "Windows",',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'src/lib/morpheusCapabilities.json',
    // A FORMAT THE BUILD DOES NOT VERIFY. An Audio Unit on the Windows route is not a typo — it is a promise
    // that target cannot keep and does not check for, which is how a download arrives missing the one file the
    // page advertised.
    why: 'Promises an Audio Unit from the Windows route, which has no AU and whose build never checks for one.',
    find: '        "formatTokens": ["VST3", "CLAP", "standalone"],\n        "detail": "No Audio Unit, and that is not an omission',
    replace: '        "formatTokens": ["VST3", "AU", "CLAP", "standalone"],\n        "detail": "No Audio Unit, and that is not an omission',
  },
  {
    guard: 'verify-seo-static.mjs',
    file: 'scripts/seo-static.mjs',
    // A DOC THAT REACHES PEOPLE AND NOT MACHINES. The whole point of the audio doc is that a model asked
    // "can Morpheus build me an audio plugin, and for which machine?" can answer it; dropping it from llms.txt
    // leaves the page correct and the answer engines silent, which is the original failure exactly.
    why: 'Drops the audio docs from llms.txt, so the page describes the pathway and the machine-readable brief does not.',
    find: '${audioMd}## What Morpheus does\n\n${capabilities.map((c) => `- **${c.title}**',
    replace: '## What Morpheus does\n\n${capabilities.map((c) => `- **${c.title}**',
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/captureCheck.js',
    // ⭐ THE ONE-IMPLEMENTATION CLAIM, AND THE REASON THE PANEL IS SAFE TO SHIP. Passing the input's SAMPLES
    // instead of its frame count still produces the right verdict — every behavioural check above stays green —
    // while holding a 73 MB Float64Array for the rest of the request, because the official re-amp signal is
    // 9.12 M frames. That is the class of bug a comment cannot prevent.
    why: 'Hands the endpoint the whole decoded input instead of its frame count, so a 27 MB upload becomes 73 MB held in memory for the rest of the request.',
    find: '    inputFrames,\n    recorded: rec.samples,',
    replace: '    input: rec.samples,\n    recorded: rec.samples,',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/routes/capture.routes.js',
    // A SECOND IMPLEMENTATION OF THE RULES, which is how the panel and the command line start disagreeing
    // about the same upload. The route is supposed to be multipart and a status code.
    why: 'Makes the route re-derive the verdict itself instead of delegating, so there are two implementations of the trainer\u2019s own rules.',
    find: "import { runCaptureCheck } from '../lib/audio/captureCheck.js';",
    replace: "import { checkCapture } from '../lib/audio/namCapture.js';\nimport { runCaptureCheck } from '../lib/audio/captureCheck.js';",
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/namCapture.js',
    // THE BOUND BELOW THE FILE EVERYONE MUST UPLOAD. A 16 MB limit — the cabinet's, copied by habit — rejects
    // the official 27.4 MB re-amp signal, and it does it as "too large", which reads as the user's fault.
    why: 'Drops the upload limit below the official re-amp signal, so the one input the trainer accepts is refused as too large.',
    find: 'export const MAX_CAPTURE_BYTES = 40 * 1024 * 1024;',
    replace: 'export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;',
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
    find: '\nexport const UNPROVEN_BASELINE = 60;\n',
    replace: '\nexport const UNPROVEN_BASELINE = 61;\n',
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
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/springBlock.js',
    // ⭐ THE DIRECTION OF THE CHIRP, as a mutation. The sign of the all-pass coefficient decides which end of
    // the spectrum is held back: positive delays the highs and the reverb sweeps UP, which no spring does. It
    // is the one character of this block that a measurement had to find — the first version was 0.36 ms the
    // wrong way and looked entirely correct.
    why: 'Flips the dispersion coefficient so the reverb chirps upward instead of downward, which is the direction no spring disperses in.',
    find: 'const AP_A = -0.62;',
    replace: 'const AP_A = 0.62;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/springBlock.js',
    // Three round trips that are the same length beat against each other as one flutter, which is a delay
    // rather than a reverb — and the whole reason a tank has more than one spring.
    why: 'Makes the three springs the same length, so their chirps line up into one flutter instead of filling in.',
    find: 'const LOOP_48 = [1301, 1997, 2903];',
    replace: 'const LOOP_48 = [1301, 1301, 1301];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // ⭐ THE MERGE. Two blocks that are not part of an amp have to both reach the source; a bundle that
    // overwrote instead of accumulating would leave one block's marker in the C++ as a compile error.
    why: 'Stops the block bundles accumulating, so only the first non-amp block in a board reaches the generated source.',
    find: '    Object.assign(out.markers, b.markers || {});',
    replace: '    out.markers = { ...(b.markers || {}) };',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/driveBlock.js',
    // ⭐ THE ASYMMETRY, as a mutation. Equal thresholds are a symmetric clipper, and a symmetric clipper cannot
    // produce an even harmonic — which is the difference between "warm" and "fizzy", and the one thing about
    // this architecture a listener notices immediately.
    why: 'Makes the two diode thresholds equal, so the clipper is symmetric and the even harmonics the drive depends on cannot exist.',
    find: 'const VF_NEG = 0.46;',
    replace: 'const VF_NEG = 0.30;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/driveBlock.js',
    // An asymmetric clipper puts a DC offset on its output. Without the coupling cap the plugin emits a
    // constant offset into a host's mix bus — a measurable fault, and one that a listener hears as a thump.
    why: 'Removes the coupling capacitor, so the asymmetric clipper\u2019s DC offset reaches the output.',
    find: '   d->dcY = out - d->dcX + 0.9995 * d->dcY;',
    replace: '   d->dcY = out;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/driveBlock.js',
    // ⭐ THE BLEND, as a mutation. A clean path that does not give way turns the pedal back into a single-path
    // overdrive whose level rises with the gain — the exact thing this architecture exists not to do.
    why: 'Stops the clean path giving way as the gain comes up, so the level rises with the gain like any other overdrive.',
    find: '   const double out = x * (1.0 - d->mix) + clipped * (d->mix * MORPHEUS_DRIVE_MAKEUP);',
    replace: '   const double out = x * 1.0 + clipped * (d->mix * MORPHEUS_DRIVE_MAKEUP);',
  },
  // ── the delay, and the extension point it proved (2026-10-05) ─────────────────────────────────────────
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // ⚠️ THE BUG THIS SHIPPED WITH FIRST, AS A MUTATION. `boardChain` read "more than one parameter" as "a
    // tone stack" and wrote the delay's Time, Feedback and Mix over TONE_BANDS as bass, middle and treble: the
    // generated plugin had BASS = 300 ms, no delay in it, and every presence check still passed.
    why: 'Stops a block that declares its own parameters from carrying them, so the delay\u2019s Time, Feedback and Mix are written over the tone stack\u2019s three bands instead.',
    find: '    if (entry.params) stage.params = params;',
    replace: '    if (false) stage.params = params;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // The parameter list is ordered by the owning block, and a key whose owner cannot be found ranks 0 — so
    // forgetting one of the three shapes a stage holds its controls in sorts that block's controls to the
    // FRONT and moves every id in the amp chain.
    why: 'Stops looking for a block\u2019s own parameter table when ordering the controls, so the delay\u2019s three ids land before Input and renumber the whole chain.',
    find: '      const keys = st.params ? st.params.map((x) => x.key)',
    replace: '      const keys = (false) ? st.params.map((x) => x.key)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⭐ THE EXTENSION POINT. Without it a stage that brings its own DSP emits nothing at all, which is the
    // silent-loss shape the board was built to prevent — a block in the picture and no block in the plugin.
    why: 'Drops the pass-through for a stage that carries its own DSP, so a delay in the arrangement emits nothing into the plugin.',
    find: '  if (stage.dsp) return [stage.dsp];',
    replace: '  if (stage.dsp) return [];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginProject.js',
    // The bundle is what the template interpolates. Not passing it leaves the block's marker in the generated
    // C++ — a compile error for anyone who adds a delay, rather than a wrong sound.
    why: 'Stops handing the blocks\u2019 own C++ to the template, so a delay\u2019s marker is left in the generated source unreplaced.',
    find: '    blocks: useBoard ? boardBundle(board) : null,',
    replace: '    blocks: null,',
  },
  {
    guard: 'verify-onramp.mjs',
    file: 'src/components/matrix/CompilePanel.jsx',
    // ⭐ THE BUG THAT HID A WHOLE FEATURE, AS A MUTATION — the exact text that shipped. A hardcoded target
    // list in a panel that is not a picker, missing the three audio-plugin routes, so their buttons could
    // never render and every guard stayed green.
    why: 'Puts a hardcoded target list back into the compile panel, so a target the server can build is one the panel refuses to.',
    find: "const SUPPORTED = COMPILE_TARGETS.map((t) => t.value).filter((v) => v !== 'source');",
    replace: "const SUPPORTED = ['web-app', 'python-package', 'windows-exe', 'linux-binary', 'mac-app', 'android-apk', 'ios-app', 'rpi-distro', 'linux-distro', 'arduino-firmware'];",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ THE WHOLE FEATURE, AS ONE LINE. Without this the plugin exposes no panel, and a standalone window
    // has nothing to put in it — the state that shipped and that only a person opening the app could see.
    why: 'Stops the plugin advertising a GUI at all, so the standalone window comes up empty and a DAW falls back to its own generic list.',
    find: '   if (!strcmp(id, CLAP_EXT_GUI)) return morpheus_gui_extension();',
    replace: '   if (false) return morpheus_gui_extension();',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // A plugin that CLAIMS a window it cannot draw is worse than one that says nothing: hosts handle the
    // claim in a variety of imaginative ways, and Windows and Linux have no panel here yet.
    why: 'Makes the non-Apple stub claim a GUI, so a host is told there is a window that nothing can draw.',
    find: 'extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return nullptr; }',
    replace: 'extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return (const clap_plugin_gui_t *)1; }',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ A CONTROL AND ITS UNITS ARE ONE FACT. Hardcoding decibels was true while an amp was the only chain
    // and became wrong the day a delay arrived: its Time control read "340.00 dB".
    why: 'Puts every parameter back on decibels, so a delay\u2019s Time control is described in units it does not have.',
    // ⚠️ THE DECLARATION HAS TO GO WITH IT. The first version of this mutation replaced only the two lines
    // that USE `unit`, which left `const char *unit = kParams[ix].unit;` standing — so the assertion that the
    // unit reaches the formatter still matched, and the mutation "survived" while proving nothing at all.
    find: "   const char *unit = kParams[ix].unit;\n   if (unit && unit[0]) snprintf(out, capacity, \"%.2f %s\", value, unit);\n   else snprintf(out, capacity, \"%.2f\", value);",
    replace: "   snprintf(out, capacity, \"%.2f dB\", value);",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // The panel writes on the main thread and the audio thread reads. Without the pickup the knob moves and
    // nothing else does, which reads as a broken plugin rather than as a missing line.
    why: 'Stops the audio thread collecting what the panel changed, so a dragged control moves and the sound does not.',
    find: '      if (morpheus_gui_consume(&p->gui_pending[k])) p->value[k] = p->gui_value[k];',
    replace: '      if (false) p->value[k] = p->gui_value[k];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ TWO PLATFORMS GET A PANEL, THE THIRD GETS THE STUB — and a Windows user whose plugin quietly fell
    // back to "no GUI" is exactly the state this change exists to end.
    why: 'Points the Windows build at the fallback stub, so a Windows plugin says it has no GUI and the standalone window comes up empty again.',
    find: 'elseif (WIN32)\n  set(MORPHEUS_GUI_SOURCE Source/PluginGuiWin.cpp)',
    replace: 'elseif (WIN32)\n  set(MORPHEUS_GUI_SOURCE Source/PluginGui.cpp)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ THE X11 PANEL CANNOT BORROW THE HOST'S CONNECTION. Drawing through another thread's Display* is
    // undefined unless the host called XInitThreads(), and a host that did not is a host where this works
    // until the day it does not.
    why: 'Makes the Linux panel reuse the host display connection instead of opening its own, which is undefined behaviour in any host that did not call XInitThreads.',
    find: '   p->dpy = XOpenDisplay(nullptr);',
    replace: '   p->dpy = XOpenDisplay(getenv("DISPLAY"));',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-amp-chain-check.mjs',
    // ⭐ THE BUG THE RUNNER FOUND, AS A MUTATION — the exact line that shipped. A property the stages refactor
    // removed, read at module load, in a script only a dispatched runner ever executes.
    why: 'Puts the ARM chain check back on the parameter property the stages refactor removed, so it throws at load and the chain proof silently stops existing.',
    find: '  const at = chainParams(AMP_CHAIN).findIndex((p) => p.key === key);',
    replace: '  const at = AMP_CHAIN.params.findIndex((p) => p.key === key);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ FOUND BY THE WINDOWS RUNNER, not by reading: `__atomic_*` are GCC/Clang builtins and MSVC has none.
    // Gating the helpers on _MSC_VER is what makes the file compile twice.
    why: 'Removes the MSVC branch of the GUI handover, so the plugin stops compiling with MSVC and only clang and gcc are left.',
    find: '#if defined(_MSC_VER)\n#include <intrin.h>',
    replace: '#if defined(_MSC_VER) && !defined(_MSC_VER)\n#include <intrin.h>',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // ⚠️ THE ARM RENDER CHECK'S SOURCE LIST, AS A MUTATION. It named three generated files by hand, and the
    // day the generator emitted a fourth the link failed with "undefined reference to morpheus_gui_extension".
    why: 'Puts the hand-written source list back into the render check, so a generated file the list does not know about breaks the link.',
    find: '    ...generatedSources(pluginDir),',
    replace: "    join(pluginDir, 'Source', 'Plugin.cpp'),\n    join(pluginDir, 'Source', 'PluginEntry.cpp'),\n    join(pluginDir, 'Source', 'ModelData.cpp'),",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ THE ORDER IS DATA ONLY IF THE DSP WALKS IT. Emitting the table and then reading the COMPILED default
    // is the exact shape of "a table nobody walks": every other proof in the repository passes, because every
    // one of them renders the default order — where the two tables are identical by construction.
    why: 'Walks the compiled default instead of the running order, so a saved chain order is ignored.',
    find: '            for (unsigned char s = 0; s < p->model_at; ++s) {\n               x = morpheus_stage_dsp(p, c, x, (int)p->stage_order[s]);\n            }',
    replace: '            for (unsigned char s = 0; s < p->model_at; ++s) {\n               x = morpheus_stage_dsp(p, c, x, (int)kMorpheusDefaultOrder[s]);\n            }',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ AND A REORDER MUST TAKE EFFECT BETWEEN BLOCKS. Writing a loaded order straight into the table the
    // audio thread is walking would let a reorder land mid-block — half the block on one order, half on
    // another — which is the one outcome a permutation must never produce. Nothing would report it.
    why: 'Applies a loaded order directly to the running table instead of handing it over, so a reorder can land mid-block.',
    find: '   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) p->stage_order_pending[s] = order[s];\n   morpheus_gui_publish(&p->stage_order_pending_flag);',
    replace: '   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) p->stage_order[s] = order[s];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ THE PIVOT RULE, AS A MUTATION. The amp model and the cabinet are the pivot — Rob's decision — and the
    // output is applied on the plugin's own output, so a block after it is processed by nothing. Letting any
    // permutation through would still be a legal PERMUTATION, which is why the count check above cannot see it
    // and this needs its own assertion.
    // ⚠️ THE PIVOT RULE, AS A MUTATION — AND IT MUTATES THE RULE ITSELF, NOT A CALL SITE. Since Stage 2 the
    // rule is enforced at TWO doors (a drag and a loaded session), so a mutation that broke one call would
    // leave the other enforcing it and the guard would stay green. Breaking the function every door asks is
    // the mutation that actually tests the claim.
    why: 'Says every block may move, so the amp model, the cabinet and the output can be dragged anywhere.',
    find: '   return (strcmp(kind, "model") && strcmp(kind, "cab") && strcmp(kind, "level")) ? 1 : 0;',
    replace: '   return 1;   // every block may move',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ A DRAG THAT THE PANEL NEVER LEARNS ABOUT. The running order changes and the audio follows it, but the
    // block column keeps drawing the order the plugin was BUILT with — so the drag looks like it did nothing
    // while the sound says otherwise. The audio proofs all pass, because the audio is right.
    why: 'Stops telling the panel about a new order, so the sound changes and the block column does not.',
    find: '   morpheus_gui_publish(&p->stage_order_pending_flag);\n   // …and the PANEL is told, so the column redraws in the new order rather than showing the drag undone.\n   morpheus_gui_order_names_set(p->stage_order_pending);',
    replace: '   morpheus_gui_publish(&p->stage_order_pending_flag);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ AND A SAVED SESSION WOULD REOPEN DRAWING THE WRONG CHAIN. This is the quieter half of the pair above:
    // nothing is dragged, so nothing looks broken — the project simply comes back showing the compiled order
    // while playing the saved one.
    why: 'Leaves the panel on the compiled order when a session loads a saved one.',
    find: '   morpheus_gui_publish(&p->stage_order_pending_flag);\n   // …and the PANEL is told, so a session that reopens with a saved order DRAWS that order rather than the one\n   // the plugin was compiled with. A panel showing a different chain from the one playing is worse than no\n   // panel at all.\n   morpheus_gui_order_names_set(p->stage_order_pending);',
    replace: '   morpheus_gui_publish(&p->stage_order_pending_flag);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⚠️ A DRAG THE HOST NEVER HEARS ABOUT. The order changes and sounds right for this session, and the host is
    // never told the state is dirty — so it saves the order the plugin was built with and the reorder is gone
    // the moment the project is reopened. Nothing in the audio can see this; only the host can.
    why: 'Stops marking the host state dirty, so a drag survives the session but not the save.',
    find: '   if (hs && hs->mark_dirty) hs->mark_dirty(p->host);',
    replace: '   (void)hs;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ THE ONE PREDICATE THAT TELLS A CHOICE FROM A SWITCH. The rig's selectors are DISCRETE, like a block's
    // On/Off switch, so CLAP's stepped flag cannot tell them apart — the count can. A row that answered "not a
    // choice" would draw a three-way selector as a two-state pill, which is a control that lies about what it
    // does, and the sound would still be right: nothing but the picture would show it.
    why: 'Draws every stepped row as a switch again, so a capture selector becomes an On/Off pill.',
    find: 'static int morpheus_gui_is_choice(const morpheus_gui_row_t *row) { return row->choices > 1; }',
    replace: 'static int morpheus_gui_is_choice(const morpheus_gui_row_t *row) { (void)row; return 0; }',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ AND THE COUNT MUST COME FROM THE PLUGIN. Answering it from anywhere else — a convention, CLAP's
    // stepped flag, a guess — is how the panel and the audio come to disagree about how many captures a rig
    // has, which is the failure the whole rig stage exists to prevent.
    why: 'Never asks the plugin how many choices a parameter has, so the panel cannot know a rig has three captures.',
    find: '      row->choices = morpheus_gui_choice_count(info.id);',
    replace: '      row->choices = 0;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ THE BADGE, AND THE LOOP THAT DRAWS IT. The check asserts the loop's BOUND, not that the array is
    // named somewhere in the file — the array's name is inside the loop body, so a loop that ran zero times
    // would have satisfied the first version of it. A backend with an empty corner compiles and sounds
    // identical, which is why nothing else can see this.
    why: 'Draws no badge on the Mac panel: the loop runs zero times, so the corner is empty and nothing else changes.',
    find: '  // ── THE BADGE, and the wordmark under it ──────────────────────────────────────────────────────────────\n  // The geometry is in the shared header so the three backends draw one picture; what is here is the four\n  // primitives it is made of. It sits in the space the controls do not reach, which is why the panel\'s fixed\n  // height is a gift rather than a compromise.\n  for (size_t bi = 0; bi < MORPHEUS_BADGE_PRIMITIVES; ++bi) {',
    replace: '  for (size_t bi = 0; bi < 0; ++bi) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // ⚠️ AND A GLOB ALONE IS NOT ENOUGH. Globbing every .cpp AND .mm fed the COCOA panel to gcc on Linux,
    // which answered "cannot execute 'cc1objplus'" — there is no Objective-C++ front end there. The rule has
    // to pick the platform's own panel, which means it is written twice (cmake and tools) and cross-checked.
    why: 'Stops the tools filtering by platform, so they hand the Cocoa panel to a compiler that has no Objective-C++ front end.',
    find: '    .filter((f) => !PANEL_FILES.includes(f) || f === chosen)',
    replace: '    .filter((f) => true)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-nam-render-check.mjs',
    // ⚠️ THE THIRD ROUND OF THE SAME MISTAKE. Sources, then panels, then LIBRARIES — the runner answered this
    // one with "undefined reference to `XUnmapWindow'". Dropping X11 is what a hand-written link line looks
    // like when the panel grows a dependency.
    why: 'Stops the tool linking X11 for the Linux panel, so the offline host fails to link on the runner with undefined Xlib symbols.',
    find: "  linux: ['-lX11', '-pthread'],",
    replace: "  linux: [],",
  },
  // ── the task pre-flight (2026-10-06) ──────────────────────────────────────────────────────────────────
  // ⭐ THE CHECK THAT MATTERS MOST IN THIS FILE, as a mutation. The same audio under two labels is the mistake
  // that produces a GOOD number — a model tested on what it memorised reports 99% and everything downstream
  // agrees with it — so a pre-flight that stops reporting it must go red.
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/dataset.js',
    why: 'Stops the pre-flight noticing that the same audio sits under two labels, so the leak that inflates every score goes unreported.',
    find: '    if (labels.length > 1) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/dataset.js',
    // A class with four clips cannot be learned and cannot even be measured — the test set holds one of them,
    // or none. Refusing it is the whole reason a pre-flight exists.
    why: 'Accepts a class too small to learn, so the first model is trained on a label it can never get right.',
    find: '    if (list.length < c.minClipsPerLabel) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/dataset.js',
    // Silent clips are the quiet one: nothing about the file is broken, so nothing else notices, and the model
    // learns that silence belongs to whichever label it was filed under.
    why: 'Stops silent clips being refused, so a class learns that silence is part of its sound.',
    find: '  if (silent) {',
    replace: '  if (false) {',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/registry.js',
    // A family with no measurement is a family nobody can check — and the registry validator is the only thing
    // standing between a half-written entry and a pipeline built on it.
    why: 'Lets a family into the registry with no measurement, so a model can be built and shipped with nothing able to say whether it works.',
    find: "    if (!Array.isArray(f?.measure) || !f.measure.length) problems.push(`${at}: names no measurement, so nothing can say whether it works`);",
    replace: '    // measurement check removed',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/trainProject.js',
    // ⭐ THE ORDER OF THE GATE, as a mutation. Moving the check into main() puts it AFTER the scientific
    // imports, so a user who has not installed the requirements is told about numpy instead of about their
    // data — on the one run where the answer about their data matters most. The first version of this file
    // did exactly that, and it was found by trying to test it.
    why: 'Moves the pre-flight check after the scientific imports, so a missing dependency hides the verdict about the dataset.',
    find: 'VERDICT = load_preflight(os.path.dirname(os.path.abspath(__file__)))',
    replace: 'VERDICT = {"ok": True, "issues": []}',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'server/src/lib/tasks/trainProject.js',
    // ⚠️ THE RECORDING RULE IS THE SPLIT. Without it the loader splits by CLIP, windows of one take land on
    // both sides of the line, and the score measures memory.
    why: 'Removes the recording rule from the loader, so the split is by clip and near-identical windows are tested on.',
    find: 'def recording_of(path):',
    replace: 'def renamed_recording_of(path):',
  },
  {
    guard: 'verify-task-models.mjs',
    file: 'scripts/task.mjs',
    // The verdict is written INTO the project — that is what makes the pre-flight a gate rather than advice.
    why: 'Stops the scaffold writing the dataset verdict into the project, so the trainer has nothing to refuse on.',
    find: 'const project = trainingProject(familyId, verdict);',
    replace: 'const project = trainingProject(familyId, null);',
  },
  {
    guard: 'verify-pairing.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // The live store's `/shop/` shipped with no canonical, no description and no social tags because
    // `emit_head()` returned early on anything that was not a single post. The structural check is what CI can
    // hold; the behaviour is asserted in the hand-run Playground harness.
    why: 'Makes the head singular-only again, which is how every archive on the live store came to have no canonical and no description.',
    find: '\t\t\tif ( self::is_archive_view() ) {',
    replace: '\t\t\tif ( false ) {',
  },
  {
    guard: 'verify-pairing.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // The shop is a POST-TYPE archive with no term, so the description chain had nothing to say and `/shop/`
    // served no meta description at all. The page WooCommerce serves that archive from is the one place the copy
    // is written; pointing at a different page is the realistic version of getting this wrong.
    why: 'Points the shop description at the CART page instead of the shop page, so `/shop/` describes itself with the wrong page\'s words.',
    find: "\t\t$id = (int) wc_get_page_id( 'shop' );",
    replace: "\t\t$id = (int) wc_get_page_id( 'cart' );",
  },
  {
    guard: 'verify-pairing.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // ⭐ THE LIVE DEFECT: a category description written in the page builder is the shortcode
    // `[html_block id="2419"]`, and the strip-only version served those literal characters as the meta
    // description of three live category pages. Not rendering it is exactly what shipped.
    why: 'Stops rendering shortcodes, so a page-builder description reaches the meta tag as `[html_block id="2419"]` — the live defect.',
    find: '\t\t\t$raw = do_shortcode( $raw );',
    replace: '\t\t\t$raw = $raw;',
  },
  {
    guard: 'verify-pairing.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // `strip_shortcodes()` only removes REGISTERED shortcodes — it builds its pattern from `$shortcode_tags` — so
    // without this sweep an unregistered one passes through and lands in the tag. The harness caught exactly this
    // on the first run of the assertion: the registered case passed and the unknown one did not.
    why: 'Drops the sweep for UNREGISTERED shortcodes, so one from a deactivated plugin reaches the meta tag as brackets.',
    find: "\t\t\t$raw = preg_replace( '/\\[[a-z0-9_-]+(?:\\s[^\\]]*)?\\]/i', ' ', $raw );",
    replace: '\t\t\t$raw = $raw;',
  },
  {
    guard: 'verify-pairing.mjs',
    file: 'scripts/lib/wpPluginRelease.mjs',
    // ⭐ THE BUG THAT COST ROB A ROUND TRIP: a plugin change with no version bump is published, hashed and
    // served, and NO site is ever offered it — because every update channel compares versions. This predicate is
    // the only thing that can see it, and a version of it that always says "fine" is the bug it exists to catch.
    why: 'Makes the deliverability check always pass, so a plugin change without a version bump ships silently and reaches nobody.',
    find: '  return `the plugin changed but the version did not (still ${next.version}), so no site will ever be offered it`;',
    replace: '  return null;',
  },
  // ── the demo (2026-10-06) ───────────────────────────────────────────────────────────────────────────────
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // The demo is the shop window, and it has twice been published as something narrower than the release page
    // described. Losing a block here is how that happens.
    why: 'Takes the delay out of the demo board, so the free download is a rig without the effect people would notice missing.',
    find: "  const kinds = ['input', 'gate', 'drive', 'tone', 'model', 'cab', 'delay', 'spring', 'output'];",
    replace: "  const kinds = ['input', 'gate', 'drive', 'tone', 'model', 'cab', 'spring', 'output'];",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/lib/pluginDemo.mjs',
    why: 'Seeds a manifest with no board, which generates the single-Gain plugin while the release page still describes the whole rig.',
    // ⚠️ NO ESCAPES IN THIS ONE. The first version ended at the `\n` of the template literal, and a `\n` inside
    // a single-quoted string in THIS file is a real newline — so the find matched nothing and the mutation was
    // reported STALE, which is a claim that quietly stops being checked. The shorter string cannot drift that way.
    // ⚠️ AND IT NAMES THE RIG TOO, so it still matches after the demo gained `models`/`cabs`: a find of just the
    // board would have gone stale the moment the manifest grew, which is the same silent-stale failure again.
    find: 'name, board: boardJson(DEMO_BOARD), models: DEMO_RIG.models, cabs: DEMO_RIG.cabs,',
    replace: 'name, models: DEMO_RIG.models, cabs: DEMO_RIG.cabs,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/audio-plugin-windows-runner-build.mjs',
    // One of the three runners writing its own manifest is exactly how macOS and Windows shipped an amp while
    // Linux shipped a gain knob, under one release tag.
    why: 'Puts one runner back on its own hand-written manifest, which is how the three platforms came to publish different products.',
    find: "  seed.push({ path: 'morpheus.plugin.json', content: demoManifest() });",
    replace: "  seed.push({ path: 'morpheus.plugin.json', content: `${JSON.stringify({ name: 'Morpheus Plugin', chain: 'amp' }, null, 2)}\n` });",
  },
  // ── the rig's opening member (2026-10-08) ───────────────────────────────────────────────────────────────
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/rig.js',
    // ⚠️ THE WHOLE FLAG, AT ITS ONE VALIDATOR. `rigEntry` is the single answer to "is this a rig entry", so a
    // `default` it stops normalising is a mark that never reaches the finder — and the plugin opens on the
    // first member again while the manifest still says otherwise. The demo's Speaker row (U87, second of four)
    // is the visible difference: it would go back to `0.0`.
    why: 'Drops `default: true` at the single entry validator, so a rig that names its opening member opens on the first one instead.',
    find: '    if (entry.default === true) out.default = true;',
    replace: '    if (false) out.default = true;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⚠️ THE EXACT LINE THIS CHANGE EXISTS TO CHANGE. `def: 0` — the hardcoded opening member — is what made
    // an opening sound and a list order the same fact.
    why: 'Hardcodes the Capture selector back to index 0, so the member a project marks as its opening one is ignored.',
    find: 'def: rigDefaultIndex(m)',
    replace: 'def: 0',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/namPlugin.js',
    // A mark that stops at the finder never reaches `rigSelectors`, so the plugin and the rig editor disagree
    // about which capture opens — the app marks one, the build opens on another.
    why: 'Stops the capture finder carrying the opening-member mark, so the editor marks one capture while the plugin emits another.',
    find: '  const marked = isDefault === true ? { default: true } : {};',
    replace: '  const marked = {};',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/cabIr.js',
    // The same claim on the other half of the rig: the mic.
    why: 'Stops the cabinet finder carrying the opening-member mark, so the marked mic is silently not the one the plugin opens on.',
    find: '  const marked = isDefault === true ? { default: true } : {};',
    replace: '  const marked = {};',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/rigProject.js',
    // The app's view is the only place a user can SEE which member opens, so losing the mark here is an editor
    // that cannot say what the plugin will do — while every emitted row stays correct.
    why: 'Drops the opening-member mark from the rig view, so the editor cannot show which capture the plugin opens on.',
    find: '      ...(r.default === true ? { default: true } : {}),',
    replace: '      ...(r.default === true ? {} : {}),',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/board.js',
    // ⚠️ AND THE SIGNAL-PATH DIALOG IS THE SECOND SURFACE. `boardView` marks the opening member from the rig
    // list it is handed; without this it falls back to index 0 and draws the first as the opening one, while
    // the RIG dialog and the plugin both say otherwise.
    why: 'Marks the first member as the one the plugin opens on in the signal-path dialog, whatever the rig marked.',
    find: '    const def = rigDefaultIndex(list);',
    replace: '    const def = 0;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'scripts/lib/pluginDemo.mjs',
    // ⚠️ THE DEMO'S OPENING MIC, AS A MARK. U87 is second in the captured order, so losing the mark is a
    // Speaker row defaulting to `0.0` (the 545) while the notice and the release page say U87.
    why: 'Takes the default mark off the demo\'s U87, so the free download opens on the 545 while its own notice says it opens on the U87.',
    find: "name: 'U87', default: true },",
    replace: "name: 'U87' },",
  },
  // ── the cabinet capture (2026-10-06) ────────────────────────────────────────────────────────────────────
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/irCapture.js',
    // Forgetting the conjugate turns the deconvolution into a correlation: the sweep is still "removed" in the
    // sense that something plausible comes out, and the something is not the cabinet.
    why: 'Divides by the sweep instead of its conjugate, so the capture correlates with the sweep rather than undoing it.',
    find: '    outIm[i] = -im[i] / p;',
    replace: '    outIm[i] = im[i] / p;',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/irCapture.js',
    // The window is where the response IS, measured. Taking the first taps of the buffer instead gives every
    // capture the same offset error, which is a cabinet that is subtly the wrong shape and never silent.
    why: 'Takes the impulse response from the start of the buffer rather than from where the response actually is.',
    find: '  for (let i = 0; i < taps; i++) ir[i] = re[(start + i) % size];',
    replace: '  for (let i = 0; i < taps; i++) ir[i] = re[i % size];',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/irCapture.js',
    why: 'Stops refusing a silent take, so a muted microphone becomes a cabinet that measures perfectly and sounds like nothing.',
    find: '  if (!(peak > 0)) {',
    replace: '  if (false) {',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginTemplate.js',
    // ⭐ THE BUG THAT SHIPPED: a static library drops the engine's self-registering translation units, so the
    // WaveNet parser is never registered and the plugin runs as a gain stage while its proof lists six
    // parameters. Found by building the AU and opening it, not by any gate.
    why: 'Puts the engine back in a STATIC library, which is how the model silently stopped loading in every plugin ever built.',
    find: 'add_library(morpheus_plugin-impl OBJECT Source/Plugin.cpp Source/ModelData.cpp Source/CabIr.cpp',
    replace: 'add_library(morpheus_plugin-impl STATIC Source/Plugin.cpp Source/ModelData.cpp Source/CabIr.cpp',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // The demo's defaults are a MEASURED decision: with the blocks' own defaults a delay and a reverb are mixed
    // in, and the render proof that the plugin plays its model fails — correctly, at -4.3 dB.
    why: 'Puts the demo back on the blocks\' own defaults, so the download arrives distorted, echoing and reverberating.',
    find: "  const values = { delay: { delay_mix: 0 }, spring: { spring_mix: 0 } };",
    replace: "  const values = {};",
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/irCapture.js',
    // The fold: without it a response 33 samples EARLY reads as 524255 samples late, and a perfect capture is
    // refused. This is the arithmetic bug that was in the tool for one revision.
    why: 'Stops folding the circular delay to the nearest zero, so a response a few samples early reads as a whole buffer late.',
    // ⚠️ THE WRAP IS THE BUG THAT WAS THERE, and the first version of this mutation (`- sweepAt`, unfolded)
    // produced the right answer for the unit's numbers — a mutation that changes nothing is not a mutation.
    find: '  return ((latencySamples - sweepAt + size / 2) % size) - size / 2;',
    replace: '  return ((latencySamples - sweepAt) % size + size) % size;',
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'scripts/audio-capture.mjs',
    // A flag the CLI does not spell correctly is accepted, documented, and silently ignored — which is how three
    // of them shipped in the first version of the cabinet capture.
    why: 'Spells one flag without its dashes, so the value is accepted on the command line and silently ignored.',
    find: "const f1 = num('--f1', IR_SWEEP.f1);",
    replace: "const f1 = num('f1', IR_SWEEP.f1);",
  },
  {
    guard: 'verify-audio-capture.mjs',
    file: 'server/src/lib/audio/irCapture.js',
    why: 'Locates the sweep by the loudest part of the take, which is useless for a sweep whose envelope is flat by design — the rule that refused a perfect capture.',
    find: '  const sweepAt = locateSweep(recorded, sweep, size).at;',
    replace: '  const sweepAt = recorded.length > 0 ? 0 : 0;',
  },
  // ── VERIFY and PACK (2026-10-06) ────────────────────────────────────────────────────────────────────────
  // ⭐ THE LADDER'S TWO MIDDLE STAGES ARE THE ONES A PERSON BELIEVES WITHOUT CHECKING: a card that says 94%, and
  // a pack report that says "8 bits, no loss". Each claim below gets an edit that makes it false.
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/classifierModel.js',
    // The window is the one convention a library would have chosen silently and wrongly: `torch.hann_window` is
    // PERIODIC, `dsp.js`'s `hann` is SYMMETRIC, and using the wrong one windows every frame differently forever.
    why: 'Windows the STFT symmetrically instead of periodically, which is a front end that is subtly not the one the model trained on.',
    find: '  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));',
    replace: '    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/classifierModel.js',
    // Without this the runtime SILENTLY computes something other than what the container asked for — the failure
    // mode the placeholder ternary had before it was removed.
    why: 'Lets the reader compute a window it does not implement instead of refusing, which is the silent-wrong-answer case.',
    find: "  if (fe.window !== 'hann-periodic') throw new Error(`this runtime computes the periodic Hann window, not \"${fe.window}\"`);",
    replace: "  if (false) throw new Error(`this runtime computes the periodic Hann window, not \"${fe.window}\"`);",
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/classifierModel.js',
    // Several scales without the block size is either an invalid container or a scale per code, and the count
    // `modelBytes` reports depends on this line.
    why: 'Drops the block size from a per-channel tensor, so its codes and its scales no longer line up.',
    file: 'server/src/lib/tasks/classifierContainer.js',
    find: '    t.block_size = values.length / scales.length;',
    replace: '    t.block_size = undefined;',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/classifierModel.js',
    why: 'Dequantizes with one scale per code instead of one per channel, so a weight comes back on the wrong grid.',
    find: '    const block = t.block_size > 0 ? t.block_size : 1;',
    replace: '    const block = 1;',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/verifyModel.js',
    why: 'Puts the probe back to a bare frame count, so a front end that drifted in every other field is not compared.',
    find: '  const drift = compareProbe(probe, frontEndProbe(fe));',
    replace: '  const drift = compareProbe(probe, { ...frontEndProbe(fe), ...probe });',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/classifierContainer.js',
    // The probe is what catches a drift whose cost is invisible in the accuracy. A container built without one
    // turns the strongest assertion in VERIFY into a warning.
    why: 'Stops containers carrying a front-end probe, so a drift that costs no accuracy cannot be seen at all.',
    find: '      front_end: { ...fe, ...(probe ? { probe: frontEndProbe(fe) } : {}) },',
    replace: '      front_end: { ...fe },',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/verifyModel.js',
    why: 'Stops refusing a container whose front end no longer matches the one that trained it — the drift that ships quietly.',
    find: '    if (drift.length) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/verifyModel.js',
    why: 'Stops checking the card\'s number against the container, which leaves the one claim the stage exists to reproduce unverified.',
    find: '    if (accuracy < claimed - tolerance) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/verifyModel.js',
    why: 'Stops refusing a model that cannot beat answering the commonest label, which is how a 90%-one-class dataset looks like success.',
    find: '  if (facts.margin < margin) {',
    replace: '  if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/verifyModel.js',
    why: 'Reports a clip the card names but the dataset does not have as merely unscored, so a container with missing evidence reads as a container that passed.',
    find: "  if (unreadable.length) {\n    issues.push({",
    replace: "  if (false) {\n    issues.push({",
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/packModel.js',
    why: 'Leaves the packed container quoting the float model\'s accuracy, which is a lie that reads as diligence.',
    find: '  if (packed.card) {',
    replace: '  if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/packModel.js',
    why: 'Packs at any width a caller asks for instead of the ones the family measured, so the report is about a width nobody chose.',
    find: '  if (!allowed.includes(bits)) {',
    replace: '  if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/registry.js',
    why: 'Lets a family declare no bit width, so a trained model has no size to be measured against and PACK has nothing to offer.',
    find: '    if (!Array.isArray(f?.quantise?.bits) || !f.quantise.bits.length) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/trainProject.js',
    // The generated project is the half of the contract that cannot be run here (no numpy, no torch), so its
    // agreement with the reader is asserted on the TEXT — and `HOP` is the number a front-end drift starts with.
    why: 'Writes a different hop into the training project than the runtime computes with, which degrades every embedded model silently.',
    find: 'HOP = ${FRONT_END.hop}',
    replace: 'HOP = 512',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/trainProject.js',
    why: 'Stops export.py putting the front-end probe in the container, which is the difference between a checkable container and one that must be taken on trust.',
    find: '            "front_end": {**FRONT_END, "probe": front_end_probe()},',
    replace: '            "front_end": {**FRONT_END, "probe": {}},',
  },
  {
    guard: 'verify-task-ladder.mjs',
    file: 'server/src/lib/tasks/trainProject.js',
    // A split that drifts between train.py and evaluate.py means the "test" clips are clips the model trained on.
    why: 'Gives evaluate.py its own split fractions instead of the trainer\'s, so the test set can be data the model has seen.',
    find: '# the output.\nFRACTIONS = (${family.data.split.train}, ${family.data.split.validation}, ${family.data.split.test})',
    replace: 'FRACTIONS = (0.9, 0.05, 0.05)',
  },
  // ── the board (2026-10-05) ─────────────────────────────────────────────────────────────────────────────
  // ⭐ A BOARD IS THE FIRST THING HERE A USER ARRANGES, and it fails in two ways nothing else can see: an
  // order that is drawn but not emitted, and an order that renumbers the controls a host has automated.
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // ⭐ THE CORRUPTION, IN THE DOMAIN THE BOARD ADDED. Sorting the parameters by the arrangement instead of
    // by the block that owns them renumbers them the moment a user drags a block: the ids stay unique, the
    // plugin builds, the audio is right, and a host's automation lane now drives a different control.
    // (Repointed when identity became CREATION order rather than a fixed table of known keys — the delay made
    // the table wrong, because a kind that sorts into the middle of it renumbers everything after it.)
    why: 'Identifies the controls by the arrangement instead of by the block that owns them, so reordering a block renumbers every parameter a host has automated.',
    find: '    return ownerOf(a.key) - ownerOf(b.key);',
    replace: '    return 0;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // A BLOCK SWITCHED OFF KEEPS ITS CONTROL AND ITS DEFAULT. Dropping the mark is the "the plugin ignores
    // what I drew" failure: the board says a block is off, the plugin opens with it on, and only the sound
    // says which of the two is right.
    why: 'Ignores the enabled flag, so a block switched off in the editor opens switched on.',
    find: '    if (item.enabled === false) stage.bypass = true;',
    replace: '    if (false) stage.bypass = true;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⭐ THE SAVED STATE IS THE SWITCH'S DEFAULT, and this is the line that carries it. `def: 1` is the
    // version that looks harmless — every block on out of the box — and is exactly the demo shipping a drive,
    // a delay and a spring all engaged, which is the measured -4.3 dB that put the default patch under a check.
    why: 'Ignores the build-time state, so a block switched off in the editor opens switched on.',
    find: '        def: stage.bypass ? 0 : 1,',
    replace: '        def: 1,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // THE SWITCH ITSELF. `if (false)` leaves every block permanently in the path: the control moves, the host
    // stores it, a panel redraws — and the audio never changes. Nothing else here notices, because every
    // default is untouched and every null still lands where it did.
    why: 'Makes the crossfade unconditional, so a block switched off is still fully in the signal path.',
    find: '    `            if (on_${key} < 1.0) x = dry_${key} + on_${key} * (x - dry_${key});`,',
    replace: '    `            if (false) x = dry_${key} + on_${key} * (x - dry_${key});`,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/ampChain.js',
    // ⭐ THE PANEL'S BLOCK ORDER, AS A MUTATION. An empty table is not a crash: the panel falls back to
    // grouping by first appearance in the parameter list and still draws every control — in an order that is
    // not the order anything runs in. That is exactly what shipped, and only a photograph caught it.
    why: 'Stops telling the panel the signal order, so the blocks draw in the order their parameters happen to be listed in.',
    find: '  const names = (chain.stages || []).map(stageLabel);',
    replace: '  const names = [];',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⭐ CLAP'S OWN FLAG, NOT A NAME CONVENTION. Reading it as 0 draws every control as a continuous track —
    // including a block's switch and, later, a rig's capture selector — so the panel and the host disagree
    // about what a control IS while both agree about what it is set to.
    why: 'Draws every control as a track, so a discrete switch is a slider that only lands on its two ends.',
    find: 'row->stepped = (info.flags & CLAP_PARAM_IS_STEPPED) ? 1 : 0;',
    replace: 'row->stepped = 0;',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // ⚠️ A SWITCH HAS NO ENTRY IN ITS BLOCK'S OWN CONTROL TABLE, so an owner lookup that only reads those
    // tables ranks it 0 and sorts it to the FRONT. Which is not a cosmetic ordering bug: `paramsCpp` derives
    // the ids from the position, so every control after it moves — the corruption `instanceId` exists for.
    why: 'Loses the owner of a block\u2019s switch, so reordering the board moves the switches\u2019 parameter ids.',
    find: '      return keys.includes(key) || stageOnKey(st) === key;',
    replace: '      return keys.includes(key);',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/audioPluginProject.js',
    // ⭐ THE FILE AND THE BLOCK ARE DIFFERENT QUESTIONS. Hard-wiring the flag back to true is the state the
    // generator was in before the board: a project whose model block was removed still runs the model, so the
    // editor and the plugin disagree and only the audio says so.
    why: 'Keeps the model in the signal path however the board is arranged, so removing the Amp model block changes the picture and nothing else.',
    find: "    modelInPath: useBoard ? chainHas(chain, 'model') : true,",
    replace: '    modelInPath: true,',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // A 500 WHERE A 400 BELONGS. The id scan runs on the raw save body, before anything has validated it, so
    // reading `it.instanceId` instead of `it?.instanceId` turns a malformed request into a crash.
    why: 'Reads the item id through a missing entry, so a malformed save crashes the route instead of being refused.',
    find: 'Math.max(m, Number(it?.instanceId) || 0)',
    replace: 'Math.max(m, Number(it.instanceId) || 0)',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/board.js',
    // ONE OF EACH, ENFORCED RATHER THAN ASSUMED. Two blocks of a kind would share their parameter keys, which
    // is the collision the instance ids cannot fix yet — so the second one has to be refused, loudly.
    why: 'Accepts two blocks of the same kind, which would emit two controls with the same parameter id.',
    find: '    if (ONE_OF_EACH && seenKinds.has(item.kind)) {',
    replace: '    if (false && seenKinds.has(item.kind)) {',
  },
  {
    guard: 'verify-jarvis-stream.mjs',
    file: 'src/lib/jarvisStream.js',
    why: 'Drops the streamed fragments, so the deck shows an empty bubble with a live clock while the words never appear — the exact complaint ("it doesnt look like its doing anything") this reducer exists to answer.',
    find: '    return { ...live, text: live.text + evt.text };',
    replace: '    return live;',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/rigProject.js',
    // ⚠️ THE FORMAT THE RIG EDITOR EXISTS TO GET RIGHT. `resolveModels` KEEPS a capture it cannot use so its
    // warning can surface, and the emitter DROPS it — so a view built from the manifest instead of from the
    // usable filter offers a selector position that plays nothing. That is a control a player can pick and
    // hear no change from, and nothing in the generated C++ or the audio proofs can see the app do it.
    why: 'Offers every capture in the rig including the unusable ones, so the app lists a member the plugin will not play.',
    // Repointed when the selector list began carrying the opening-member mark: the find names the whole line so
    // a further field on it cannot leave this mutation silently STALE (H17).
    find: '    models: models.members.filter((m) => m.usable).map((m) => ({ path: m.path, name: m.name, ...(m.default === true ? { default: true } : {}) })),',
    replace: '    models: models.members.map((m) => ({ path: m.path, name: m.name, ...(m.default === true ? { default: true } : {}) })),',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/rigProject.js',
    // A save that "succeeds" while the finder drops what it named is the worst of both: the user is told it
    // saved, and the next compile builds a shorter rig. The route refuses rather than repairs for this reason.
    why: 'Accepts a capture path the project does not hold, so a save is reported as saved and the next compile silently drops it.',
    find: '      if (!present(e.path)) { errors.push(`${e.path} is not a file in this project.`); continue; }',
    replace: '      if (false) { errors.push(`${e.path} is not a file in this project.`); continue; }',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/audioPluginProject.js',
    // ⚠️ THE HISTORICAL BUG, AS A MUTATION. The board route grew this writer because regenerating the manifest
    // from `readManifest` silently drops every key the generator does not know about — and this file is
    // documented as the user's to edit. The rig route shares the writer, so dropping this line breaks both.
    why: 'Regenerates the manifest from the normalised read instead of editing the user\'s file, so any key the user added is silently deleted by a save.',
    find: '        return `${JSON.stringify(apply(parsed), null, 2)}\\n`;',
    replace: '        return `${JSON.stringify(apply(manifest), null, 2)}\\n`;',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/board.js',
    // ⭐ THE DIVERGENCE STAGE 5 IS ABOUT, AS ONE LINE. The plugin's panel draws a Capture/Speaker choice under
    // the Amp model and Cabinet blocks; without this the app draws both blocks with no controls at all, so the
    // two surfaces describe different plugins while every other check stays green.
    why: 'Stops the board editor naming the rig\'s captures and mics, so the app draws two blocks the plugin gives controls to.',
    find: '        })), selectorFor(it.kind)].filter(Boolean),',
    replace: '        }))].filter(Boolean),',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/cabinetFile.js',
    // ⚠️ THE OTHER BUG THE RENDER CHECK FOUND. A mic added through the app keeps its audio in storage with a
    // preview line in `content`; the rig view decodes every `.wav` to say whether it will convolve, so a view
    // built without hydration reports every uploaded mic unusable and the Speaker row disappears — while the
    // compile, which hydrates, bakes it in. This is the line that turns stored bytes into content.
    why: 'Leaves a stored cabinet\'s preview text in place instead of its bytes, so a mic uploaded through the app reads as unusable in the editor that added it.',
    find: '      out.push({ ...file, content: Buffer.from(bytes).toString(\'base64\'), encoding: \'base64\', file_url: undefined });',
    replace: '      out.push({ ...file, content: file.content });',
  },
  {
    guard: 'verify-rig.mjs',
    file: 'server/src/lib/board.js',
    // ⚠️ THE BUG THE RENDER CHECK FOUND, AS A MUTATION. `selectorFor` first read "models for a model, cabs for
    // everything else", so the Speaker row was drawn under Input, the gate and the tone stack as well — a
    // picture of three cabinets in a path that has one. Every other check in this file still passed.
    why: 'Lets every block claim the rig\'s mic list, so the board editor draws a Speaker row under blocks that have no speaker.',
    find: '    if (kind !== \'model\' && kind !== \'cab\') return null;',
    replace: '    if (false) return null;',
  },
  {
    guard: 'verify-seo.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // ⚠️ THE LIVE DEFECT OF 2026-10-08, AS A MUTATION. `emit_schema()` appended `site_entity_nodes()` — a LIST
    // of two — as ONE element, so every page of every site emitted `[{…page…},[{…Organization…},{…WebSite…}]]`.
    // Nothing could see it: all three `@type` substrings are present, and a nested array is valid JSON, so the
    // harness's substring and "parses" assertions stayed green. The rendered shape is now asserted by
    // tests/harness-noyoast.php — proven red on this exact mutation (175/177, the two failures being the shape
    // assertions) — and this entry pins the same claim in CI, which has no PHP.
    why: 'Puts the site-entity list back as ONE element of the node array — the nested JSON-LD that shipped on every page, which substring and parse assertions cannot see.',
    find: '\t\t$nodes = array_merge( array( $node ), self::site_entity_nodes() );',
    replace: '\t\t$nodes = array( $node );\n\t\t$site  = self::site_entity_nodes();\n\t\tif ( $site ) {\n\t\t\t$nodes[] = $site;\n\t\t}',
  },
  {
    guard: 'verify-plugin-uninstall.mjs',
    file: 'wp-plugin/morpheus/uninstall.php',
    // The residue bug itself, as one line: dropping a `delete_option` is exactly how five stores
    // survived a delete-then-reinstall (SEO templates, fix history, pairing record, traffic toggle)
    // while the file still looked like a complete uninstall.
    why: 'Drops one option from the uninstall list, so deleting and reinstalling the plugin inherits the previous site\'s SEO templates.',
    find: "delete_option( 'morpheus_seo_defaults' );  // Morpheus_SEO::DEFAULTS_OPTION\n",
    replace: '',
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'wp-plugin/morpheus/includes/class-rest.php',
    // `Morpheus_Traffic::public_status()` was written to be the module's public /status half and had no
    // caller, so the capability was invisible to the one payload that answers "what can this build do?"
    // while every sibling module appeared there. Dropping the key is exactly the state before the fix.
    why: 'Removes the traffic key from the /status payload, leaving the module invisible to the surface that reports what a build can do.',
    find: "\t\t\t'traffic'    => class_exists( 'Morpheus_Traffic' )\n\t\t\t\t? Morpheus_Traffic::public_status()\n\t\t\t\t: array( 'available' => false, 'enabled' => false ),\n",
    replace: '',
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'src/components/matrix/WebsitePanel.jsx',
    // The tab is plugin-backed, so with no site connected its only possible answer is "connect first".
    // Leaving it out of the gate list made it the one tab that looked available and then refused.
    why: 'Takes TRAFFIC out of the greyed-tab list, so the button looks usable on a project with no site connected.',
    find: "['deploy', 'health', 'shop', 'pages', 'seo', 'traffic']",
    replace: "['deploy', 'health', 'shop', 'pages', 'seo']",
  },
  {
    guard: 'verify-seo.mjs',
    file: 'wp-plugin/morpheus/includes/seo/class-seo.php',
    // THE HARD-CODED LIST, restored at the one site that decides what the panel's
    // main list contains. The live store's `services` CPT and `portfolio` archive
    // are public and in the sitemap, and this is the line that kept both out of
    // the SEO tab — including the page whose description was its own first words.
    why: 'Puts the three-type list back as the default for the SEO content list, so the site\'s own public post types vanish from the panel.',
    find: ': morpheus_public_post_types();',
    replace: ": array( 'post', 'page', 'product' );",
  },
  {
    guard: 'verify-seo.mjs',
    file: 'wp-plugin/morpheus/includes/helpers.php',
    // WordPress reports `attachment` as public, and an attachment has no title
    // tag or meta description to write. Dropping the exclusion would hand every
    // image in the media library to the SEO panel as indexable content.
    why: 'Stops excluding attachments from the derived content types, so every media item is offered to the SEO panel as content with a title tag.',
    find: "\t\t'attachment',\n",
    replace: '',
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'wp-plugin/morpheus/includes/class-traffic.php',
    // The same constant lived here: publishing the store's `services` CPT never
    // told IndexNow about a page that is in the sitemap and reachable.
    why: 'Puts the traffic module back on the hard-coded three types, so the site\'s own public post types are never announced to an index.',
    find: "\t\t\t'post_type'      => morpheus_public_post_types(),\n",
    replace: "\t\t\t'post_type'      => array( 'post', 'page', 'product' ),\n",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // THE BOUND. A log is the one file on a site that can be gigabytes, and this is
    // the guard clause that makes the reader seek from the END instead of pulling
    // the whole thing into memory on a request.
    why: 'Removes the tail bound, so the error-log reader pulls the whole file instead of seeking from the end.',
    find: 'if ( $read < $size ) {',
    replace: 'if ( false ) {',
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // READ-ONLY IS THE WHOLE CONTRACT. A log is the operator's evidence, and this is
    // the shape that would destroy it the moment the file is missing.
    why: 'Makes the log reader delete the file when it is absent, so reading evidence could destroy it.',
    find: "\t\t\t$out['not_read'] = 'missing';",
    replace: "\t\t\t@unlink( $file );\n\t\t\t$out['not_read'] = 'missing';",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'src/components/matrix/website/ErrorLogPanel.jsx',
    // THE PANEL MUST NOT READ ON OPEN. A log tail can be megabytes, and opening a tab
    // is not a request to read it — this is the effect that would make every health
    // panel view pull the whole log.
    why: 'Reads the log when the panel mounts, so simply opening the health tab pulls a log that can be megabytes.',
    find: '  const [log, setLog] = useState(null);',
    replace: '  useEffect(() => { run(); }, []);\n  const [log, setLog] = useState(null);',
  },
  {
    guard: 'verify-redirects.mjs',
    file: 'wp-plugin/morpheus/includes/class-redirects.php',
    // ⚠️ THE LOCKOUT. A rule matching wp-admin takes the owner out of the screen they
    // would fix it on, and there is no way back from inside WordPress. This is the
    // save-time refusal; the match-time one below it is the second belt.
    why: 'Stops refusing a redirect on the WordPress admin surface, so a saved rule can lock the owner out of wp-admin.',
    find: 'if ( self::is_protected( $from ) ) {',
    replace: 'if ( false ) {',
  },
  {
    guard: 'verify-redirects.mjs',
    file: 'wp-plugin/morpheus/includes/class-redirects.php',
    // The second belt: a rule that reached the option by any other route still cannot
    // take the owner out of wp-admin, because the match path refuses it too.
    why: 'Stops the match-time protection, so a rule already stored can redirect wp-admin itself.',
    find: 'if ( self::is_protected( $path ) ) {',
    replace: 'if ( false ) {',
  },
  {
    guard: 'verify-redirects.mjs',
    file: 'wp-plugin/morpheus/includes/class-redirects.php',
    // A protocol-relative destination (`//evil.example`) is an external host wearing a
    // site-relative costume, which is why it is refused rather than trimmed.
    why: 'Accepts a protocol-relative destination, so a rule can silently point at another host.',
    find: "if ( 0 === strpos( $to, '//' ) ) {",
    replace: 'if ( false ) {',
  },
  {
    guard: 'verify-redirects.mjs',
    file: 'wp-plugin/morpheus/includes/class-redirects.php',
    // THE EVICTION POLICY. Reversing this sort turns "drop the least-hit" into "drop
    // the most-hit": a scanner's thousand one-off paths would then evict the URL forty
    // visitors a day are hitting — the exact failure the bound exists to avoid.
    why: 'Reverses the log ordering, so a 404 flood evicts the busiest real broken link instead of the rarest probe.',
    find: '\t\t\treturn $hb - $ha;',
    replace: '\t\t\treturn $ha - $hb;',
  },
  {
    guard: 'verify-redirects.mjs',
    file: 'wp-plugin/morpheus/includes/class-redirects.php',
    // 410 is an ANSWER, not a redirect. The guard slices the branch and refuses any
    // Location header inside it — so a "410" that actually redirects cannot pass.
    why: 'Puts a redirect inside the 410 branch, so a page marked Gone also sends a Location header.',
    find: '\t\t\t\t\tstatus_header( 410 );',
    replace: '\t\t\t\t\twp_redirect( home_url(), 302 );\n\t\t\t\t\tstatus_header( 410 );',
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'server/src/lib/widgetToken.js',
    // The scope entry the redirects panel needs. Without it the panel 403s for every
    // dock token — and the check reads BOTH tab files precisely so a function invoked
    // in a component the guard never opened cannot slip in unverified.
    why: 'Drops the redirects function from the traffic scope, so the panel it is invoked from is refused for every dock token.',
    find: "  traffic: ['trafficAction', 'wordPressRedirects'],",
    replace: "  traffic: ['trafficAction'],",
  },
  {
    guard: 'verify-wp-rollback.mjs',
    file: 'server/src/functions/wordPressDeploy.js',
    // The confirmation gate on a LIVE WRITE. With it gone the action runs on the plugin's say-so alone —
    // and because only the plugin's deploy handler tests `armed`, this route changes files on a site that
    // is deliberately not armed, which is precisely why the explicit confirm exists.
    why: 'Removes the explicit confirmation from the deploy undo, so a single call restores files on a live site that is not armed.',
    find: '    if (confirm !== true) {',
    replace: '    if (false) {',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/lib/siteUptime.js',
    // A site that never answered is NOT the site returning a 500. The remedies differ —
    // one is DNS/TLS/host, the other is the site's own code — so this is the branch that
    // keeps "we could not reach it" from being reported as "it is broken".
    why: 'Treats a site that never answered as an HTTP error, so a network failure is reported as the site\'s own fault.',
    find: 'if (status === 0) {',
    replace: 'if (false) {',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/lib/siteUptime.js',
    // "We did not look" must never be 0% (a site nobody has checked reading as broken)
    // and never 100% (reading as perfect).
    why: 'Reports a window with no checks as 0% uptime, so a site nobody has ever checked reads as permanently down.',
    find: 'out.uptime[`${days}d`] = null;',
    replace: 'out.uptime[`${days}d`] = 0;',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/lib/siteUptime.js',
    // An outage happening RIGHT NOW is the one an owner most needs to see, and it is the
    // one a naive implementation withholds until it recovers.
    why: 'Drops an outage that has not recovered yet, so a site that is down this minute reports no incidents.',
    find: '    open.duration_ms = durationBetween(open.started_at, null, now);\n    out.incidents.push(open);',
    replace: '    open.duration_ms = durationBetween(open.started_at, null, now);',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/functions/siteUptime.js',
    // The row is written AFTER the probe returns, so stamping it when it finished makes
    // a five-second response look freshly checked — the one number the panel shows as
    // "checked N minutes ago".
    why: 'Stamps the check when the row is written rather than when the probe started, so a slow site looks freshly checked.',
    find: 'checkedAt: startedAt',
    replace: 'checkedAt: new Date()',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/lib/siteUptimeStore.js',
    // H11: the migration ships with the code and production applies additive SQL by hand,
    // so for a while the table does not exist. Throwing there would break a page nobody
    // expects this to break.
    why: 'Throws when the uptime table has not been migrated yet, instead of reporting that there is no history.',
    find: 'if (isMissingUptimeTable(err)) return [];',
    replace: 'if (false) return [];',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/siteUptimeSchedule.js',
    // THE DUE-CHECK. Removing it makes every tick re-check every connected site, so a
    // restart, a missed tick or a manual CHECK NOW in the panel produces a burst of
    // duplicate observations — and the interval stops being a floor and becomes noise.
    why: 'Checks every connected site on every tick instead of only the ones that are due, so history fills with duplicates.',
    find: 'if (!lastMs || (now - lastMs) >= intervalMs()) due.push({ site, lastMs });',
    replace: 'due.push({ site, lastMs });',
  },
  {
    guard: 'verify-site-uptime.mjs',
    file: 'server/src/lib/siteUptimeStore.js',
    // ⚠️ THE BUG THE BROWSER FOUND, AS A MUTATION. A generated client that predates the
    // model makes `prisma.siteUptimeCheck` UNDEFINED rather than throwing, so reading
    // `.create` off it is a TypeError — which reached the panel as "Cannot read
    // properties of undefined (reading 'count')" while every source check passed.
    why: 'Reads the uptime table straight off the client instead of asking for the delegate, so a client that predates the model crashes the panel.',
    find: "  const db = uptimeDelegate();\n  if (!db) return null; // client not regenerated yet — see the header\n  try {\n    const row = await db.create({",
    replace: '  try {\n    const row = await prisma.siteUptimeCheck.create({',
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'server/src/lib/widgetToken.js',
    // The scope entry the uptime panel needs, and the reason it is an explicit list:
    // removing it makes the panel 403 for every dock token while the app keeps working,
    // which is exactly the kind of difference a browser would find and a source read
    // would not.
    why: 'Drops the uptime function from the deploy scope, so the panel it is invoked from is refused for every dock token.',
    find: "  deploy: ['wordPressDeploy', 'siteHealth', 'siteUptime'],",
    replace: "  deploy: ['wordPressDeploy', 'siteHealth'],",
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ THE CRASH ITSELF, AS A MUTATION. This is the line the three crash reports point at: a font asked for
    // inside the DRAW path and put straight into a dictionary LITERAL, where nil does not mean "no font" but
    // `NSInvalidArgumentException` — raised on the HOST's main thread, 30 times a second, in GarageBand's own
    // process. It is also the mutation that has to fail the `no font while drawing` check while every other
    // panel check stays green, which is why the check is written on `drawRect:`'s body rather than on the file.
    why: 'Puts a font factory back inside drawRect:, where a nil font raises out of the dictionary literal and takes the host (GarageBand) down with it.',
    find: '  NSDictionary *valueAttrs = s_valueAttrs;',
    replace: '  NSDictionary *valueAttrs = @{ NSFontAttributeName: [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium], NSForegroundColorAttributeName: morpheusGreen() };',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: 'server/src/lib/pluginGui.js',
    // ⚠️ THE SECOND CRASH, AS A MUTATION — the one the FIRST fix caused and every check stayed green through.
    // `morpheusAttrsOwned` exists because this file is compiled without ARC, so the factory's autoreleased
    // dictionary has to be retained by hand; drop the ownership on ONE of the six and the host's run loop frees
    // it at the end of the iteration the panel was created in. The next draw then messages dead objects and
    // GarageBand dies instantly. Nothing static can see it — it is an ownership property — so the guard asserts
    // the call, and this proves the assertion can fail.
    why: 'Stops owning one of the six attribute dictionaries, so the host\'s run loop frees it and the next draw segfaults in NSStringDrawing.',
    find: '  s_wordAttrs = morpheusAttrsOwned(morpheusAttrs(13, NSFontWeightBold, morpheusGreen()));',
    replace: '  s_wordAttrs = morpheusAttrs(13, NSFontWeightBold, morpheusGreen());',
  },
  {
    guard: 'verify-audio-plugin.mjs',
    file: '.github/workflows/audio-plugin-macos-build.yml',
    // ⚠️ A GATE IS NOT A GATE WHEN IT CAN BE UNWIRED QUIETLY. The step this removes is the only thing in any
    // pipeline that RUNS the panel; without it the repository is back to the state that shipped three crashes
    // past a fully green build, with every static check still passing. Deleting a step leaves no trace in the
    // diff of anything the guard reads — which is precisely why the guard reads the workflow.
    why: 'Deletes the step that runs the panel in the build users get, so nothing anywhere executes it again.',
    find: '      - name: Run the panel the way a host does, and fail if it does not survive it\n        run: node scripts/audio-plugin-panel-render.mjs\n        env:\n          AUDIO_PLUGIN_BUILD_DIR: ${{ runner.temp }}/audio-plugin-nam-build',
    replace: '      # (the panel is never run)',
  },
  {
    guard: 'verify-dock.mjs',
    file: 'server/src/routes/uploads.routes.js',
    // ⚠️ THE LIVE BUG OF 2026-10-08, AS A MUTATION. The dock renders the SHOP tab, so
    // picking a product photo there posts to /uploads — which mounted `blockWidget` and
    // refused every scoped token. The button was offered and could never work, and Rob
    // found it ("Photos are not uploading anymore") rather than a check.
    why: 'Puts the upload route back behind blockWidget, so the dock product-photo button is refused for every scoped token.',
    find: "router.post('/', requireAuth, allowStoreUpload, upload.single('file'), async (req, res) => {",
    replace: "router.post('/', requireAuth, blockWidget, upload.single('file'), async (req, res) => {",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // ⚠️ THE FALSE FINDING OF 2026-10-08, AS A MUTATION. This skip IS the fix. Without it the
    // signed, session-less scan runs WordPress's `rest_availability` test, whose loopback
    // carries no nonce because there is no logged-in user, so WordPress de-authenticates it by
    // its own rule and answers 401 — on EVERY site, whatever the host does. The panel then
    // reported it as "something is intercepting /wp-json/ — usually a security plugin or the
    // host", which is the shape H19 warns about one level up: a check whose failure is caused
    // by the way we run it.
    why: 'Runs the session-bound REST test again, so the scan reports a 401 it manufactured as a site problem.',
    find: "\t\t\tif ( isset( $session_bound[ $id ] ) ) {\n\t\t\t\tcontinue;\n\t\t\t}\n",
    replace: '',
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // The other half of the same claim: a test we did not run has to be REPORTED as not-run.
    // Dropping it from the list makes it vanish, and absent reads exactly like passing.
    why: 'Drops the session-bound test from the not-run list, so a test that never ran disappears instead of being named.',
    find: "\t\t\t'async_not_run'     => array_merge( self::async_tests(), self::session_bound_not_run() ),",
    replace: "\t\t\t'async_not_run'     => self::async_tests(),",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // THE COPY IS THE HARM. The verdict was wrong; this sentence is what turned it into work for
    // the operator and a support ticket for their host.
    why: 'Puts the accusation back into the copy, sending the operator to their host and their security plugin about a finding Morpheus made.',
    find: "\t\t\t\t'label' => 'Check the REST API yourself, logged in',",
    replace: "\t\t\t\t'label' => 'Something is intercepting /wp-json/',",
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'wp-plugin/morpheus/morpheus.php',
    // ⚠️ THE LIVE DEFECT OF 2026-10-08. Rewrite rules are SERVED FROM AN OPTION, and only a flush
    // rebuilds it. The activation hook flushes — and WordPress does not run activation hooks when
    // it UPDATES a plugin. So a rule added in a release never reached any site that updated into
    // it: the IndexNow key URL 404'd on valiantmusic.com.au, the panel correctly said "NOT
    // confirmed served", and every source-level check stayed green because the code was right.
    why: 'Removes the version-stamped flush, so a rewrite rule added in a release never reaches a site that updated into it.',
    find: "\tflush_rewrite_rules();\n",
    replace: '',
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'wp-plugin/morpheus/includes/class-traffic.php',
    // `redirect_canonical` sits on template_redirect at 10 and core registers it before any plugin,
    // so at the default priority it answered a correct key URL with a 301 to `/<key>.txt/` before
    // this handler could serve it. Verified live: the 301 carried `x-redirect-by: WordPress`.
    why: 'Puts the key handler back at the default priority, where the canonical redirect answers the key URL with a 301 before it can serve it.',
    find: "\t\tadd_action( 'template_redirect', array( __CLASS__, 'maybe_serve_key' ), 1 );",
    replace: "\t\tadd_action( 'template_redirect', array( __CLASS__, 'maybe_serve_key' ) );",
  },
  {
    guard: 'verify-traffic.mjs',
    file: 'wp-plugin/morpheus/includes/class-traffic.php',
    // A FAILED answer is the wrong half to cache long: the operator fixes the rewrite and the panel
    // keeps telling them it is broken, with nothing on screen saying the answer is an hour old.
    why: 'Caches a failed key check for an hour again, so the panel reports a key the operator has just fixed as still broken.',
    find: "$out['served'] ? self::KEY_CHECK_TTL : self::KEY_CHECK_MISS_TTL",
    replace: "self::KEY_CHECK_TTL",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // ⚠️ THE COUPLING THIS WHOLE CHANGE TURNS ON. The relocate fix points WP_DEBUG_LOG
    // at a file outside the web root; this is the line that makes the reader open THAT
    // file. Revert it to the hard-coded default and the plugin stops leaking the log
    // and stops being able to read it — a fix that blinds the person it was made for.
    why: 'Makes the error-log reader open the default path again, so a site whose log was moved out of the web root shows an empty panel while it is logging.',
    find: "\t\t$file  = morpheus_debug_log_file();",
    replace: "\t\t$file  = trailingslashit( WP_CONTENT_DIR ) . 'debug.log';",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-clean.php',
    // The public-log check has to ask about the file WordPress is WRITING. Asked about
    // the default path instead, a log pointed at any other path inside the root is
    // invisible to it — and a log legitimately moved outside the root gets probed at a
    // URL that no longer means anything.
    why: 'Points the public-log check back at the default URL, so a log written anywhere else is never judged.',
    find: "\t\t$url  = morpheus_debug_log_url( $file );",
    replace: "\t\t$url  = content_url( 'debug.log' );",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/helpers.php',
    // Reachability is a CONTAINMENT test. Make it a "the path is non-empty" test and
    // every file is reachable, including one outside the web root — so the fix cannot
    // recognize its own work and reports the same site as broken forever.
    why: 'Drops the containment test, so a log outside the web root is treated as reachable and the fix can never see that it worked.',
    find: "\tif ( '' !== $file && 0 === strpos( $file, $root ) ) {",
    replace: "\tif ( '' !== $file ) {",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // ⚠️ THE REFUSAL THAT KEEPS THIS FROM BEING THEATRE. Being outside WordPress's own
    // tree is not being outside the web root — a site at public_html/blog/ has a served
    // parent. Stop consulting the document root and Morpheus will happily move a log
    // from one readable place to another and call it fixed.
    why: 'Treats an empty document root as a real one, so the fix\'s answer depends on which PHP the host runs.',
    find: "\t\t$docroot     = ( '' !== $docroot_raw ) ? realpath( $docroot_raw ) : false;",
    replace: "\t\t$docroot     = realpath( $docroot_raw );",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // ⚠️ THE REFUSAL THAT KEEPS THIS FROM BEING THEATRE. Being outside WordPress's own
    // tree is not being outside the web root — a site at public_html/blog/ has a served
    // parent. Disable the containment test and Morpheus will happily move a log from one
    // readable place to another and call it fixed.
    why: 'Disables the containment test, so a log is moved to a directory that is still inside the web root.',
    find: "\t\tif ( $real === $docroot || 0 === strpos( $real . '/', $docroot . '/' ) ) {",
    replace: "\t\tif ( false ) {",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // Nothing is overwritten. The destination is a file Morpheus chose the NAME of, but
    // an operator's own morpheus-debug.log sitting there is theirs, not ours to replace.
    why: 'Removes the "a file is already there" refusal, so the fix overwrites whatever is at the destination.',
    find: "\t\tif ( file_exists( $dest ) ) {\n\t\t\treturn array( 'ok' => false, 'id' => $id, 'code' => 'TARGET_EXISTS', 'error' => 'There is already a file at ' . $dest . ', and Morpheus will not overwrite it. Move or rename that file, then check again. Nothing was changed.' );\n\t\t}\n",
    replace: '',
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // PHP takes the FIRST definition and refuses the second, so an added line would be
    // dead code that reads like a fix. Two lines means Morpheus cannot know which one
    // WordPress uses — so it must refuse, not pick.
    why: 'Stops refusing an ambiguous WP_DEBUG_LOG, so Morpheus rewrites one of two definitions and changes whichever line it happened to match.',
    find: "\t\tif ( $count > 1 ) {",
    replace: "\t\tif ( false ) {",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-fixes.php',
    // The two halves are one change. If the log will not move, a config pointing at a
    // file that is not there is worse than either half alone, so the config goes back.
    why: 'Leaves wp-config.php pointing at a log that was never moved, so WordPress logs to a path that does not exist.',
    find: "\t\tif ( ! $moved ) {\n\t\t\tself::restore_file_backup( $backup, $config );\n\t\t\treturn array( 'ok' => true, 'id' => $id, 'did' => 'attempted', 'verified' => false, 'restored' => true, 'error' => 'The log file could not be moved to ' . $dest . ', so wp-config.php was restored from the backup. Nothing was changed.' );\n\t\t}\n",
    replace: '',
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'wp-plugin/morpheus/includes/class-health.php',
    // The finding's id is the contract with the registry. Rename it and the scan emits a
    // finding with no action — the description-with-no-button state the registry exists
    // to prevent — while every other check stays green.
    why: 'Renames the finding, so the scan reports a log in the web root with no action attached to it.',
    find: "\t\t\t\t'id'          => 'morpheus_debug_log_in_web_root',",
    replace: "\t\t\t\t'id'          => 'morpheus_debug_log_public_path',",
  },
  {
    guard: 'verify-site-health.mjs',
    file: 'src/components/matrix/website/ErrorLogPanel.jsx',
    // The panel used to say, in a footnote, that it was reading a DIFFERENT file from the
    // one WordPress was configured to write. That was honest then; it is false now, and
    // it is the sentence that would make an operator think their moved log is unreadable.
    why: 'Puts back the "this is not the file WordPress writes" footnote, so a moved log reads as unreadable.',
    find: 'outside the site, and is what this panel reads either way.',
    replace: 'and this is {log.path}. Morpheus reads the file CLEAN MY SITE judges served or not.',
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
 *
 * 64 → 63 on 2026-10-08: `verify-seo.mjs` sat in the unproven pile while the thing it guards shipped a live
 * defect for eleven releases — `emit_schema()` nested the site's two JSON-LD nodes inside the page node's
 * array, so every page of every site emitted `[{…page…},[{…Organization…},{…WebSite…}]]`. Its checks all
 * passed on that shape, because they assert substrings and that the block parses, and a nested array does
 * both. It now also pins the node-list SHAPE, and the mutation added with it IS the old code, so the claim
 * is provable by a text edit.
 *
 * 63 → 62 on the same day: `verify-traffic.mjs` was also in the pile, while the thing it guards had a
 * documented-but-dead half — `Morpheus_Traffic::public_status()` was written to be "what the /status
 * route adds" and was called from nowhere, so the module could not be seen by the payload that reports
 * what a build can do. The key is now there and the guard asserts it, so the claim is text-editable.
 *
 * 62 → 61 on 2026-10-08: `verify-site-health.mjs` was in the pile — a health screen that is BELIEVED, with
 * no mutation proving its claims could fail. The error-log reader added three: the tail bound (seek from the
 * END, never the whole file), the read-only contract (reading evidence must not be able to destroy it), and
 * the panel's "fetch only on the press". The first version of that last check was ALSO satisfied by its own
 * subject's comment — it grepped for `useEffect` in a component whose doc-comment says "no useEffect,
 * deliberately" — which is H19 in miniature, and it is now asserted on the import instead.
 */
export const UNPROVEN_BASELINE = 60;
