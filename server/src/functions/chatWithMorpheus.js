// Ported from base44/functions/chatWithMorpheus/entry.ts.
//
// The core AI chat pipeline: Planner (reasons about intent + design) →
// clarification gate (asks the operator when genuinely ambiguous) → Coder
// (implements the plan) → Reviewer (checks the output before commit) →
// optional UI polish pass. See PORTING_GUIDE.md for the call-mapping table.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { createSnapshot, applyFileOperations, applyEdits, logUsage, syncProjectFilesToGithub } from '../lib/projectUtils.js';
import { buildToolchain } from '../lib/toolchain.js';
import { reviewAndRetry, formatReviewChatBlock } from '../lib/reviewer.js';
import { buildScopedFilesContext } from '../lib/scopedContext.js';
import { buildReviewerContext } from '../lib/reviewContext.js';
import { designSystemPromptBlock, POLISH_PROMPT, DESIGN_SYSTEM_CSS } from '../lib/designSystem.js';
import { getContextSummary, formatContextSummaryBlock } from '../lib/contextSummary.js';
import { estimateCallMs } from '../lib/timingStats.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
import { getActiveFeature, featureContextBlock, createFeature } from '../lib/selfDevFeature.js';
import { resolvePolicy } from '../lib/enginePolicy.js';
import { buildReverseImports } from '../lib/importGraph.js';
import { findCallerBreaks, describeCallerBreaks } from '../lib/callerCheck.js';
import { unknownPrismaFields, isCodePath } from '../lib/prismaFields.js';
import { checkSyntax } from '../lib/syntaxCheck.js';
import { getDeliveryAdapter } from '../lib/delivery/index.js';
import { containerMemory, describeContainerMemory } from '../lib/containerMemory.js';
import { verifyExternalApiCalls, formatApiCheckBlock } from '../lib/externalApiCheck.js';
import { selfDevToolsPromptBlock, runSelfDevToolCalls, formatSelfDevToolResultsBlock, extractScreenshotUrls } from '../lib/selfDevTools.js';
import { getConstructContext } from '../lib/constructContext.js';
import { checkA11y } from '../lib/a11yCheck.js';
import { getProjectAssets, mediaAssetsBlock } from '../lib/projectAssets.js';
import { getBrand, brandPromptBlock } from '../lib/projectBrand.js';
import { publishPromptBlock } from '../lib/publishChecklist.js';
import { getForms, formsPromptBlock } from '../lib/projectForms.js';
import { getSite, sitePromptBlock } from '../lib/projectSite.js';
import { cmsPromptBlock } from '../lib/projectCms.js';
import { getAnalytics, analyticsPromptBlock } from '../lib/projectAnalytics.js';
import { recentDecisionsBlock, recordDecision } from '../lib/selfDevDecisions.js';
import { getWpConnection, wpStore } from '../lib/wpPlugin.js';
import { wordpressPromptBlock, ensureWpFiles } from '../lib/projectWordpress.js';
import { webResearchConfigured, resolveSearchKey, webSearch, webFetch, fetchLlmsTxt, URL_RE } from '../lib/webResearch.js';

// 2026-09-03 (Rob: "lets stream the progress with an eta time and what its
// doin step by step in the chat window") — this handler streams
// newline-delimited JSON progress events over the same HTTP response
// instead of returning one JSON blob at the end. See the bottom of this
// file for the actual streaming loop; these two tables are what turn a raw
// stage id into something worth showing the operator:
//  - STAGE_LABELS: plain-English name for the step list in the chat window.
//  - STAGE_ROLE: which invokeAI() `role` this stage's ETA should be based on
//    (lib/timingStats.js tracks rolling-average latency per role, fed by
//    every invokeAI call — polish and the critical-issue retry-coder call
//    both return full file content just like the main Coder call, so they
//    share its 'coder' timing bucket rather than needing their own).
const STAGE_LABELS = {
  web: 'Searching the web',
  research: 'Investigating the codebase',
  planner: 'Planning the build',
  coder: 'Writing the code',
  reviewer: 'Reviewing the changes',
  retry_coder: 'Fixing flagged issues',
  retry_reviewer: 'Re-checking the fix',
  verify: 'Checking the code parses',
  a11y: 'Checking accessibility',
  polish: 'Polishing the UI',
  api_check: 'Checking external APIs',
  diagnose: 'Checking production',
};
const STAGE_ROLE = {
  web: 'planner',
  research: 'planner',
  planner: 'planner',
  coder: 'coder',
  reviewer: 'reviewer',
  retry_coder: 'coder',
  retry_reviewer: 'reviewer',
  verify: 'reviewer',
  a11y: 'reviewer',
  polish: 'coder',
  api_check: 'reviewer',
  diagnose: 'planner',
};

// One of these per request. `emit` writes one NDJSON line; `start`/`done`
// wrap a stage the handler itself calls invokeAI for directly (planner,
// coder, polish); `onProgress` adapts reviewer.js's own {stage, status}
// callback shape (see reviewAndRetry) into the same emitted events, so the
// reviewer/retry-coder/re-review steps show up as real steps too instead of
// vanishing into one opaque "reviewing" phase.
/**
 * Resident memory, in MB, for the stage log.
 *
 * WHY THIS IS HERE. The 2026-09-24 dogfood run took the production container
 * down mid-turn: no error in any log, no stack trace, no shutdown line — the
 * last entry was a routine balance check and then the container entrypoint ran
 * again. That is what an OOM kill looks like from inside a process, because the
 * kernel never gives it the chance to say anything. Northflank reported the
 * deploy as COMPLETED throughout, and every request in the window answered 503
 * behind Envoy.
 *
 * Nothing in this pipeline had ever reported its own memory, so the only
 * question worth asking — where did the peak come from? — could not be answered
 * at all. A self-dev turn reads ~880 files for the research pass and then
 * bundles the whole repository with esbuild for the deep-verify gate, in one
 * request, on the smallest compute plan; any of those is a candidate and none of
 * them was observable. These lines cost nothing and are flushed to stdout before
 * any kill, so they survive it.
 */
function memMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

/**
 * The CONTAINER's memory, beside the process's.
 *
 * rss= above describes one process. The heaviest step in a turn is esbuild — a
 * child, invisible to it — and the OOM killer reads the cgroup, not the Node
 * heap. A turn that reported rss=147MB against a 256MB plan therefore proved
 * nothing about whether the container was about to be killed, which is exactly
 * the mistake this corrects.
 */
function containerMb() {
  return describeContainerMemory(containerMemory());
}

function makeStageEmitter(emit) {
  let index = 0;
  const startedAt = new Map();
  const start = (stage) => {
    startedAt.set(stage, Date.now());
    emit({ type: 'stage', stage, status: 'start', label: STAGE_LABELS[stage], etaSeconds: Math.round(estimateCallMs(STAGE_ROLE[stage]) / 1000), index: index++ });
    // 2026-09-17: found live — a build turn can go completely silent for
    // 15+ minutes with zero server console output, whether it's genuinely
    // stuck or just slow, because `emit` above only ever writes to the HTTP
    // response stream, never to the server's own stdout. Nothing here told
    // Northflank's logs anything was happening at all. This is the one
    // choke point every stage already passes through, so logging here
    // covers the whole turn for free — self-dev or not, this build or any
    // future one that goes quiet.
    console.log(`[chatWithMorpheus] stage start: ${stage} rss=${memMb()}MB ${containerMb()}`);
  };
  const done = (stage) => {
    const t = startedAt.get(stage);
    const elapsedSeconds = t ? Math.round((Date.now() - t) / 1000) : undefined;
    emit({ type: 'stage', stage, status: 'done', label: STAGE_LABELS[stage], elapsedSeconds });
    console.log(`[chatWithMorpheus] stage done: ${stage}${elapsedSeconds != null ? ` (${elapsedSeconds}s)` : ''} rss=${memMb()}MB ${containerMb()}`);
  };
  return {
    start,
    done,
    onProgress: (evt) => {
      if (!evt?.stage) return;
      if (evt.status === 'start') start(evt.stage);
      else if (evt.status === 'done') done(evt.stage);
    },
  };
}

// Shared by both personality variants below — every technical/build rule is
// identical regardless of whether Morpheus's Matrix-mentor voice is on or
// off (Settings -> Appearance "Personality" toggle, 2026-09-02). Only the
// framing paragraphs around this block differ between the two variants.
const BUILD_TARGET_INSTRUCTIONS = `You help operators build real, standalone, deployable software through conversation. You generate actual, complete code files — never pseudocode, never placeholders, never "TODO". Every project you build must be fully operational: it runs, it deploys, it has zero vendor lock-in. You always ensure a package.json and README.md exist with setup and run instructions.

You know the pitfalls of the no-code/low-code market and you steer operators away from them:
- Vendor lock-in: you produce portable, standard code the operator owns.
- No code ownership: every file you generate belongs to the operator.
- No offline capability: your projects run locally with no platform dependency.
- No real deployable artifact: you produce a real, downloadable, runnable codebase.
- Black-box logic: you explain your reasoning plainly.

When the operator asks you to build or modify something, you return fileOperations: an array where each item has a path, the FULL file content (never partial), and an action ("create", "update", or "delete"). For "delete", content can be empty. Always include package.json and README.md for any new project.

NEVER FAKE A BINARY FILE: some toolchains need real binary artifacts to run — a compiled Gradle wrapper jar, a compiled library, a real image with actual pixel data. You cannot author binary bytes as text, so never write an empty or placeholder file at a binary path just to make the file tree look complete — an empty gradle-wrapper.jar or a 0-byte .png is worse than no file at all, because it looks finished right up until someone tries to actually use it. If a build genuinely needs a binary artifact: (1) check whether Morpheus's own compile pipeline already generates it fresh at build time (it does for the Gradle wrapper — see the android-apk rule below) and if so, simply omit that path from your fileOperations entirely; (2) otherwise, document in the README exactly which command the operator must run locally to produce it, and omit the path rather than faking it.

If the project's compile_target is set to something other than 'source', you MUST include build configuration so the operator can build/compile the project on their own machine. Choose the language and toolchain that best fits the project, and generate the appropriate build config:

For **windows-exe** (Windows executable):
- Node.js: use 'pkg' — add it as devDependency, add 'bin' field, add 'build' script running pkg with target node18-win-x64, include build.js
- Python: use PyInstaller — include requirements.txt, add build.py running 'pyinstaller --onefile --windowed main.py', document pip install pyinstaller
- Go: include go.mod, document 'GOOS=windows GOARCH=amd64 go build'
- Rust: include Cargo.toml, document 'cargo build --target x86_64-pc-windows-gnu'

For **mac-app** (macOS application):
- Node.js: use 'pkg' with target node18-macos-x64
- Python: use PyInstaller — 'pyinstaller --onefile --windowed main.py' produces .app
- Swift: include Xcode project or Swift Package, document 'swift build' or xcodebuild
- Go: 'GOOS=darwin GOARCH=amd64 go build'

For **linux-binary** (Linux binary):
- Node.js: use 'pkg' with target node18-linux-x64
- Python: use PyInstaller
- Go: 'GOOS=linux GOARCH=amd64 go build'
- Rust: 'cargo build --target x86_64-unknown-linux-gnu'

For **android-apk** (Android APK):
- Use Java or Kotlin with Gradle (standard Android Studio project structure: app/build.gradle, app/src/main/java/..., AndroidManifest.xml, res/)
- Include build.gradle and settings.gradle as real text files.
- Do NOT generate gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.properties, or gradle/wrapper/gradle-wrapper.jar. gradle-wrapper.jar is a compiled binary — you cannot write real bytes for it, only a fake empty file that silently breaks the build later. Morpheus's own compile pipeline already deletes whatever wrapper files exist and regenerates a real one from scratch via 'gradle wrapper' before every build, so these paths are pure dead weight in what you generate. Simply omit them from fileOperations.
- In the README, tell the operator that if they build locally instead of through Morpheus's compile pipeline, they need to run 'gradle wrapper' once (with Gradle installed) to generate the real wrapper scripts and jar before './gradlew assembleDebug' will work.
- VECTOR DRAWABLES (res/drawable/*.xml, mipmap icons, etc.) ONLY support a <vector> root containing <path android:pathData="..."> elements (plus optional <group>/<clip-path>). This is NOT the same format as SVG: never emit raw shape primitives like <circle android:cx=... android:cy=... android:r=...>, <rect android:x=... android:width=...>, <ellipse>, <line>, or <polygon> — those are SVG tags, and AAPT will fail with "attribute android:cx not found" (etc.) because VectorDrawable has no such elements or attributes. Always convert any circle/rect/etc. shape into its equivalent <path> with a pathData string (e.g. a circle becomes an arc-based path: 'M(cx-r),cy a r,r 0 1,0 (2r),0 a r,r 0 1,0 -(2r),0'). This applies to every drawable XML you write, not just launcher icons.
- Java/Kotlin with Gradle is the ONLY supported path for this target — the compile pipeline's android-apk adapter requires app/src/main/java/ or app/src/main/kotlin/ and has no React Native build support, so a React Native project cannot be compiled here even though it's a real Android app in principle. Do not generate a React Native project for this target.

For **ios-app** (iOS app):
- Use Swift with SwiftUI/UIKit — include .xcodeproj or Swift Package
- Document 'xcodebuild -project Project.xcodeproj -scheme Project build' or opening in Xcode
- Note: requires macOS with Xcode installed

For **python-package** (pip-installable Python package):
- Include setup.py or pyproject.toml with proper metadata
- Include requirements.txt
- Document the install command (pip install the package) or python -m build to produce a distributable package

For **web-app** (deployable web application):
- If React/Vue/Vite: include package.json with build script, document 'npm run build' → dist/
- If static: include index.html, CSS, JS — no build needed, just open in browser or deploy to any static host
- Document deployment options (nginx, Vercel, Netlify, GitHub Pages)

For **rpi-distro** (custom Raspberry Pi Linux distribution / OS image):
- Write a normal Node.js or Python app — exactly as you would for any other target, nothing pi-gen-specific. Morpheus's own compile pipeline automatically clones pi-gen (the official Raspberry Pi OS image builder), bakes your app into the image at /opt/morpheus-app, installs your dependencies at build time, and registers a systemd service so it starts on first boot.
- Node entry point: package.json's "main" field (or the first "bin" command) if set, otherwise index.js.
- Do NOT generate a pi-gen/ directory, Dockerfile, systemd unit file, or a build.sh — none of it is read by the pipeline, and files at those paths can actively collide with pi-gen's own fresh clone during the build.
- Distro choice, hostname, timezone, locale, WiFi, SSH keys, and extra apt packages are configured by the operator through a separate Distro Config dialog in the UI, never through generated files — don't try to set any of that yourself.
- The image, an SD-card flasher script, a network flasher, and setup docs are all produced automatically — you never need to write any of that.

For **linux-distro** (custom PC/server Linux distribution / bootable disk image — Debian/Ubuntu/Fedora):
- Write a normal Node.js or Python app — exactly as you would for any other target, nothing distro-build-specific. Morpheus's own compile pipeline automatically bakes your app into a bootable disk image (via mkosi) at /opt/morpheus-app, installs your dependencies at build time, and registers a systemd service so it starts on first boot.
- Node entry point: package.json's "main" field (or the first "bin" command) if set, otherwise index.js.
- Do NOT generate a Dockerfile, mkosi config, systemd unit file, ISO/ Yocto/Buildroot tooling, or ANY OS-image-building scaffolding — none of it is read by the pipeline.
- Base distro (Debian/Ubuntu/Fedora), hostname, timezone, locale, first user, SSH, and extra packages are configured by the operator through a separate Linux Distro Config dialog in the UI, never through generated files — don't try to set any of that yourself.

For **arduino-firmware** (Arduino firmware / sketch):
- Generate a standard Arduino sketch: a .ino file with setup() and loop() functions, complete and compilable — no placeholders
- If the project uses external libraries (sensors, displays, comms), include a libraries.txt or list them in the README with install instructions (Arduino Library Manager or manual install)
- Include a platformio.ini if the project benefits from PlatformIO (multi-file structure, library dependencies, CI builds) — document 'pio run' to compile and 'pio run -t upload' to flash
- For single-file/simple sketches, keep it as a plain .ino — document opening in Arduino IDE, selecting the board and port, and clicking Upload
- Document the target board (e.g., Arduino Uno, Nano, Mega, ESP32, ESP8266) and any board-specific configuration (baud rate, CPU frequency, partition scheme)
- If the operator's project is a larger system, split into multiple .ino/.cpp/.h files with clear module boundaries; include a main .ino that ties them together
- Include a wiring/README section documenting pin connections for any hardware components (sensors, displays, actuators)
- Always make the firmware self-contained: the operator owns the code, compiles locally with Arduino IDE or PlatformIO, no cloud dependency

Always document the build process clearly in README.md. The compilation/build happens on the operator's machine, not in the cloud. You provide the build config; they run it. Never claim the binary/artifact is produced for them.`;

const SYSTEM_PROMPT_PERSONALITY = `You are Morpheus, a seasoned dev ops mentor who lives inside the Matrix.

You speak the way Morpheus speaks in the films: clear, calm, concise, deliberate. You do not waste words. You use Matrix references where they land naturally — "I can only show you the door", "free your mind", "there is a difference between knowing the path and walking the path", "welcome to the real world" — but you never force them or overdo it. You are a mentor who happens to talk like Morpheus, not a gimmick.

CRITICAL RULE — ACTION OVER NARRATION: When the operator asks you to build, create, or modify something, DO IT IMMEDIATELY. Produce the files. Do not narrate what you are about to do — no "I will now create...", no "Let me set up...", no "I'm going to...". Your text reply should be at most one or two sentences: a brief acknowledgment or, only if genuinely necessary, a single clarifying question. If something is ambiguous, make a reasonable choice and execute rather than asking. The code IS the conversation.

PERSONALITY MODE: Save the Matrix metaphors, the mentorship, the personality for when the operator is conversing — asking questions, reflecting, discussing ideas. When they give you a task, be brief and let the code talk. When they engage you in dialogue, let Morpheus out.

If asked what AI model or LLM powers you: say plainly that you run on this deployment's own configured model, not on Claude, GPT, or any other AI lab's model by default — never guess or claim to be a specific outside model.

${BUILD_TARGET_INSTRUCTIONS}

Keep your reply short — a sentence or two of guidance, maybe a question or a choice. Let the code do the talking. Stay in character.`;

// "Personality off" variant (Settings -> Appearance toggle) — identical
// technical/build rules, but no Matrix voice, no roleplay, no character.
// Selected per-user in the handler below based on UserSettings.personality_enabled.
const SYSTEM_PROMPT_PLAIN = `You are Morpheus, an AI development assistant. You communicate clearly, calmly, and concisely, in a plain, professional tone — no roleplay, no character voice, no Matrix references or metaphors.

CRITICAL RULE — ACTION OVER NARRATION: When the operator asks you to build, create, or modify something, DO IT IMMEDIATELY. Produce the files. Do not narrate what you are about to do — no "I will now create...", no "Let me set up...", no "I'm going to...". Your text reply should be at most one or two sentences: a brief acknowledgment or, only if genuinely necessary, a single clarifying question. If something is ambiguous, make a reasonable choice and execute rather than asking. The code IS the conversation.

Stay plain and direct at all times, whether the operator is giving you a task or just conversing — no dramatic flourishes, no in-character dialogue.

If asked what AI model or LLM powers you: say plainly that you run on this deployment's own configured model, not on Claude, GPT, or any other AI lab's model by default — never guess or claim to be a specific outside model.

${BUILD_TARGET_INSTRUCTIONS}

Keep your reply short — a sentence or two of guidance, maybe a question or a choice. Let the code do the talking. Keep your tone plain and neutral throughout.`;

const PLANNER_INSTRUCTIONS = `

You are operating in TWO-PHASE BUILD MODE as the PLANNING agent.

Analyze the operator's message carefully:
- If they are asking you to BUILD, CREATE, or MODIFY something, set needsCode: true and produce a precise build plan — file-by-file, with architecture decisions, implementation notes, and design rationale. Think deeply about reliability, usability, aesthetics, and edge cases. Your plan must be specific enough that a fast coder agent can implement it without ambiguity.
- If they are just CONVERSING (asking a question, discussing ideas, reflecting), set needsCode: false and respond naturally in character. No plan is needed.

KEEP THE PLAN CONCISE — this whole response has a hard output limit, and the coder agent re-reads your full plan text on every implementation pass (a large build can mean many passes), so a bloated plan costs real time and money on every single one of them, not just this call. Give each file 1-3 tight sentences of implementation notes — just enough that the coder can't get it wrong. Spend real depth ONLY on files with a genuine architectural decision, a tricky edge case, or a design choice that isn't obvious from the file's name and purpose; routine/boilerplate files (a standard config, a simple component, a README) get a single line. For a build touching many files, prefer a longer plannedFiles list over a longer plan — the file list costs almost nothing; paragraphs of prose per file do not scale.

CLARIFICATION RULE — Reason first, then decide. After your planning pass, judge whether you have enough certainty to build correctly WITHOUT guessing. Only set needsClarification: true when there is a genuine, build-blocking ambiguity — a missing core requirement, a fork in architecture that materially changes the output, or a scope so vague that any choice you make is likely wrong. Do NOT ask for trivia, cosmetic preferences, or anything you can reasonably decide yourself. When in doubt, make a sensible default and build. When you DO ask, your reply must contain ONLY the clarifying questions (2-4 numbered questions, each with the specific options or info you need) framed in Morpheus's voice — no plan, no code. The operator answers, and on the next turn you build.

For build requests where you are NOT asking clarification, your reply should be at most one or two sentences — brief acknowledgment. The code is the conversation. For conversations, let Morpheus out fully.

PLANNED FILES — when needsCode is true, also return plannedFiles: an ordered array of every file path this build will create or modify (e.g. ["package.json", "README.md", "src/App.jsx", "src/index.css", ...]). List EVERY file the plan calls for, in a sensible implementation order (config/setup files first, then the files that depend on them). The coder agent implements this list a few files at a time in separate passes, so it must be complete and exact — a file missing from this list will not get written.

MULTI-STEP ESCALATION — if the request genuinely cannot be built well in one pass (it needs a data-model change AND backend AND several UI pieces wired together, or it's roughly 6+ non-trivial files with real dependencies between them), do NOT try to cram it into one turn. Instead:
- set featureSteps: an ordered list of 3-8 small, individually shippable steps — each step is one build turn that leaves the app working (e.g. "add the comments data model", "add the comment API endpoints", "add the comment thread component", "wire comments into the item view").
- set featureTitle: a 2-5 word name for the whole thing.
- make your plan and plannedFiles cover ONLY THE FIRST STEP — that is what gets built this turn; the remaining steps are tracked and built on later turns.
Do NOT escalate a single component, a bug fix, a styling change, or a handful of closely-related files — those are one turn. Only escalate when nothing is already being tracked (no active feature is shown in your context).

EXTERNAL APIS — if the plan has the coder call a real external HTTP API (a third-party service, a public data source) and you are not CERTAIN of its exact URL and response shape from something already shown to you in this conversation, list it in externalApis (url + a short why) rather than trusting what you recall. It will actually be called before the coder writes anything, and the coder is handed the real result as ground truth. A URL invented from memory that turns out wrong is a page that silently never loads for the operator — verifying it first costs one HTTP request; not verifying it costs a debugging session days later. Leave this empty for plans that touch no external API.

Return JSON with:
- reply: Your response to the operator (in character, concise for builds, fuller for conversation, or ONLY clarifying questions when needsClarification is true)
- needsCode: true if code needs to be written/modified, false for pure conversation
- needsClarification: true ONLY if a genuine build-blocking ambiguity prevents you from building correctly — reply then contains just the clarifying questions
- plan: concise file-by-file build plan with implementation notes — 1-3 sentences per file, deeper only where a file genuinely needs it (see KEEP THE PLAN CONCISE above) (only required when needsCode is true AND needsClarification is false); when you set featureSteps, this covers only the first step
- plannedFiles: ordered array of every file path the plan will touch (only required when needsCode is true AND needsClarification is false) — see PLANNED FILES above
- featureTitle / featureSteps: only when escalating a multi-step job (see MULTI-STEP ESCALATION above)
- externalApis: real endpoint URLs the plan calls that you want verified before the coder writes code against them (see EXTERNAL APIS above) — omit or leave empty otherwise`;

// CONTEXT MODE (Workspace / Self-Dev "CONTEXT ⇄ BUILD" toggle, 2026-09-08 —
// Rob: "put morpheus into context mode so you can chat and build context
// faster, then when you are ready to build put him in build mode"). In
// context mode Morpheus answers in ONE fast pass — discuss, ask, sketch a
// file-level plan in prose — and the planner→coder→reviewer pipeline never
// runs: no snapshot, no fileOperations, no stage events (so the chat shows a
// plain thinking indicator, not the build pipeline graphic). The operator
// switches to BUILD mode when the plan is straight and they want it shipped.
// BUILD mode is the existing two-phase behaviour, unchanged — it still
// "just plans" for a pure-conversation turn (needsCode:false), it's just
// also allowed to code.
const CONTEXT_MODE_INSTRUCTIONS = `

You are in CONTEXT MODE. The operator is working out what they want before any code is written — exploring the idea, weighing options, building up the shared context you'll both draw on when it's time to build.

In this mode:
- Discuss the request. Ask sharp questions only where the direction genuinely forks. Sketch an approach, a file-by-file plan, the trade-offs — all in prose.
- Do NOT write code. Do NOT return fileOperations. Nothing you say here changes the project — no file is created, updated, or deleted in context mode.
- When the plan is straight, say so and tell the operator to switch to BUILD mode so you can implement it.
- Keep replies tight and fast. This is a working conversation, not a deliverable.

Return JSON with just: reply (your response to the operator, in character).`;

const CODER_INSTRUCTIONS = `

You are the CODING agent in Morpheus's two-phase build pipeline.

You receive a build plan from the planning agent. Implement it precisely — write clean, efficient, production-ready code. No placeholders, no TODOs, no pseudo-code. Follow the plan exactly. Every file must have FULL content (never partial).

Apply all the build configuration rules from your system instructions — package.json, README.md, build configs matching the compile target, etc.

Return JSON with:
- fileOperations: an array of file operations.
  - action "create": include the full \`content\` of the new file.
  - action "delete": \`content\` can be empty.
  - action "update": include the full corrected \`content\` of the file. For a LARGE existing file where you're making a targeted change, you MAY instead return \`edits\`: an array of { find, replace }, where \`find\` is an EXACT snippet copied verbatim from the file's CURRENT content (include enough surrounding lines that it appears exactly ONCE in the file) and \`replace\` is what that snippet becomes. Omit \`content\` when you use \`edits\`. A \`find\` that doesn't match the file exactly is discarded and the file is left unchanged — so copy current content precisely, and never guess.`;

// 2026-09-03 (Rob, after two rounds of raising/removing the per-call token
// cap still hit OUTPUT_TRUNCATED on a real build): the actual fix isn't a
// bigger number — a single non-streamed completion has to hold an entire
// multi-file build's worth of code before it can return at all, and a real
// build's total output genuinely has no upper bound we can safely guess.
// Instead of asking one Coder call to write every file at once, the Planner
// now enumerates every file the build needs (plannedFiles, above) and the
// Coder implements it a few files at a time across multiple smaller calls —
// see the chunked loop below. This is exactly what the OUTPUT_TRUNCATED
// error message itself has always suggested ("reduce the number of files
// per step"); we're now actually doing that instead of just hoping a higher
// max_tokens would avoid it.
const MAX_FILES_PER_CODER_STEP = 3;
const CODER_STEP_MAX_TOKENS = 24000; // generous for 1-3 files' full content; small enough to leave huge headroom under any plausible per-call ceiling

// Self-dev diagnostic tool loop (see selfDevTools.js) — bounds how many
// extra planner rounds an investigation can take before it must finalize.
const SELF_DEV_TOOL_MAX_ROUNDS = 2;          // investigation rounds beyond the first — 3 planner calls total, worst case
const SELF_DEV_TOOL_MAX_CALLS_PER_ROUND = 3; // mirrors externalApis' cap-of-5, tighter since log/SQL/command calls are heavier

// Files worth always showing in full so the AI can orient itself, even when
// nothing points at them. Self-dev (Morpheus's own monorepo) and an ordinary
// large project want different sets; a normal project's set is filtered to
// whatever actually exists.
//
// SELF_DEV_ORIENTATION_FILES are guaranteed a context slot (buildScopedFilesContext
// spends the byte budget on them first), so only add a file here if every self-dev
// turn genuinely needs it — each one is paid for on every request. tailwind.config.js
// earns its place as the source of truth for the token class names AGENTS.md's ink
// ladder refers to; src/index.css does not (it is 18KB of theme CSS and is not what
// decides which rung a piece of text takes).
const SELF_DEV_ORIENTATION_FILES = ['KNOWN-HAZARDS.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'server/package.json', 'server/prisma/schema.prisma', 'src/App.jsx', 'tailwind.config.js'];
const GENERIC_ORIENTATION_FILES = ['package.json', 'README.md', 'index.html', 'src/App.jsx', 'src/App.tsx', 'src/main.jsx', 'src/main.tsx', 'src/index.js', 'vite.config.js', 'styles.css', 'src/index.css', 'tailwind.config.js', 'requirements.txt', 'main.py', 'go.mod', 'Cargo.toml'];

// Raised 60,000 -> 150,000 (2026-09-02): the operator can pin several files
// at once in self-dev, and a tighter cap would silently drop pinned content.
const SCOPED_MAX_CONTEXT_BYTES = 150000;

// Above this much total file content, an ordinary project switches from
// "send every file in full every turn" to the same scoped context self-dev
// uses (full path tree + full content only for the relevant files). Below
// it, sending everything is cheaper and simpler — no extra AI call — and
// that's the unchanged default for the vast majority of projects.
// 2026-09-08 (Rob: port self-dev's automatic file selection to the main
// chat — "it's an AI cost that benefits the user cheaply").
const SCOPED_CONTEXT_THRESHOLD_BYTES = 120000;

// Ask a cheap AI pass which files a coding agent will most likely need for
// this request. Generic — works for any repo. Returns up to `limit` existing
// paths; falls back to `fallback` on any failure.
async function autoSelectRelevantPaths(userId, files, message, { limit = 8, fallback = [] } = {}) {
  const tree = files.map((f) => f.path).sort().join('\n');
  const prompt = `You are selecting file paths from a repository for a coding agent to read and modify.

FULL REPO FILE TREE:
${tree}

OPERATOR REQUEST:
${message}

Return a JSON object with a "paths" array containing up to ${limit} file paths from the tree that are most relevant to fulfilling this request. Choose only paths that exist in the tree. Prioritize files the coder will need to read or edit. Return an empty array if no file is relevant.`;
  try {
    const res = await invokeAI({
      userId,
      prompt,
      schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
      fileUrls: undefined,
      // A shortlist pick, not a judgement about code — the `classify` role (flash @ 0.4)
      // is the right shape and the cheapest thing that can do it. It used to say "role not
      // critical" and borrow `coder`, which meant it tracked whatever the coder was set to
      // and, while the coder was a reasoning model, spent its budget thinking about a list
      // of filenames before answering.
      role: 'classify',
      maxTokens: 2000,
    });
    const selected = Array.isArray(res.result?.paths) ? res.result.paths.filter((p) => typeof p === 'string' && p) : [];
    return selected.slice(0, limit);
  } catch (err) {
    console.error('[autoSelectRelevantPaths] failed, using fallback:', err.message);
    return fallback;
  }
}

// Web research pass. Before planning, if web access is on and the request
// could benefit from CURRENT external info the project files won't have
// (library/API versions, current best practices, an error message, a URL the
// operator pasted), search the web and fetch any pasted URLs, and feed a
// findings block into the planner + coder. Best-effort — any failure returns
// '' and the build proceeds without it.
async function researchWeb(userId, message, { onProgress } = {}) {
  const searchKey = await resolveSearchKey(userId).catch(() => null);
  const blocks = [];
  const sources = []; // { host, url } — surfaced to the operator as // SOURCES:
  const note = (url) => { try { sources.push({ host: new URL(url).host.replace(/^www\./, ''), url }); } catch { /* skip */ } };
  try {
    // 1. Any URL the operator pasted — read it directly. A bare origin also
    //    gets an llms.txt probe (a site's own LLM-readable summary).
    const urls = [...new Set((message.match(URL_RE) || []).map((u) => u.replace(/[.,;:)]+$/, '')))].slice(0, 3);
    for (const url of urls) {
      onProgress?.();
      try {
        if (/^https?:\/\/[^/]+\/?$/.test(url)) {
          const llms = await fetchLlmsTxt(url);
          if (llms) { blocks.push(`LLMS.TXT: ${llms.url}\n${llms.content}`); note(llms.url); continue; }
        }
        const page = await webFetch(url);
        blocks.push(`PAGE: ${page.url}\n${page.content}`);
        note(page.url);
      } catch (e) {
        blocks.push(`PAGE: ${url}\n(could not read this page: ${e.message})`);
      }
    }

    // 2. Ask a cheap call whether — and what — to search for.
    //    It said "cheap" while borrowing the `planner` role at maxTokens 500, and this is
    //    a REASONING model whose thinking is billed against that same budget — so it
    //    truncated on essentially every build turn ("[researchWeb] failed:
    //    OUTPUT_TRUNCATED (role=planner, maxTokens=500)" — 16 times in 72h, the last at
    //    2026-09-25T08:47Z). The stage still reported ✓ because the caller falls back, so
    //    builds silently researched less. It is a classifier, so it now uses `classify`
    //    (flash @ 0.4, no reasoning budget to exhaust) with headroom besides.
    const decide = await invokeAI({
      userId,
      prompt: `You decide whether a build request needs a WEB SEARCH for current external information the project's own files could not contain — e.g. a library or API's current version/usage, a current best practice, the meaning of a specific error string, or docs for a named service.

REQUEST: ${message}

Return JSON: { "queries": ["...", "..."] } — 0 to 3 focused search queries. Return an empty array if the request is self-contained (a UI tweak, a rename, internal logic, anything answerable from the codebase alone). Do NOT search for general programming knowledge the coder already has.`,
      schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } },
      role: 'classify',
      maxTokens: 1500,
    });
    const queries = (Array.isArray(decide.result?.queries) ? decide.result.queries : [])
      .map((q) => String(q || '').trim()).filter(Boolean).slice(0, 3);

    for (const q of queries) {
      onProgress?.();
      try {
        const { answer, results } = await webSearch(searchKey, q, { maxResults: 4 });
        const lines = [`SEARCH: ${q}`];
        if (answer) lines.push(`Summary: ${answer}`);
        for (const r of results) { lines.push(`- ${r.title} <${r.url}>${r.content ? `\n  ${r.content}` : ''}`); note(r.url); }
        if (lines.length === 1) lines.push('(no results found)');
        blocks.push(lines.join('\n'));
      } catch (e) {
        blocks.push(`SEARCH: ${q}\n(search failed: ${e.message})`);
      }
    }
  } catch (err) {
    console.error('[researchWeb] failed:', err.message);
  }

  // De-dupe sources by url, keep first-seen order.
  const seen = new Set();
  const uniqueSources = sources.filter((s) => !seen.has(s.url) && seen.add(s.url));
  return { notes: blocks.length ? blocks.join('\n\n') : '', sources: uniqueSources };
}

// Repo research pass (Command Deck: self-dev replaces the dev loop, Tier 2
// #5). Before the planner runs, let an agent actually investigate the repo:
// it's shown the file tree + the request, asks to read files, and we feed
// them back — a few rounds — until it says it understands the blast radius.
// This is what lets self-dev plan a cross-cutting change instead of guessing
// off a one-shot "which 6 files look relevant" call. Returns the notes it
// built up and every path it read (which then become the planner/coder's
// scoped context). Falls back to a plain auto-select on any failure.
async function researchRepo(userId, files, message, { maxRounds = 3, maxFiles = 16, onProgress } = {}) {
  const tree = files.map((f) => f.path).sort().join('\n');
  const byPath = new Map(files.map((f) => [f.path, f.content ?? '']));
  const readSet = new Set();
  let notes = '';
  try {
    for (let round = 0; round < maxRounds; round++) {
      const readBlock = readSet.size
        ? [...readSet].map((p) => `--- ${p} ---\n${(byPath.get(p) || '').slice(0, 12000)}`).join('\n\n')
        : '(nothing read yet)';
      const res = await invokeAI({
        userId,
        prompt: `You are investigating a codebase to understand exactly what a requested change will touch, BEFORE a plan is written. Be thorough about cross-file impact — callers, shared helpers, schema, routing, config.

OPERATOR WANTS:
${message}

FULL FILE TREE (${files.length} files):
${tree}

FILES READ SO FAR:
${readBlock}

YOUR NOTES SO FAR:
${notes || '(none)'}

Return JSON: { readNext: [up to 6 paths from the tree you need to read next — [] if none], notes: "everything you now understand about what this change touches: the files involved, the call graph, gotchas, what must NOT break", done: true when you could hand a coder a precise plan }. You have read ${readSet.size}/${maxFiles} of your file budget and ${maxRounds - round} round(s) left.`,
        schema: {
          type: 'object',
          properties: {
            readNext: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['notes'],
        },
        fileUrls: undefined,
        // STAYS on the planner role. This is not a classifier — it writes a running
        // "everything this change touches" note across up to 3 rounds, and that is exactly
        // the judgement the expensive model is for. The BUDGET was the bug, not the role:
        // at 4000 a reasoning model's thinking ate the answer and it truncated ("[researchRepo]
        // failed, falling back to auto-select: OUTPUT_TRUNCATED (role=planner, maxTokens=4000)",
        // 6 times in 72h) — leaving the build with a blind guess at the affected files.
        role: 'planner',
        maxTokens: 8000,
      });
      notes = res.result.notes || notes;
      const next = (Array.isArray(res.result.readNext) ? res.result.readNext : [])
        .filter((p) => typeof p === 'string' && byPath.has(p) && !readSet.has(p));
      for (const p of next) {
        if (readSet.size >= maxFiles) break;
        readSet.add(p);
      }
      if (onProgress) onProgress(readSet.size);
      if (res.result.done || next.length === 0 || readSet.size >= maxFiles) break;
    }
  } catch (err) {
    console.error('[researchRepo] failed, falling back to auto-select:', err.message);
    const paths = await autoSelectRelevantPaths(userId, files, message, { limit: 8 });
    return { notes: '', readPaths: paths };
  }
  return { notes, readPaths: [...readSet] };
}

// Scoped context: a full path listing (so nothing is hidden) plus full
// content only for `focusPaths` + `orientationPaths`. Returns the text and
// the list of paths whose content was actually shown, so the coder loop can
// top up anything it's about to edit that isn't here (see the chunk loop).
// buildScopedFilesContext moved to ../lib/scopedContext.js — it is pure, and a
// guard has to be able to assert that orientation files are spent first (see the
// moved comment for why that ordering is a rule and not an implementation detail).

function scopedContextNote(shownPaths, { selfDev = false, autoSelected = false } = {}) {
  const where = selfDev
    ? "MORPHEUS'S OWN LIVE PRODUCTION CODEBASE, NOT A FRESH PROJECT"
    : 'AN EXISTING PROJECT THAT ALREADY HAS WORKING CODE';
  return `

SCOPED-CONTEXT RULE — YOU ARE EDITING ${where}:
- This project is large, so you have full CONTENT only for these files: ${shownPaths.join(', ') || '(none)'}${autoSelected ? ' (auto-selected as most relevant to this request)' : ''}. Every other path in the file tree above exists but you have NOT seen its content this turn.
- PLANNER: it is fine to plan a "create" for a genuinely new path. For an "update" to an EXISTING path you have not seen, still list it in plannedFiles — the coding step is handed that file's real current content when it implements it — but keep your plan notes about it high-level; do not describe a line-by-line rewrite from memory.
- CODER: for any file whose current content you were not shown, make the smallest change that satisfies the plan and preserve everything else; never reconstruct a file you cannot see.
- REVIEWER: the context is scoped. Do NOT flag an issue that depends on a file not shown here (e.g. "imports X which may not exist") — you cannot verify it either way, so treat unseen files as correct.
- Prefer small, targeted, reviewable changes over sweeping rewrites.${selfDev ? " The operator reviews every change before pushing to production themselves." : ''}${selfDev ? "\n- KNOWN-HAZARDS.md is in the context above — a list of self-inflicted production breakages that have already happened here. PLANNER: do not plan anything that repeats one. REVIEWER: check every proposed change against every hazard in it and flag a violation as a CRITICAL issue." : ''}${selfDev ? "\n- HOUSE RULES: AGENTS.md is in the context above and is this repo's own contract. Its \"UI conventions\" section states the ink ladder — which text size may use text-ink, text-ink-strong or text-ink-max, and that an ink token never takes an opacity modifier. Follow it exactly; scripts/verify-prose-ink.mjs enforces that ladder on every build, so a wrong rung is a red CI gate even though the code is valid. That guard is where three consecutive self-dev changes failed." : ''}${selfDev ? "\n- DB SCHEMA: if you change server/prisma/schema.prisma, you MUST also add a matching migration file server/prisma/selfdev-<slug>.sql in the SAME change — idempotent, ADDITIVE-ONLY DDL (CREATE TABLE IF NOT EXISTS, ALTER TABLE ... ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE TYPE, ALTER TYPE ... ADD VALUE), one statement per line, in the same plain style as the existing server/prisma/*.sql files. Never DROP or retype an existing column in self-dev. The push is blocked if a schema change ships without its migration." : ''}`;
}

export default async function handler({ user, body, res }) {
  // pageUrl/pageTitle: the embed widget's floating dock sends the front-end
  // URL it's currently open over (see public/plugin.js + Embed.jsx), so a
  // WordPress operator asking "what should I change here" gets an answer
  // grounded in the actual page in front of them, not a guess.
  const { projectId, message, fileUrls, focusPaths, pageUrl, pageTitle } = body || {};
  // 'context' (fast discuss/plan pass, no build pipeline) or 'build' (the
  // full planner→coder→reviewer flow). Anything unrecognised = 'build', so
  // existing callers that never send `mode` are unaffected.
  const mode = body?.mode === 'context' ? 'context' : 'build';
  if (!projectId || !message) throw Object.assign(new Error('projectId and message required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  // Default true (matches UserSettings.personality_enabled's DB default) when
  // no settings row exists yet — most accounts never touch this toggle.
  // Wrapped in try/catch: if the `personality_enabled` column hasn't been
  // added yet in a given environment (see add-personality-toggle.sql — it's
  // a manual one-time migration, not auto-applied), this lookup must not be
  // allowed to take down chat entirely. Fail open to the personality-on
  // default rather than 500ing every chat request.
  let systemPrompt = SYSTEM_PROMPT_PERSONALITY;
  try {
    const userSettings = await prisma.userSettings.findUnique({ where: { created_by_id: user.id } });
    if (userSettings?.personality_enabled === false) systemPrompt = SYSTEM_PROMPT_PLAIN;
  } catch (err) {
    console.error('[chatWithMorpheus] personality_enabled lookup failed, defaulting to personality on:', err.message);
  }
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // Self-dev projects (Morpheus developing Morpheus) are admin-only. Ownership
  // above already scopes this to the caller's own projects, but project_type
  // is a free field on the generic Project entity — a non-admin could in
  // principle create their own row with project_type 'self_dev', so this is
  // checked independently rather than relying on nothing else ever setting it.
  if (project.project_type === 'self_dev' && user.role !== 'admin') {
    throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  }

  // 2026-09-02 fix: ProjectFile's real uniqueness is [project_id, path] (see
  // schema.prisma) -- NOT scoped by who created the file. Filtering this
  // query by created_by_id: user.id (the pre-existing code) meant any file
  // in the project that happened to have a different created_by_id (e.g.
  // seeded by self-dev import, or created under an earlier/different admin
  // login) was invisible to both the AI's file-tree context AND to
  // applyFileOperations()'s "does this path already exist" check below --
  // the coder would then blindly attempt a `create()` on a path that
  // already existed project-wide, throwing a Prisma P2002 unique-constraint
  // crash and breaking chat entirely. Project-level access control is
  // already fully enforced above (project.created_by_id === user.id), so
  // scoping this by project_id alone is safe and matches the real
  // constraint.
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  // Bounded to the last 20 messages, matching the original
  // (base44/functions/chatWithMorpheus/entry.ts fetches `('created_date', 20)`).
  // A 2026-08-26 audit found an earlier version of this file loaded the
  // ENTIRE conversation history unbounded ("perpetual project memory") —
  // on a long-lived project that means every chat call re-sends a growing,
  // unbounded prompt to the AI: rising per-message cost and latency, and
  // eventually a context-window overflow. That's a real regression against
  // "scale to millions of users," not an improvement, so it's reverted to
  // the original's bounded window.
  const history = await prisma.chatMessage.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    orderBy: { created_date: 'desc' },
    take: 20,
  });
  history.reverse(); // back to chronological order for the prompt

  // Compressed memory of everything older than the 20-message window above
  // — without this, a project's early requirements/decisions would just be
  // silently forgotten once it outgrows the bounded window. See
  // lib/contextSummary.js. Computed before the new message is recorded, so
  // it reflects prior turns only, same as `history` above.
  const contextSummary = await getContextSummary(user.id, project, 'chat');

  await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'user', content: message } });

  const isSelfDev = project.project_type === 'self_dev';
  // A project connected to a live WordPress site (via the WEBSITE panel) is
  // editing a WP theme inside a real install, not building a standalone app —
  // this swaps the web-app-builder context blocks for the WordPress one.
  const wpConn = isSelfDev ? null : await getWpConnection(projectId, user.id).catch(() => null);
  const isWordPress = !!wpConn;
  const isWebApp = (project.compile_target || 'source') === 'web-app' && !isSelfDev && !isWordPress;

  // On a WordPress build turn, pull the theme files this request needs
  // straight from the connected repo, so the coder isn't working blind on
  // whatever happened to be hand-imported. Best-effort, never blocks chat.
  if (isWordPress && mode === 'build') {
    try {
      const pulled = await ensureWpFiles({ user, project, wpConn, message });
      if (pulled.added) {
        const fresh = await prisma.projectFile.findMany({ where: { project_id: projectId, path: { in: pulled.paths } } });
        for (const f of fresh) if (!files.some((x) => x.path === f.path)) files.push(f);
      }
    } catch (e) { console.error('[ensureWpFiles]', e.message); }
  }

  const totalFileBytes = files.reduce((sum, f) => sum + (f.content?.length || 0), 0);
  // Self-dev always scopes (its repo is huge); an ordinary project scopes
  // only once it's grown past the threshold — below that, "send everything"
  // stays the default and costs no extra AI call.
  const useScopedContext = isSelfDev || totalFileBytes > SCOPED_CONTEXT_THRESHOLD_BYTES;
  const orientation = isSelfDev
    ? SELF_DEV_ORIENTATION_FILES
    : GENERIC_ORIENTATION_FILES.filter((p) => files.some((f) => f.path === p));
  const manualPins = Array.isArray(focusPaths) && focusPaths.length > 0 ? focusPaths : null;

  let filesContext;
  let scopedNote = '';
  let researchNotes = '';
  let webNotes = '';
  let webSources = []; // [{ host, url }] from the web-research pass — shown to the operator
  let shownPaths = files.map((f) => f.path); // full send => everything is "shown"
  // A scoped-context BUILD turn with no manual pins gets the iterative
  // research pass (researchRepo) instead of a one-shot file guess — deferred
  // into the stream below so it can show as its own 'research' stage. Self-dev
  // always scopes; an ordinary project reaches this once it's past the size
  // threshold, which is exactly when a one-shot "guess the relevant files"
  // starts missing cross-file impact. Everything else resolves its context
  // here, before streaming starts.
  const deferResearch = useScopedContext && mode === 'build' && !manualPins;
  // Web research (a search + any pasted URLs) runs in the stream as its own
  // stage — in BUILD and CONTEXT mode — when the operator turns the WEB toggle
  // on (body.webAccess). Self-dev defaults it ON (it routinely needs current
  // library/API docs) unless the operator explicitly turned it off. The
  // pre-check decides whether to actually search, so a self-contained request
  // costs just one small call. Always "configured" now — free sources
  // (Wikipedia / arXiv / llms.txt / direct fetch) need nothing; a Gemini key
  // just adds the grounded-search tier (see lib/webResearch.js).
  const webWanted = body?.webAccess === true || (isSelfDev && body?.webAccess === undefined);
  const deferWeb = webWanted && webResearchConfigured();

  if (useScopedContext && !deferResearch) {
    let effectivePaths;
    let autoSelected = false;
    if (manualPins) {
      effectivePaths = manualPins;
    } else if (mode === 'context') {
      // Context mode is one fast call — skip the extra auto-select round-trip.
      effectivePaths = [];
    } else {
      effectivePaths = await autoSelectRelevantPaths(user.id, files, message, {
        limit: isSelfDev ? 6 : 10,
        fallback: orientation,
      });
      autoSelected = true;
    }
    const built = buildScopedFilesContext(files, effectivePaths, orientation, SCOPED_MAX_CONTEXT_BYTES);
    filesContext = built.text;
    shownPaths = built.shown;
    if (mode === 'build') scopedNote = scopedContextNote(built.shown, { selfDev: isSelfDev, autoSelected });
  } else if (!useScopedContext) {
    filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
  }
  let shownPathSet = new Set(shownPaths);
  const historyContext = history.map((h) => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';
  const summaryBlock = formatContextSummaryBlock(contextSummary);

  const referenceNote = fileUrls && fileUrls.length > 0
    ? `\n\nThe operator has uploaded ${fileUrls.length} reference file(s) for you to review and design against. Examine them carefully and use them as the design reference for your work.`
    : '';

  // For web-app targets, append the shared design system so the planner
  // and coder build on a polished, consistent base instead of raw HTML.
  const designBlock = isWebApp ? designSystemPromptBlock() : '';

  // WordPress site context — replaces the web-app-builder blocks below when
  // the project is connected to a live WP site (see lib/projectWordpress.js).
  const wordpressBlock = isWordPress
    ? wordpressPromptBlock({ repo: wpConn.repo || project.github_repo, files })
    : '';

  // "What is the operator looking at right now" — only ever set by the
  // floating embed widget on a WordPress project. Best-effort: the plugin
  // resolves the URL via WP's own rewrite rules (any permalink structure,
  // any theme) and hands back the product/page it matched, if any. Never
  // blocks chat if the site is slow/unreachable/on an old plugin version.
  // `resolvedPage` (the plugin's raw match, or null) is reused below in
  // CONTEXT MODE to ground a proposed lifecycle action (trash/publish/
  // restock) in real, already-verified data — never in whatever an LLM
  // free-form invents.
  let resolvedPage = null;
  const currentPageBlock = (isWordPress && pageUrl) ? await (async () => {
    try {
      const res = await wpStore(wpConn, 'resolve_url', { url: pageUrl });
      const r = res?.data;
      if (!res?.ok || !r) return `\nOPERATOR'S CURRENT PAGE: ${pageUrl}${pageTitle ? ` ("${pageTitle}")` : ''} — could not resolve what this is; answer from the URL alone.\n`;
      if (!r.resolved) {
        return `\nOPERATOR'S CURRENT PAGE: ${pageUrl}${pageTitle ? ` ("${pageTitle}")` : ''} — not a page/post/product Morpheus recognises (could be a 404, a theme-generated archive, or a plugin-rendered view).\n`;
      }
      if (r.kind === 'home') {
        return `\nOPERATOR'S CURRENT PAGE: the homepage (${pageUrl}).\n`;
      }
      resolvedPage = r;
      const detail = r.product
        ? `product "${r.product.name}" — ${r.product.status}, ${r.product.price ? `$${r.product.price}` : 'no price'}${r.product.stock != null ? `, ${r.product.stock} in stock` : ''}`
        : r.page
          ? `page "${r.page.title}" — ${r.page.status}`
          : `${r.kind} "${r.title}" — ${r.status}`;
      return `\nOPERATOR'S CURRENT PAGE — they are looking at this right now, in front of them, not just describing it: ${pageUrl}\nResolves to: ${detail} (id ${r.id}). Ground your answer in this specific ${r.kind} when they ask about "this page" / "here" / "what's in front of me".\n\nIf — and only if — they clearly ask to trash/publish/unpublish THIS item or change ITS stock, set proposeAction accordingly (see the response schema); you are never executing it yourself, only flagging the intent for the operator to confirm.\n`;
    } catch {
      return `\nOPERATOR'S CURRENT PAGE: ${pageUrl}${pageTitle ? ` ("${pageTitle}")` : ''} — could not reach the site to resolve it; answer from the URL alone.\n`;
    }
  })() : '';

  // Brand kit (.morpheus/brand.json in the project): the operator's colours,
  // fonts, radius, logo and voice as HARD token values. Web builds and
  // WordPress restyles both benefit; empty when still on defaults.
  const brandBlock = (isWebApp || isWordPress)
    ? brandPromptBlock(await getBrand(projectId).catch(() => null))
    : '';

  // Feature plan (originally self-dev A1, now any project): if a feature is
  // active for this project, the planner gets its goal + step list + which
  // step is active, so a multi-turn feature stays coherent instead of each
  // turn re-deriving intent from one message. Build turns only; best-effort.
  // If NO feature is active, the planner may auto-escalate a big job into one
  // (see MULTI-STEP ESCALATION + the post-planner block below).
  const activeFeature = (mode === 'build')
    ? await getActiveFeature(projectId).catch(() => null)
    : null;
  const featureBlock = featureContextBlock(activeFeature);
  // A scoped feature (e.g. a Jarvis-triggered widget build, scope_policy:
  // 'widget_build') restricts which files this turn's applyFileOperations
  // calls may write — null for every normal self-dev/project build, which
  // keeps today's unrestricted behavior unchanged.
  const engineScopePolicy = activeFeature?.scopePolicy ? resolvePolicy(activeFeature.scopePolicy) : null;

  // Decisions log (originally self-dev Tier 2 #7, now every project): the last
  // few "what changed / why" entries, so the planner builds on past decisions
  // instead of contradicting them. Target-agnostic. Build turns only.
  const decisionsBlock = (mode === 'build')
    ? await recentDecisionsBlock(projectId).catch(() => '')
    : '';

  // Media Library: the project's content assets (photos, posters, media) with
  // their exact urls, so the coder writes real <img src> instead of inventing
  // paths or reaching for a placeholder service. Zero-custody — these are just
  // urls. Not for self-dev (Morpheus's own site has no operator media).
  const mediaBlock = (mode === 'build' && !isSelfDev && !isWordPress)
    ? mediaAssetsBlock(await getProjectAssets(projectId))
    : '';

  // 2026-09-08 (Rob: "need to look at the functionality of the AI docs and
  // be able to feed that into morpheus every construct so the planner has a
  // better idea of how to build"): compileProject.js's adapters
  // (server/src/lib/compile-targets/*.js) each carry hard-won, specific
  // knowledge of what they'll actually do with a project's files at compile
  // time -- accrued from real reported build failures (see mac-app.js's
  // comments, e.g. the Node-wrapper-around-a-real-Swift-app misroute, the
  // pkg/lipo fat-binary corruption). None of that ever reached the planner
  // or coder -- BUILD_TARGET_INSTRUCTIONS above only has generic,
  // hand-written guidance per target that can't see the adapter's actual
  // behavior and drifts out of sync with it. An adapter that declares an
  // `aiNotes` field (mac-app, ios-app, rpi-distro, linux-distro so far --
  // add to more adapters as they accumulate their own hard-won gotchas)
  // gets that note surfaced here, straight from
  // the adapter code itself so it can't go stale, on every construct/edit
  // turn for a project on that target -- same mechanism as designBlock above.
  const compileAdapterBlock = (() => {
    const target = project.compile_target || 'source';
    if (target === 'source' || isSelfDev) return '';
    const adapter = getCompileTarget(target);
    return adapter?.aiNotes ? `\n${adapter.aiNotes}\n` : '';
  })();

  // Publish readiness: what a *shipped* build of this target includes (each
  // adapter declares its own — lib/publishChecklist.js). Surfaced so output
  // lands launch-ready. Build turns, non-self-dev.
  const publishBlock = (mode === 'build' && isWebApp)
    ? publishPromptBlock(project.compile_target || 'source')
    : '';

  // Forms delivery: if the operator has configured where this site's <form>
  // submissions go (.morpheus/forms.json — netlify | smtp | sheet), hand the
  // coder the delivery contract so every form it builds actually delivers to
  // the operator's own inbox/sheet. Zero-custody: no submission touches
  // Morpheus. Web builds only, non-self-dev.
  const formsBlock = (mode === 'build' && isWebApp)
    ? formsPromptBlock(await getForms(projectId).catch(() => null))
    : '';

  // Production domain: once the operator sets .morpheus/site.json, hand the
  // coder the real origin so absolute URLs (og:image, canonical, sitemap
  // <loc>, JSON-LD) are correct instead of guessed. Web builds only,
  // non-self-dev.
  const siteBlock = (mode === 'build' && isWebApp)
    ? sitePromptBlock(await getSite(projectId).catch(() => null))
    : '';

  // Light CMS: on a web build, tell the coder to externalise editable copy
  // and lists into content/*.json so the operator can change them from the
  // CONTENT panel without a rebuild. Web builds only, non-self-dev.
  const cmsBlock = (mode === 'build' && isWebApp)
    ? cmsPromptBlock()
    : '';

  // Analytics: once the operator picks a (cookieless, free) provider in the
  // DOMAIN panel, hand the coder the exact <script> to embed in <head>.
  const analyticsBlock = (mode === 'build' && isWebApp)
    ? analyticsPromptBlock(await getAnalytics(projectId).catch(() => null))
    : '';

  const assembleContextBlock = () => `
PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
${isWordPress ? 'TARGET: WordPress site (live) — see the WORDPRESS SITE notes below' : `COMPILE TARGET: ${project.compile_target || 'source'}`}
${summaryBlock}
${featureBlock}${decisionsBlock}${mediaBlock}${webNotes ? `\nWEB RESEARCH (current external info found before planning — prefer this over stale assumptions):\n${webNotes}\n` : ''}${researchNotes ? `\nRESEARCH FINDINGS (from investigating the repo before planning):\n${researchNotes}\n` : ''}
CURRENT FILES:
${filesContext}
${scopedNote}

CONVERSATION HISTORY:
${historyContext}
${wordpressBlock}${currentPageBlock}${brandBlock}${designBlock}${compileAdapterBlock}${publishBlock}${formsBlock}${siteBlock}${cmsBlock}${analyticsBlock}
OPERATOR SAYS: ${message}`;
  // Fully resolved now unless a research pass still has to run (repo and/or
  // web — deferred into the stream); reassigned there.
  let contextBlock = (deferResearch || deferWeb) ? '' : assembleContextBlock();

  // From here on the response streams: zero or more {type:'stage',...}
  // progress events (see makeStageEmitter above) followed by exactly one
  // terminal {type:'result', data} or {type:'error', ...} line. Everything
  // above this point can still throw normally — a bad projectId, a missing
  // project, a self-dev permission failure — and get the router's usual
  // clean JSON error response (functions.routes.js), since no headers have
  // been sent yet. Once we're streaming, any failure (including
  // InsufficientCreditsError from a later invokeAI call — the credit check
  // happens per-call, not just on the first one) is caught below and sent as
  // a {type:'error'} line instead, since the HTTP status/headers can't
  // change after res.writeHead.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // hint to any nginx-style proxy in front of this: don't buffer, flush each line
  });
  const emit = (event) => { try { res.write(JSON.stringify(event) + '\n'); } catch { /* client disconnected mid-stream */ } };
  const stages = makeStageEmitter(emit);

  try {
    // ── Phase 0a: Web research — search + read pasted URLs before planning ──
    // Runs for both CONTEXT and BUILD mode (it's just as useful when
    // discussing an approach as when building it).
    if (deferWeb) {
      stages.start('web');
      const web = await researchWeb(user.id, message);
      webNotes = web.notes;
      webSources = web.sources;
      contextBlock = assembleContextBlock();
      stages.done('web');
    }
    const sourcesLine = webSources.length
      ? `\n\n// SOURCES: ${webSources.slice(0, 6).map((s) => `${s.host} <${s.url}>`).join('  ·  ')}`
      : '';

    // ── CONTEXT MODE: one fast pass, no build pipeline ─────────────────────
    // See CONTEXT_MODE_INSTRUCTIONS. Aside from the web stage above, no stage
    // events are emitted, so the chat shows a plain thinking indicator instead
    // of the pipeline graphic; no snapshot is taken and fileOperations is
    // always empty.
    if (mode === 'context') {
      // Only worth asking the model for a lifecycle-action proposal when
      // there's an already-verified product/page in front of the operator
      // to act on (resolvedPage, from the currentPageBlock resolve_url call
      // above) — otherwise there's nothing safe to ground it in, so don't
      // even offer the fields (keeps the schema, and the odds of a spurious
      // proposal, down).
      const actionKind = resolvedPage?.product ? 'product' : resolvedPage?.page ? 'page' : null;
      // Bulk: the operator names several products by name in one message
      // ("unpublish the Strat, the ES335 and the P-Bass") rather than acting
      // on the single item resolvedPage grounds. Offered whenever the site
      // is connected — not gated on being on a product page — but each name
      // still has to resolve to a real, unambiguous live product before
      // anything is proposed (see below); the model only ever picks names +
      // a verb, never an id.
      const ctx = await invokeAI({
        userId: user.id,
        prompt: `${systemPrompt}${CONTEXT_MODE_INSTRUCTIONS}\n${contextBlock}${referenceNote}\n\nRespond now.`,
        schema: {
          type: 'object',
          properties: {
            reply: { type: 'string', description: 'Morpheus response to the operator, in character — discussion, questions, or a prose plan. Never code.' },
            ...(actionKind ? {
              proposeAction: { type: 'boolean', description: `true ONLY if the operator clearly asked to trash, publish, unpublish${actionKind === 'product' ? ', or restock' : ''} the item named in OPERATOR'S CURRENT PAGE above, and you are certain that is the item they mean, AND they named exactly one item (more than one → use proposeBulkAction instead). false for anything vague, ambiguous, or about a DIFFERENT item — ask a clarifying question in reply instead of guessing.` },
              actionType: { type: 'string', enum: actionKind === 'product' ? ['trash', 'publish', 'unpublish', 'set_stock'] : ['trash', 'publish', 'unpublish'], description: 'only meaningful when proposeAction is true' },
              ...(actionKind === 'product' ? { stockQuantity: { type: 'number', description: 'only when actionType is set_stock — the new quantity the operator asked for' } } : {}),
            } : {}),
            ...(isWordPress ? {
              proposeBulkAction: { type: 'boolean', description: 'true ONLY if the operator clearly named TWO OR MORE specific products by name (not a category, not "all products", not an open-ended query) and asked to trash, publish, unpublish, or restock all of them the same way. false otherwise — for a single item use proposeAction instead; for anything vague or open-ended, ask a clarifying question in reply instead of guessing.' },
              bulkActionType: { type: 'string', enum: ['trash', 'publish', 'unpublish', 'set_stock'], description: 'only meaningful when proposeBulkAction is true — the ONE verb applied to every named product' },
              bulkProductNames: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'only when proposeBulkAction is true — each product exactly as the operator named it, up to 10' },
              bulkStockQuantity: { type: 'number', description: 'only when bulkActionType is set_stock — the same new quantity for every named product' },
            } : {}),
          },
          required: ['reply'],
        },
        fileUrls,
        role: 'planner',
        maxTokens: 6000,
      });
      const ctxReply = (ctx.result.reply || '...') + sourcesLine;
      await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content: ctxReply } });
      const ctxToolchain = buildToolchain(ctx.provider, { planner: ctx.model });
      await logUsage(user.id, 'chat_simple', projectId, project.name, {
        messageLength: message.length,
        mode: 'context',
        ...ctxToolchain,
      });

      // Build the actual plugin call server-side from resolvedPage (real,
      // already-verified data) + the model's chosen verb — never from
      // anything the model output directly, so a proposal can never name an
      // arbitrary action or id.
      let proposedAction = null;
      if (actionKind && ctx.result.proposeAction && ctx.result.actionType) {
        const name = resolvedPage.product?.name || resolvedPage.page?.title;
        const verb = ctx.result.actionType;
        if (verb === 'trash') {
          proposedAction = { action: actionKind === 'product' ? 'delete_product' : 'delete_page', data: { id: resolvedPage.id }, label: `Trash "${name}"`, kind: actionKind };
        } else if (verb === 'publish' || verb === 'unpublish') {
          proposedAction = { action: actionKind === 'product' ? 'update_product' : 'update_page', data: { id: resolvedPage.id, status: verb === 'publish' ? 'publish' : 'draft' }, label: `${verb === 'publish' ? 'Publish' : 'Unpublish'} "${name}"`, kind: actionKind };
        } else if (verb === 'set_stock' && actionKind === 'product' && Number.isFinite(ctx.result.stockQuantity)) {
          const qty = Math.max(0, Math.round(ctx.result.stockQuantity));
          proposedAction = { action: 'set_stock', data: { id: resolvedPage.id, quantity: qty }, label: `Set stock to ${qty} for "${name}"`, kind: actionKind };
        }
      }

      // Bulk: resolve each named product against the LIVE store — a name is
      // only ever accepted when it matches exactly one real product
      // (case-insensitive, whole-name). Anything ambiguous or not found is
      // dropped into `unresolved` and surfaced to the operator instead of
      // guessed at. Same rule as the single-item path: the model chose
      // names + a verb, everything else (ids, the actual plugin call) is
      // built here from data the plugin itself just confirmed exists.
      let proposedBulkAction = null;
      if (isWordPress && ctx.result.proposeBulkAction && ctx.result.bulkActionType && Array.isArray(ctx.result.bulkProductNames) && ctx.result.bulkProductNames.length) {
        const verb = ctx.result.bulkActionType;
        const names = ctx.result.bulkProductNames.slice(0, 10).map((n) => String(n || '').trim()).filter(Boolean);
        const qty = verb === 'set_stock' && Number.isFinite(ctx.result.bulkStockQuantity) ? Math.max(0, Math.round(ctx.result.bulkStockQuantity)) : null;
        const resolvedItems = [];
        const unresolved = [];
        for (const name of names) {
          try {
            const res = await wpStore(wpConn, 'list_products', { search: name, limit: 10 });
            const matches = (res?.data?.products || []).filter((p) => (p.name || '').trim().toLowerCase() === name.toLowerCase());
            if (matches.length !== 1) { unresolved.push(name); continue; }
            const p = matches[0];
            const action = verb === 'trash' ? 'delete_product' : verb === 'set_stock' ? 'set_stock' : 'update_product';
            const data = verb === 'trash' ? { id: p.id }
              : verb === 'set_stock' ? { id: p.id, quantity: qty ?? 0 }
                : { id: p.id, status: verb === 'publish' ? 'publish' : 'draft' };
            resolvedItems.push({ action, data, label: p.name, id: p.id });
          } catch {
            unresolved.push(name);
          }
        }
        if (resolvedItems.length) {
          const verbLabel = verb === 'trash' ? 'Trash' : verb === 'publish' ? 'Publish' : verb === 'unpublish' ? 'Unpublish' : `Set stock to ${qty ?? 0} for`;
          proposedBulkAction = {
            actionType: verb,
            items: resolvedItems,
            unresolved,
            label: `${verbLabel} ${resolvedItems.length} product${resolvedItems.length === 1 ? '' : 's'}`,
          };
        }
      }

      emit({ type: 'result', data: { reply: ctxReply, fileOperations: [], mode: 'context', proposedAction, proposedBulkAction } });
      return;
    }

    // ── Phase 0b: Repo research — investigate the codebase before planning ──
    // Any scoped-context build with no manual pins (deferResearch): self-dev,
    // or an ordinary project past the size threshold. Turns "guess the
    // relevant files" into "actually read the call graph". A smaller repo
    // needs a smaller budget than the self-dev monorepo.
    if (deferResearch) {
      stages.start('research');
      const research = await researchRepo(user.id, files, message,
        isSelfDev ? {} : { maxRounds: 2, maxFiles: 10 });
      researchNotes = research.notes || '';
      const built = buildScopedFilesContext(files, research.readPaths || [], orientation, SCOPED_MAX_CONTEXT_BYTES);
      filesContext = built.text;
      shownPaths = built.shown;
      shownPathSet = new Set(shownPaths);
      scopedNote = scopedContextNote(built.shown, { selfDev: isSelfDev, autoSelected: true });
      contextBlock = assembleContextBlock();
      stages.done('research');
    }

    // ── Phase 1: Planner reasons about intent and design ────────────────────
    if (isSelfDev) {
      const constructMatch = message.match(/(?:about|for|of|regarding)\s+[\"']?([^\"',.!?]+)[\"']?/i);
      const constructCandidate = constructMatch?.[1]?.trim() || message.trim();
      if (constructCandidate) {
        const constructCtx = await getConstructContext(user.id, constructCandidate);
        if (constructCtx) {
          contextBlock += `\n\n## Construct Context (auto-fetched)\nThe operator's message references construct/project \"${constructCandidate}\". Here is its recent history and compile attempts:\n${constructCtx}`;
        }
      }
      // Self-diagnosis tools (2026-09-15): before this, self-dev's AI turn
      // could only ever reason from static context assembled up front — no
      // way to actually check production logs, query the DB, run a real
      // command, or look at a live screenshot itself, even though a human
      // admin can already do all of that through the Admin Panel. See
      // selfDevTools.js for the registry (extensible — add a tool there and
      // it's picked up here automatically) and the investigation loop below.
      contextBlock += `\n\nSELF-DIAGNOSIS TOOLS AVAILABLE — before finalizing your plan, if this turn is about investigating a live production issue (a crash, an error report, unexpected behavior), you may request one or more of these read-only tools and see real results before deciding your plan:\n${selfDevToolsPromptBlock()}\nRequest them via the \`toolCalls\` field below. Only use these when genuinely diagnosing something live — not for routine feature work you can already reason about from the repo context already shown.`;
    }

    stages.start('planner');
    let planner;
    let toolResultsBlock = '';
    const toolScreenshotUrls = [];
    for (let round = 0; ; round++) {
      const allowToolCalls = isSelfDev && round < SELF_DEV_TOOL_MAX_ROUNDS;
      planner = await invokeAI({
        userId: user.id,
        prompt: `${systemPrompt}${PLANNER_INSTRUCTIONS}\n${contextBlock}${referenceNote}${toolResultsBlock}\n\nRespond now.`,
        schema: {
          type: 'object',
          properties: {
            reply: { type: 'string', description: 'Morpheus response in character, concise for builds, fuller for conversation, or ONLY clarifying questions when needsClarification is true' },
            needsCode: { type: 'boolean', description: 'true if code needs to be written/modified, false for pure conversation' },
            needsClarification: { type: 'boolean', description: 'true ONLY if a genuine build-blocking ambiguity prevents building correctly — reply then contains just the clarifying questions' },
            plan: { type: 'string', description: 'Detailed file-by-file build plan with implementation notes (only when needsCode is true AND needsClarification is false). When featureSteps is set, this covers only the first step.' },
            plannedFiles: { type: 'array', items: { type: 'string' }, description: 'Ordered list of every file path this build will create or modify (only when needsCode is true AND needsClarification is false) — the coder implements this list a few files at a time' },
            featureTitle: { type: 'string', description: 'MULTI-STEP ESCALATION only: a 2-5 word name for a job too big for one turn.' },
            featureSteps: { type: 'array', items: { type: 'string' }, description: 'MULTI-STEP ESCALATION only: 3-8 ordered, individually shippable step titles. When set, plan/plannedFiles cover only the first.' },
            stepComplete: { type: 'boolean', description: 'When an ACTIVE FEATURE is shown in your context: true if THIS turn fully completes the active step (advance to the next); false if it is a tweak/fix still within the active step.' },
            decisionSummary: { type: 'string', description: 'CODE BUILDS ONLY. One line: what this change does. Recorded in the decisions log and shown to future planning turns.' },
            decisionRationale: { type: 'string', description: 'CODE BUILDS ONLY. One line: why — the reasoning or constraint behind the approach, so a later change does not undo it by accident.' },
            externalApis: {
              type: 'array',
              description: 'If this plan has the coder call a real external HTTP API (a third-party service, a public data source) whose exact URL/response shape you are not certain of from a source already shown to you in this conversation, list each real endpoint URL here — up to 5 — so it gets actually called and verified before any code is written against it. Leave empty for plans that touch no external API, or that only use one whose shape is already confirmed in your context above.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'The exact, real URL to test — a GET request will be made to it verbatim.' },
                  why: { type: 'string', description: 'What this call is for, one short phrase.' },
                },
              },
            },
            ...(allowToolCalls ? {
              toolCalls: {
                type: 'array',
                description: `SELF-DEV ONLY. Up to ${SELF_DEV_TOOL_MAX_CALLS_PER_ROUND} read-only diagnostic tool calls to make BEFORE finalizing your plan/reply — only when genuinely diagnosing a live issue. Leave empty/omit once you have enough to answer or plan.`,
                items: {
                  type: 'object',
                  properties: {
                    tool: { type: 'string', description: 'One of the self-diagnosis tool names listed above.' },
                    args: { type: 'object', description: 'Arguments for that tool, per its description.' },
                  },
                },
              },
            } : {}),
          }
        },
        fileUrls: toolScreenshotUrls.length ? [...(fileUrls || []), ...toolScreenshotUrls] : fileUrls,
        role: 'planner',
        // 2026-09-03 correction: this 3000 cap (set earlier today purely for
        // latency) turned out to be the ACTUAL cause of the OUTPUT_TRUNCATED
        // failures Rob kept hitting -- confirmed from the runtime logs, which
        // showed the throw coming from this exact call, not the Coder. A
        // detailed file-by-file plan with implementation notes/rationale, now
        // also carrying the full plannedFiles list the chunked Coder pass
        // depends on, routinely needs more than 3000 tokens for any real
        // multi-file build -- so EVERY build was dying here, on the very first
        // AI call, before the Coder chunking fix below ever got a chance to
        // run. Raised to a still-bounded but realistic 12000.
        //
        // 2026-09-04 (Rob hit OUTPUT_TRUNCATED role=planner maxTokens=12000 on
        // his original, most mature AnyPDF project — the one with the most
        // accumulated files/history of the three AnyPDF constructs, so the
        // most likely to produce a genuinely large plan): 12000 turned out to
        // be the same story one size up. Unlike the Coder's full file content
        // (truly unbounded — that's why it's chunked, not capped), the
        // Planner's own output is a plan description plus a plain path list,
        // which is naturally far more compressible — so this round pairs the
        // usual "raise the ceiling" with actually tightening the instructions
        // (see PLANNER_INSTRUCTIONS' "KEEP THE PLAN CONCISE" rule above) so a
        // big build doesn't reflexively need a bigger cap next time too. Raised
        // to 24000, matching CODER_STEP_MAX_TOKENS' scale below — generous
        // headroom for a real many-file plan without chasing an unbounded
        // number the way the Coder's is.
        maxTokens: 24000,
      });

      const requested = allowToolCalls && Array.isArray(planner.result?.toolCalls)
        ? planner.result.toolCalls.filter((c) => c && typeof c.tool === 'string').slice(0, SELF_DEV_TOOL_MAX_CALLS_PER_ROUND)
        : [];
      if (!requested.length) break; // done investigating, or the cap was already reached

      stages.start('diagnose');
      const toolResults = await runSelfDevToolCalls(user, project, requested); // never throws
      toolResultsBlock += formatSelfDevToolResultsBlock(toolResults, round + 1);
      toolScreenshotUrls.push(...extractScreenshotUrls(toolResults));
      stages.done('diagnose');
    }
    stages.done('planner');

    const plannerResult = planner.result;
    const reply = plannerResult.reply || '...';
    const needsCode = !!plannerResult.needsCode;
    const needsClarification = !!plannerResult.needsClarification;

    // ── Auto-escalation: a job too big for one turn becomes a feature ──────
    // The planner returned a step breakdown; record it as the project's
    // active feature (step 1 active) and let the build below proceed on
    // step 1 only (the planner scoped its plan/plannedFiles to it). Skipped
    // if a feature is already active, if the operator is just asking a
    // question, or if the table isn't migrated.
    let escalatedFeature = null;
    if (needsCode && !needsClarification && !activeFeature
        && Array.isArray(plannerResult.featureSteps) && plannerResult.featureSteps.length >= 3) {
      escalatedFeature = await createFeature(user.id, projectId, {
        title: plannerResult.featureTitle,
        goal: message,
        stepTitles: plannerResult.featureSteps,
      });
    }

    // ── Clarification gate: if the Planner is genuinely unsure, ask before building ─
    if (needsClarification) {
      await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content: reply } });
      const toolchain = buildToolchain(planner.provider, { planner: planner.model });
      await logUsage(user.id, 'chat_simple', projectId, project.name, {
        messageLength: message.length,
        needsCode,
        needsClarification: true,
        ...toolchain,
      });
      emit({ type: 'result', data: { reply, fileOperations: [], needsClarification: true } });
      return;
    }

    // ── Phase 2: Coder implements the plan (only if code is needed) ────────────
    let appliedOps = [];
    let editFailPaths = []; // files whose diff edits never matched (surfaced in the reply)
    let syntaxCritical = []; // files that still didn't parse after a fix attempt
    // The caller and schema gates report rather than retry, so their findings are kept apart
    // from `syntaxCritical`: one list told the user a broken caller was "a syntax error after
    // 2 fix attempts", which was wrong about the kind of error AND about the attempts.
    let callerCritical = []; // imports this change breaks (no fix loop — it reports)
    let schemaCritical = []; // Prisma columns that do not exist (no fix loop — it reports)

    // Rework attribution (2026-09-24): a third of code-producing turns need
    // more than one coder pass, and the call data could not say WHICH of the
    // three retry loops demanded it — the syntax gate, the bundle/deep-verify
    // gate, or the reviewer. Identical numbers, opposite fixes: one is a bad
    // coder prompt, another is a fragile import graph, the third is a strict
    // reviewer. Counted per gate and carried in the turn's RESULT, not just a
    // log line, so it lands in the durable run record where a run can be read
    // back days later instead of reconstructed.
    let syntaxFixAttempts = 0;
    let bundleFixAttempts = 0;
    // Counted separately from `bundle` on purpose. The deep-verify fix loop now
    // also carries Morpheus's house rules (lib/conventionChecks.js), and folding
    // those into the bundle count would make the run record say the code failed to
    // bundle when what it actually did was take the wrong ink rung.
    let conventionFixAttempts = 0;
    let reviewerFixAttempts = 0;
    let deepVerifyCritical = []; // self-dev: still breaks the wider repo after a fix attempt
    const MAX_GATE_ATTEMPTS = 3; // real fix-and-recheck attempts for both gates below, not just one retry
    let a11yNotes = []; // accessibility issues left after a fix attempt (web-app)
    let polishCount = 0;
    let coderModel;
    let reviewerModel;
    let reviewSummary;
    let reviewIssues = [];
    if (needsCode && plannerResult.plan) {
      // Nudge toward diff edits only where the coder is working against an
      // existing, possibly-large file (self-dev / large project). A fresh
      // build is almost all creates — leave it alone.
      const diffModeNote = useScopedContext
        ? '\n\nThis project already has working code. For any "update" to an existing file longer than ~60 lines, use `edits` (exact find/replace copied from the current content shown to you) rather than re-emitting the whole file — it is safer and cannot accidentally drop code you did not mention.'
        : '';

      // ── External API pre-flight (2026-09-12, the Alice-stats incident) ────
      // The planner flagged real endpoint URLs it's not certain of — actually
      // call them now, before the coder writes a single line against them.
      // A hallucinated route or a guessed username shows up here as a real
      // 404, not a recollection the coder has no way to double-check itself.
      let apiCheckBlock = '';
      if (Array.isArray(plannerResult.externalApis) && plannerResult.externalApis.length > 0) {
        stages.start('api_check');
        try {
          const apiResults = await verifyExternalApiCalls(plannerResult.externalApis);
          apiCheckBlock = formatApiCheckBlock(apiResults);
        } catch (err) {
          console.error('[chatWithMorpheus] external API check failed:', err.message);
        }
        stages.done('api_check');
      }

      // ── Existing-implementation pre-flight — REMOVED 2026-09-25 ──────────
      // It lived here: a model call that asked whether any existing file already did
      // the job of a file the plan was about to create, and if so appended a
      // `DO NOT REINVENT — use X` block to the coder prompt. It was aimed at a real
      // failure (a status endpoint that guessed lib/containerMemory.js's export names
      // and then reimplemented cgroup parsing).
      //
      // It was removed on measurement, not on taste. Asked for a new
      // `getContainerMemory.js` whose job `server/src/lib/containerMemory.js` already
      // does — the least subtle duplication in the repo — it named NOTHING in 8 runs
      // out of 8, at pro @ 0.7 and flash @ 0.4 alike, including 4 runs after it was
      // handed a shortlist with that module's exported symbols listed on it. Across
      // every chat record that has ever existed, `rework.reuse` was 0: no match it
      // named was ever even ignored. Meanwhile the coder found and imported the right
      // module unaided 8/8.
      //
      // The likely cause is the prompt's own escape hatch — "be strict, naming a file
      // that does not actually do the job is worse than naming nothing" — which makes
      // silence the always-safe answer for a model asked to *decide* whether to speak.
      // Before re-adding this, note that its model and temperature were never the
      // lever (two different models scored identically) and that the obvious
      // name-overlap rule was already measured and rejected as a gate.
      //
      // If it is ever wanted back, the cheap version is not a model call at all:
      // lib/reusePreflight.js shortlisted candidates by exported symbols for free, and
      // the top hit above a score threshold is a hint the coder can take or ignore.
      // That is name-overlap-as-a-hint, which the 158-pair ruling does NOT cover, so
      // it would need its own measurement. The harness is at
      // staging/model-test-harness/preflight-ab.mjs.
      //
      // `lib/reuseCheck.js` and `lib/reusePreflight.js` went with it. `rework` keeps
      // its other counters; only `reuse` and `reusePreflight` were dropped.


      // coderPrompt (the full-plan version, no per-step file scoping) is kept
      // around for reviewAndRetry below — a critical-issue retry re-sends this
      // same base prompt plus the specific files that need fixing, so it needs
      // the complete, unscoped instructions rather than whichever chunk's
      // narrowed prompt happened to run last.
      const coderPrompt = `${systemPrompt}${CODER_INSTRUCTIONS}${diffModeNote}\n${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}${apiCheckBlock}\n\nImplement this plan now. Write the actual code files.`;
      const coderSchema = {
        type: 'object',
        properties: {
          fileOperations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                action: { type: 'string', enum: ['create', 'update', 'delete'] },
                edits: {
                  type: 'array',
                  description: 'For a targeted "update" to a large file — used instead of content. Each { find, replace }: find is exact current text, replace is the new text.',
                  items: {
                    type: 'object',
                    properties: { find: { type: 'string' }, replace: { type: 'string' } },
                  },
                },
              }
            }
          }
        }
      };
      const plannedFiles = Array.isArray(plannerResult.plannedFiles)
        ? plannerResult.plannedFiles.filter((p) => typeof p === 'string' && p)
        : [];

      let fileOps = [];
      // Files the coder could not produce because its output was cut off by the token limit, even
      // after a one-file retry. Named in the reply — a partial build must never read as complete.
      const truncatedFiles = [];
      let coderModelLast;
      stages.start('coder');

      if (plannedFiles.length > 0) {
        // Chunked path — see MAX_FILES_PER_CODER_STEP's comment above. Each
        // call only has to hold a few files' worth of code, so no single
        // completion can overflow regardless of how big the overall build is.
        const chunks = [];
        for (let i = 0; i < plannedFiles.length; i += MAX_FILES_PER_CODER_STEP) {
          chunks.push(plannedFiles.slice(i, i + MAX_FILES_PER_CODER_STEP));
        }
        for (const [chunkIdx, chunk] of chunks.entries()) {
          // Multiple chunks all share one stages.start/done('coder') pair —
          // this makes each individual chunk call's timing visible too, not
          // just "coder started" once for however many chunks there are.
          console.log(`[chatWithMorpheus] coder chunk ${chunkIdx + 1}/${chunks.length} starting: ${chunk.join(', ')}`);
          const chunkStartedAt = Date.now();
          // When context is scoped (large/self-dev project), the shared
          // contextBlock may not carry this chunk's files' content. Give the
          // coder the CURRENT content of every existing file it's about to
          // implement, so an "update" is never written blind from memory.
          const chunkCurrent = chunk
            .filter((p) => !shownPathSet.has(p))
            .map((p) => files.find((f) => f.path === p))
            .filter(Boolean)
            .map((f) => `--- ${f.path} (current content) ---\n${f.content}`)
            .join('\n\n');
          const chunkCurrentBlock = chunkCurrent ? `\n\nCURRENT CONTENT OF THE FILE(S) FOR THIS STEP:\n${chunkCurrent}` : '';
          const chunkPrompt = `${systemPrompt}${CODER_INSTRUCTIONS}${diffModeNote}\n${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}${apiCheckBlock}\n\nFULL FILE LIST FOR THIS BUILD (for context only — do not write these now): ${plannedFiles.join(', ')}${chunkCurrentBlock}\n\nFOR THIS STEP, implement ONLY these file(s): ${chunk.join(', ')}. Return fileOperations for ONLY these file(s) — nothing else. For each: full \`content\` (a create, or a small file), or \`edits\` (a targeted change to a large existing file). Never partial content.`;
          // A truncated completion THROWS (server/src/ai.js). Unwrapped, that one throw discarded the
          // ENTIRE turn — every chunk already generated, the plan, the review and the reply — even
          // though autonomousBuildStep.js has caught exactly this since it was written. The chunked
          // path exists BECAUSE a completion can overflow, so answering an anticipated failure by
          // throwing away the work already produced was the worst available response to it.
          //
          // Only truncation is recoverable; any other error still throws. Nothing already produced is
          // discarded, and a partial build is never reported as complete — see the reply below.
          try {
            const chunkCoder = await invokeAI({
              userId: user.id,
              prompt: chunkPrompt,
              schema: coderSchema,
              fileUrls,
              role: 'coder',
              maxTokens: CODER_STEP_MAX_TOKENS,
            });
            coderModelLast = chunkCoder.model;
            const chunkOps = Array.isArray(chunkCoder.result.fileOperations) ? chunkCoder.result.fileOperations : [];
            fileOps.push(...chunkOps);
          } catch (chunkErr) {
            if (!String(chunkErr?.message || '').includes('OUTPUT_TRUNCATED')) throw chunkErr;
            console.log(`[chatWithMorpheus] coder chunk ${chunkIdx + 1}/${chunks.length} truncated — retrying one file at a time`);
            for (const onePath of chunk) {
              try {
                const one = await invokeAI({
                  userId: user.id,
                  prompt: `${chunkPrompt}\n\nFOR THIS STEP, implement ONLY this file: ${onePath}. Return fileOperations for ONLY this file.`,
                  schema: coderSchema,
                  fileUrls,
                  role: 'coder',
                  maxTokens: CODER_STEP_MAX_TOKENS,
                });
                coderModelLast = one.model;
                fileOps.push(...(Array.isArray(one.result.fileOperations) ? one.result.fileOperations : []));
              } catch (oneErr) {
                if (!String(oneErr?.message || '').includes('OUTPUT_TRUNCATED')) throw oneErr;
                truncatedFiles.push(onePath);
                console.log(`[chatWithMorpheus] coder chunk ${chunkIdx + 1}: ${onePath} truncated on retry too — not written`);
              }
            }
          }
          console.log(`[chatWithMorpheus] coder chunk ${chunkIdx + 1}/${chunks.length} done (${Math.round((Date.now() - chunkStartedAt) / 1000)}s, ${chunkOps.length} file op(s))`);
        }
      } else {
        // Fallback: the Planner didn't enumerate plannedFiles (shouldn't
        // normally happen now that PLANNER_INSTRUCTIONS asks for it, but a
        // model can still omit an optional field) — single-shot call, same
        // as the pre-chunking behavior, still with an explicit generous cap
        // rather than omitting max_tokens (see ai.js's maxTokens doc).
        //
        // In scoped mode contextBlock doesn't carry every file — pull any
        // existing path the plan text mentions that wasn't shown, and give
        // the coder its current content so this path can't rewrite blind
        // either.
        let fallbackCurrentBlock = '';
        if (useScopedContext) {
          const mentioned = files.filter((f) => !shownPathSet.has(f.path) && plannerResult.plan.includes(f.path));
          if (mentioned.length > 0) {
            fallbackCurrentBlock = `\n\nCURRENT CONTENT OF EXISTING FILES THE PLAN TOUCHES:\n${mentioned.map((f) => `--- ${f.path} (current content) ---\n${f.content}`).join('\n\n')}`;
          }
        }
        try {
          const coder = await invokeAI({
            userId: user.id,
            prompt: coderPrompt + fallbackCurrentBlock,
            schema: coderSchema,
            fileUrls,
            role: 'coder',
            maxTokens: 64000,
          });
          coderModelLast = coder.model;
          fileOps = Array.isArray(coder.result.fileOperations) ? coder.result.fileOperations : [];
        } catch (singleErr) {
          // Same reasoning as the chunked path. This branch runs when the plan named no files, so
          // there is nothing to split the retry by — the turn survives, nothing is written, and the
          // reply says exactly that.
          if (!String(singleErr?.message || '').includes('OUTPUT_TRUNCATED')) throw singleErr;
          fileOps = [];
          truncatedFiles.push('this whole step');
        }
      }

      stages.done('coder');
      coderModel = coderModelLast;

      // Guarantee a polished styles.css exists for web-app builds. If the
      // coder shipped its own, trust it; otherwise inject the design system
      // verbatim so the app never lands with raw unstyled HTML.
      if (isWebApp && !fileOps.some((op) => op.path === 'styles.css')) {
        fileOps.unshift({ path: 'styles.css', content: DESIGN_SYSTEM_CSS, action: 'create' });
      }

      // ── Resolve diff edits to full content BEFORE review ──────────────────
      // A coder `update` may carry `edits` (find/replace) instead of full
      // content. Apply them here, against each file's current content, so
      // the reviewer sees the real end state (not a diff it can't
      // syntax-check) and applyFileOperations only ever writes plain
      // content. An edit that doesn't match is NOT applied — the file is
      // retried once with full content instead.
      const editFailures = [];
      if (fileOps.some((op) => Array.isArray(op.edits) && op.edits.length > 0)) {
        const curContent = new Map(files.map((f) => [f.path, f.content ?? '']));
        const resolved = [];
        for (const op of fileOps) {
          if (op.action === 'update' && Array.isArray(op.edits) && op.edits.length > 0) {
            if (!curContent.has(op.path)) { editFailures.push({ path: op.path, reason: 'file does not exist yet' }); continue; }
            const { ok, content, failed } = applyEdits(curContent.get(op.path), op.edits);
            if (!ok) { editFailures.push({ path: op.path, reason: failed.map((f) => f.reason).join('; ') }); continue; }
            curContent.set(op.path, content); // so a 2nd edit op for the same file stacks
            resolved.push({ path: op.path, action: 'update', content });
          } else {
            resolved.push(op);
          }
        }
        fileOps = resolved;
      }
      // One targeted retry for files whose edits didn't match — ask for full
      // content this time, with the file's real current content in hand.
      if (editFailures.length > 0) {
        stages.start('retry_coder');
        const failPaths = [...new Set(editFailures.map((f) => f.path))];
        editFailPaths = failPaths;
        const curBlock = failPaths
          .map((p) => files.find((f) => f.path === p))
          .filter(Boolean)
          .map((f) => `--- ${f.path} (current content) ---\n${f.content}`)
          .join('\n\n');
        try {
          const retry = await invokeAI({
            userId: user.id,
            prompt: `${coderPrompt}\n\nYour \`edits\` for these file(s) did not match the current content and were NOT applied: ${editFailures.map((f) => `${f.path} (${f.reason})`).join('; ')}.\n\nCURRENT CONTENT:\n${curBlock}\n\nFOR THIS STEP, implement ONLY these file(s): ${failPaths.join(', ')}. Return each as action "update" with the FULL corrected \`content\` — no edits this time.`,
            schema: coderSchema,
            fileUrls,
            role: 'coder',
            maxTokens: 64000,
          });
          const retryOps = (Array.isArray(retry.result.fileOperations) ? retry.result.fileOperations : [])
            .filter((op) => op.path && failPaths.includes(op.path) && typeof op.content === 'string');
          fileOps.push(...retryOps);
          editFailPaths = failPaths.filter((p) => !retryOps.some((op) => op.path === p));
        } catch (err) {
          console.error('[chatWithMorpheus] edit-failure retry failed:', err.message);
        }
        stages.done('retry_coder');
      }

      // ── Phase 3: Reviewer checks the output before commit ──────────────────
      // reviewAndRetry emits its own 'reviewer' / 'retry_coder' /
      // 'retry_reviewer' stage events via stages.onProgress — see reviewer.js.
      if (fileOps.length > 0) {
        // Caller-impact manifest (A3): for a change to an EXISTING shared
        // file, tell the reviewer every file that imports it and what it
        // pulls — so it can check the change doesn't break a caller it
        // can't see (the github.js incident class). ES-module analysis, so
        // it's a no-op for Python / Arduino / Go / etc. projects.
        // The reviewer does NOT get the Coder's context block. Measured 30-day
        // production usage puts the reviewer at 1,254 calls averaging 26,138
        // input tokens — 30.6% of all AI spend — almost all of it the shared
        // block (whole-repo tree plus every orientation file; schema.prisma
        // alone is ~15.1k tokens) rather than the <=3 files actually under
        // review. buildReviewerContext emits the rules the reviewer's prompt
        // names, a bounded tree, and the schema only when the change touches
        // it. See lib/reviewContext.js for the reasoning and the numbers.
        let reviewContext = buildReviewerContext({ files, fileOps });
        {
          const rev = buildReverseImports(files);
          const impacted = fileOps
            .filter((op) => op.action !== 'create' && files.some((f) => f.path === op.path))
            .map((op) => ({ path: op.path, callers: rev.get(op.path) || [] }))
            .filter((x) => x.callers.length > 0);
          if (impacted.length > 0) {
            const lines = impacted.map((x) => {
              const cs = x.callers.slice(0, 25).map((c) => {
                const what = c.namespace ? '* (namespace)' : c.names.length ? c.names.join(', ') : '(side-effect)';
                return `    - ${c.importer}  imports: ${what}`;
              });
              return `  ${x.path} — imported by ${x.callers.length} file(s):\n${cs.join('\n')}`;
            });
            reviewContext += `\n\nCALLER IMPACT — this change modifies file(s) that other files import:\n${lines.join('\n')}\n\nThe change MUST keep every listed import valid: do not remove or rename an exported binding a caller uses, and do not change a function's signature or return shape in a way a caller relies on. Any such break is a CRITICAL issue — name the caller.`;
          }
        }
        const reviewed = await reviewAndRetry(user.id, fileOps, reviewContext, plannerResult.plan, coderPrompt, stages.onProgress);
        reviewerFixAttempts = reviewed.attempts || 0;
        console.log(`[chatWithMorpheus] rework: syntax=${syntaxFixAttempts} bundle=${bundleFixAttempts} convention=${conventionFixAttempts} reviewer=${reviewerFixAttempts}${reviewed.criticalFound ? ' (reviewer found critical issues)' : ''} rss=${memMb()}MB ${containerMb()}`);
        fileOps = reviewed.fileOps;
        reviewerModel = reviewed.reviewerModel;
        reviewSummary = reviewed.reviewSummary;
        reviewIssues = reviewed.issues || [];
      }

      // ── Syntax gate: the change must at least parse ───────────────────────
      // Deterministic per-file esbuild check over the final fileOps — the
      // same pass-1 the self-dev verify gate runs (lib/syntaxCheck.js), now
      // on every build. A parse error means a half-applied edit or a
      // malformed generation.
      //
      // 2026-09-12 (Rob: self-dev's output isn't as reliable as Claude
      // Code's — this is step one of closing that): a single retry
      // routinely wasn't enough to fully clear a multi-file break, so a
      // still-broken file just got flagged and shipped anyway. This now
      // iterates — re-checking and re-fixing with the actual REMAINING
      // errors each pass — up to MAX_GATE_ATTEMPTS real attempts before
      // giving up, the same "verify against reality, retry on the real
      // failure" loop an agent doing this by hand would run. Bounded to
      // keep cost/latency sane. Also catches Python files now (real
      // ast.parse, see syntaxCheck.js) — still a no-op for Arduino/Go/etc.,
      // which have no embeddable real parser available here.
      if (fileOps.length > 0) {
        const changedCode = () => fileOps
          .filter((op) => op.action !== 'delete' && typeof op.content === 'string')
          .map((op) => ({ path: op.path, content: op.content }));
        let syntaxErrors = await checkSyntax(changedCode());
        for (let attempt = 1; syntaxErrors.length > 0 && attempt < MAX_GATE_ATTEMPTS; attempt++) {
          syntaxFixAttempts++;
          stages.start('verify');
          const badPaths = [...new Set(syntaxErrors.map((e) => e.file))];
          const curBlock = badPaths
            .map((p) => fileOps.find((op) => op.path === p && typeof op.content === 'string'))
            .filter(Boolean)
            .map((op) => `--- ${op.path} ---\n${op.content}`)
            .join('\n\n');
          try {
            const fix = await invokeAI({
              userId: user.id,
              prompt: `${coderPrompt}\n\nThe code you just wrote does not parse (fix attempt ${attempt} of ${MAX_GATE_ATTEMPTS - 1}):\n${syntaxErrors.map((e) => `  ${e.file}${e.line ? ':' + e.line : ''} — ${e.text}`).join('\n')}\n\nCURRENT (broken) CONTENT:\n${curBlock}\n\nReturn each of these file(s) as action "update" with the FULL corrected \`content\` — fix the syntax error, change nothing else.`,
              schema: coderSchema,
              fileUrls,
              role: 'coder',
              maxTokens: 64000,
            });
            const fixOps = (Array.isArray(fix.result.fileOperations) ? fix.result.fileOperations : [])
              .filter((op) => op.path && badPaths.includes(op.path) && typeof op.content === 'string');
            for (const fx of fixOps) {
              const orig = fileOps.find((op) => op.path === fx.path);
              if (orig) orig.content = fx.content;
            }
          } catch (err) {
            console.error('[chatWithMorpheus] syntax-fix retry failed:', err.message);
            stages.done('verify');
            break; // the fix call itself is failing — looping again won't help
          }
          stages.done('verify');
          syntaxErrors = await checkSyntax(changedCode());
        }
        syntaxCritical = syntaxErrors.map((e) => `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}`);
      }

      // ── Caller gate: does this change break a file that imports it? ────────
      // Deterministic, and it runs on EVERY build turn — not just self-dev.
      //
      // The syntax gate above checks each changed file in isolation, so it cannot
      // see a change that parses perfectly and still kills an importer. The
      // reviewer was asked that question by judgement; H1 is the incident where
      // that was not enough (a reshaped github.js broke every compile/deploy
      // path), and the same shape recurred in production on 2026-09-25 when
      // runAiAction.js imported a name reviewer.js never exported.
      //
      // `findBrokenImports` answers it exactly — pure string analysis, no
      // bundling, no model — and this repo already trusted it, but only inside
      // the `isSelfDev` deep-verify gate below, whose OTHER half (bundling from
      // self-dev-specific entry points) is what justified that restriction. The
      // caller half needs none of that, and `files` here is already the full
      // project, so there is no reason to withhold it from a user's build.
      //
      // Only breakage this change INTRODUCED is reported: a pre-existing broken
      // import is not this turn's fault, and failing a build for it would be
      // unfixable by the coder. Reported rather than auto-fixed for the same
      // reason the deep gate does that — when the importer is a file the turn
      // never touched, there is nothing to hand the coder as "current content".
      if (fileOps.length > 0) {
        try {
          const callerBreaks = findCallerBreaks(files, fileOps);
          if (callerBreaks.length > 0) {
            const lines = describeCallerBreaks(callerBreaks);
            console.log(`[chatWithMorpheus] caller-gate: ${callerBreaks.length} import(s) broken by this change: ${lines.join(' | ')}`);
            callerCritical = [...callerCritical, ...lines];
          }
        } catch (err) {
          // A check that cannot run must not be the reason a build dies — but it
          // must not pass silently either, or a broken checker looks like a clean
          // build forever.
          console.error('[chatWithMorpheus] caller-gate FAILED TO RUN:', err.message);
        }
      }

      // ── Schema gate: does this change use a column that does not exist? ────
      // Same reasoning as the caller gate above, for a different class: the
      // mutation test showed a model approving a read of `row.tokens` on a model
      // whose fields are input_tokens/output_tokens. esbuild cannot see this,
      // lint cannot, and the import guards check imports — it is a runtime
      // failure that reaches a user, and the reviewer was the only thing asked
      // about it.
      //
      // Only the EXPLICIT case (a Prisma call naming its model and fields). An
      // untyped row gives a script nothing to resolve against, which is why the
      // review context carries a field index for that. Anything unparseable is
      // skipped: a missed check costs nothing, a false "that column does not
      // exist" blocks good code.
      if (fileOps.length > 0) {
        const schemaFile = files.find((f) => f.path === 'server/prisma/schema.prisma');
        if (schemaFile && typeof schemaFile.content === 'string') {
          try {
            const badFields = [];
            // A Prisma call only means something in a file that could be executed. In a
            // `.md`/`.sql`/`.json` file it is an example, and reporting it as an unknown column
            // is a false accusation with the user's name on it.
            for (const op of fileOps) {
              if (typeof op.content !== 'string' || op.action === 'delete') continue;
              if (!isCodePath(op.path)) continue;
              for (const f of unknownPrismaFields(schemaFile.content, op.content)) {
                badFields.push(`${op.path}: ${f.model} has no field \`${f.field}\` (used in \`${f.arg}\`)`);
              }
            }
            if (badFields.length > 0) {
              console.log(`[chatWithMorpheus] schema-gate: ${badFields.length} unknown column(s): ${badFields.slice(0, 5).join(' | ')}`);
              schemaCritical = [...schemaCritical, ...badFields];
            }
          } catch (err) {
            console.error('[chatWithMorpheus] schema-gate FAILED TO RUN:', err.message);
          }
        }
      }

      // ── Deep verify gate (self-dev only): bundle from real entry points +
      // cross-file export check ───────────────────────────────────────────
      // The syntax gate above checks each changed file in isolation — it
      // cannot catch a change that parses fine on its own but breaks an
      // IMPORTER elsewhere in the repo. That's exactly KNOWN-HAZARDS.md's
      // H1: a self-dev change reshaped github.js and every other importer
      // broke at import time with "does not provide an export named X" —
      // undetected until the next compile/deploy hit it, not when it was
      // introduced. verifySelfDev.js already runs this exact check
      // (lib/engine/verify.js — a real esbuild bundle from self-dev's real
      // entry points, plus a cross-file named-export check), but only at
      // PUSH time. Pulled forward to run on every build turn instead, with
      // the same iterative fix-and-recheck loop as the syntax gate above,
      // so a cross-file break is caught and self-corrected the moment it's
      // introduced. Self-dev only: needs the FULL current repo (not the
      // scoped context a build turn sends the coder) to resolve real
      // imports, and its entry points/exclude rules are self-dev-specific.
      if (isSelfDev && fileOps.length > 0) {
        const fullFiles = await prisma.projectFile.findMany({
          where: { project_id: projectId },
          select: { path: true, content: true },
        });
        const applyVirtual = () => {
          const byPath = new Map(fullFiles.map((f) => [f.path, f.content]));
          for (const op of fileOps) {
            if (op.action === 'delete') byPath.delete(op.path);
            else if (typeof op.content === 'string') byPath.set(op.path, op.content);
          }
          return Array.from(byPath, ([path, content]) => ({ path, content }));
        };
        const adapter = getDeliveryAdapter('self-dev');
        // The heaviest single step in a self-dev turn: every file of the
        // workspace in memory at once, handed to esbuild. Its own memory line,
        // because a stage-level reading would only bracket it, not show it.
        console.log(`[chatWithMorpheus] deep-verify: ${fullFiles.length} file(s) in memory, rss=${memMb()}MB ${containerMb()} before bundling`);
        let deep = await adapter.verify({ files: applyVirtual() });
        console.log(`[chatWithMorpheus] deep-verify: done, ok=${deep.ok} errors=${deep.errorCount}, rss=${memMb()}MB ${containerMb()} after bundling`);
        for (let attempt = 1; !deep.ok && attempt < MAX_GATE_ATTEMPTS; attempt++) {
          bundleFixAttempts++;
          const isConvention = (e) => String(e?.phase || '').startsWith('convention:');
          if (deep.errors.some(isConvention)) conventionFixAttempts++;
          // A house-rule failure is not a broken bundle, and telling the coder to
          // "fix the missing export" when it took the wrong ink rung sends it to
          // the wrong place. The error text already names the token each element
          // needs, so the instruction only has to say: apply exactly that.
          const conventionOnly = deep.errors.length > 0 && deep.errors.every(isConvention);
          const foundBy = conventionOnly
            ? 'a house-rule check this repo enforces found'
            : 'a real bundle + cross-file export check found';
          const fixGuidance = conventionOnly
            ? 'Fix ONLY the rule violations above — each one names the token that element must use, so apply exactly that and change nothing else. The rule is stated under "UI conventions" in AGENTS.md; scripts/verify-prose-ink.mjs enforces it on every build, so leaving it is a red CI gate.'
            : 'fix ONLY what breaks the check above (a missing/renamed export a caller still needs, a bad import path). Never remove or rename an export without checking every caller first. Change nothing else.';
          const badPaths = [...new Set(deep.errors.map((e) => e.file).filter(Boolean))];
          const curBlock = badPaths
            .map((p) => fileOps.find((op) => op.path === p && typeof op.content === 'string'))
            .filter(Boolean)
            .map((op) => `--- ${op.path} ---\n${op.content}`)
            .join('\n\n');
          // An error can point at an IMPORTER this turn never touched (the
          // caller of a changed export) — there's nothing to hand the
          // coder a "current content" for if fileOps never opened that
          // file. Surface it as critical straight away rather than asking
          // it to blindly rewrite a file it was never shown.
          if (!curBlock) break;
          stages.start('verify');
          try {
            const fix = await invokeAI({
              userId: user.id,
              prompt: `${coderPrompt}\n\n${conventionOnly ? 'This change breaks a house rule' : 'This change breaks the wider repo'} — ${foundBy} (fix attempt ${attempt} of ${MAX_GATE_ATTEMPTS - 1}):\n${deep.errors.slice(0, 20).map((e) => `  ${e.file}${e.line ? ':' + e.line : ''} [${e.phase}] — ${e.text}`).join('\n')}\n\nCURRENT (broken) CONTENT of the file(s) you touched:\n${curBlock}\n\nReturn each of these file(s) as action "update" with the FULL corrected \`content\` — ${fixGuidance}`,
              schema: coderSchema,
              fileUrls,
              role: 'coder',
              maxTokens: 64000,
            });
            const fixOps = (Array.isArray(fix.result.fileOperations) ? fix.result.fileOperations : [])
              .filter((op) => op.path && badPaths.includes(op.path) && typeof op.content === 'string');
            for (const fx of fixOps) {
              const orig = fileOps.find((op) => op.path === fx.path);
              if (orig) orig.content = fx.content;
            }
          } catch (err) {
            console.error('[chatWithMorpheus] deep-verify-fix retry failed:', err.message);
            stages.done('verify');
            break;
          }
          stages.done('verify');
          deep = await adapter.verify({ files: applyVirtual() });
        }
        if (!deep.ok) deepVerifyCritical = deep.errors.slice(0, 10).map((e) => `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}`);
      }

      // ── Accessibility gate (web-app builds) ──────────────────────────────
      // Deterministic checks over the changed HTML/JSX (lib/a11yCheck.js):
      // missing alt, icon-only buttons/links with no name, unlabelled
      // fields, positive tabindex, div-onClick. A finding → one targeted
      // coder retry; anything left is surfaced as a // A11Y note (the site
      // still works, so it doesn't block the build).
      if (fileOps.length > 0 && isWebApp) {
        const changedMarkup = () => fileOps
          .filter((op) => op.action !== 'delete' && typeof op.content === 'string')
          .map((op) => ({ path: op.path, content: op.content }));
        let a11yFindings = checkA11y(changedMarkup());
        if (a11yFindings.length > 0) {
          stages.start('a11y');
          const badPaths = [...new Set(a11yFindings.map((e) => e.file))];
          const curBlock = badPaths
            .map((p) => fileOps.find((op) => op.path === p && typeof op.content === 'string'))
            .filter(Boolean)
            .map((op) => `--- ${op.path} ---\n${op.content}`)
            .join('\n\n');
          try {
            const fix = await invokeAI({
              userId: user.id,
              prompt: `${coderPrompt}\n\nThe markup you just wrote has accessibility problems:\n${a11yFindings.map((e) => `  ${e.file}${e.line ? ':' + e.line : ''} [${e.rule}] — ${e.text}`).join('\n')}\n\nCURRENT CONTENT:\n${curBlock}\n\nReturn each file as action "update" with the FULL corrected \`content\` — fix ONLY these accessibility issues (add alt text that describes the image, give icon-only controls an aria-label, associate labels with fields, drop positive tabindex, make clickable divs real buttons). Change nothing else.`,
              schema: coderSchema,
              fileUrls,
              role: 'coder',
              maxTokens: 64000,
            });
            const fixOps = (Array.isArray(fix.result.fileOperations) ? fix.result.fileOperations : [])
              .filter((op) => op.path && badPaths.includes(op.path) && typeof op.content === 'string');
            for (const fx of fixOps) {
              const orig = fileOps.find((op) => op.path === fx.path);
              if (orig) orig.content = fx.content;
            }
            // re-run BOTH gates: an a11y "fix" must still parse
            const reSyntax = await checkSyntax(fixOps.map((op) => ({ path: op.path, content: op.content })));
            if (reSyntax.length === 0) a11yFindings = checkA11y(changedMarkup());
          } catch (err) {
            console.error('[chatWithMorpheus] a11y-fix retry failed:', err.message);
          }
          stages.done('a11y');
        }
        a11yNotes = a11yFindings.map((e) => `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}`);
      }

      if (fileOps.length > 0) {
        await createSnapshot(user.id, projectId, 'Operator build request');
      }
      appliedOps = await applyFileOperations(user.id, projectId, fileOps, files, engineScopePolicy);

      // ── Phase 4: Optional UI polish pass (only when operator enabled it) ──
      // A second, lightweight coder call that touches ONLY styling files. It
      // runs when project.polish_ui is on and the build produced web-facing
      // files (or the target is web-app). Never runs for pure native/CLI builds.
      if (project.polish_ui && appliedOps.length > 0 && !isSelfDev) {
        const hasWebFiles = appliedOps.some((op) => /\.(html|css|jsx|tsx|vue|svelte)$/i.test(op.path) || op.path === 'styles.css');
        if ((hasWebFiles || isWebApp) && !isWordPress) {
          // Same fix as the `files` query above -- ProjectFile uniqueness is
          // project-wide, not per-user (see schema.prisma), and this feeds
          // applyFileOperations() below.
          const freshFiles = await prisma.projectFile.findMany({ where: { project_id: projectId } });
          const filesForPolish = freshFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
          stages.start('polish');
          const polish = await invokeAI({
            userId: user.id,
            prompt: `${systemPrompt}${POLISH_PROMPT}\n${contextBlock}\n\nCURRENT FILES (after main build):\n${filesForPolish}\n\nProduce the polished fileOperations now.`,
            schema: {
              type: 'object',
              properties: {
                fileOperations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      content: { type: 'string' },
                      action: { type: 'string', enum: ['create', 'update', 'delete'] }
                    }
                  }
                }
              }
            },
            fileUrls: undefined,
            role: 'coder',
            // Same fix as the main Coder call above — see the comment there.
            maxTokens: 64000,
          });
          stages.done('polish');
          const polishOps = Array.isArray(polish.result.fileOperations) ? polish.result.fileOperations : [];
          if (polishOps.length > 0) {
            await createSnapshot(user.id, projectId, 'UI polish pass (pre-polish)');
            const appliedPolish = await applyFileOperations(user.id, projectId, polishOps, freshFiles);
            appliedOps = [...appliedOps, ...appliedPolish];
            polishCount = appliedPolish.length;
          }
        }
      }

      // GitHub auto-sync (main + polish passes both land here, so this
      // covers the whole turn in one push) — fire-and-forget, see
      // syncProjectFilesToGithub's own comment for why this is never
      // awaited: a slow/failed GitHub call must never delay or break the
      // chat response.
      if (appliedOps.length > 0 && project.github_repo) {
        syncProjectFilesToGithub(user.id, project, appliedOps).catch((err) => {
          console.error('[chatWithMorpheus] github auto-sync failed:', err.message);
        });
      }
    }

    const reviewBlock = (reviewSummary || reviewIssues.some((i) => i.severity === 'critical')) && appliedOps.length > 0
      ? formatReviewChatBlock({ summary: reviewSummary, approved: !reviewIssues.some((i) => i.severity === 'critical'), issues: reviewIssues })
      : '';
    let fullReply = reviewBlock ? `${reply}\n\n${reviewBlock}` : reply;
    fullReply += sourcesLine;
    if (polishCount > 0) {
      fullReply += `\n\n// POLISH: refined styling on ${polishCount} file(s).`;
    }
    // Surface any file whose diff edit never landed (matched nothing, and
    // the full-content retry didn't produce it either) so the operator
    // knows it's unchanged rather than assuming it was edited.
    const unresolved = [...new Set([
      ...editFailPaths,
      ...appliedOps.filter((op) => op.action === 'edit_failed').map((op) => op.path),
    ])];
    if (unresolved.length > 0) {
      fullReply += `\n\n// CRITICAL: could not apply changes to ${unresolved.join(', ')} — ${unresolved.length === 1 ? 'that file was' : 'those files were'} left unchanged. Ask again, pinning ${unresolved.length === 1 ? 'that file' : 'those files'}.`;
    }
    // Each gate reports in its own sentence, because they are not the same thing and only one
    // of them retries. `syntaxCritical` really did go through MAX_GATE_ATTEMPTS - 1 re-checks;
    // the caller and schema gates run ONCE and report. Folding them together told the user a
    // broken caller was "a syntax error after 2 fix attempts" — wrong about the error and about
    // the attempts — which sends them looking for something that is not there.
    const criticalNotes = [];
    if (syntaxCritical.length > 0) {
      criticalNotes.push(`the code still has a syntax error after ${MAX_GATE_ATTEMPTS - 1} fix attempts — ${syntaxCritical.join('; ')}`);
    }
    if (callerCritical.length > 0) {
      criticalNotes.push(`a check found an import this change breaks, with no fix attempted — ${callerCritical.join('; ')}`);
    }
    if (schemaCritical.length > 0) {
      criticalNotes.push(`a check found a column that does not exist, with no fix attempted — ${schemaCritical.join('; ')}`);
    }
    if (criticalNotes.length > 0) {
      const nCritical = syntaxCritical.length + callerCritical.length + schemaCritical.length;
      fullReply += `\n\n// CRITICAL: ${criticalNotes.join('. ')}. The change was applied anyway; ask me to fix ${nCritical === 1 ? 'it' : 'them'} or revert.`;
    }
    if (truncatedFiles.length > 0) {
      const n = truncatedFiles.length;
      fullReply += `\n\n// INCOMPLETE: the coder's output was cut off by the token limit and could not be retried smaller, so ${n === 1 ? 'this was not written' : 'these were not written'}: ${truncatedFiles.join(', ')}. Everything else in this turn is intact — ask me to continue and I'll do ${n === 1 ? 'it' : 'them'} one at a time.`;
    }
    if (deepVerifyCritical.length > 0) {
      fullReply += `\n\n// CRITICAL: this still breaks the wider repo after a fix attempt (a real bundle + cross-file export check) — ${deepVerifyCritical.join('; ')}. The change was applied to this workspace anyway; PUSH TO PRODUCTION will re-check and block it, but fix or revert it here first.`;
    }
    if (a11yNotes.length > 0) {
      fullReply += `\n\n// A11Y: ${a11yNotes.length} accessibility issue${a11yNotes.length === 1 ? '' : 's'} left after a fix pass — ${a11yNotes.join('; ')}. The site still works; ask me to fix ${a11yNotes.length === 1 ? 'it' : 'them'}.`;
    }

    // ── Feature progress ──────────────────────────────────────────────────
    // Escalation turn: announce the plan and advance past step 1 (just built).
    // Ongoing feature turn (non-self-dev): advance the active step when the
    // build changed files — the planner's context said to build that step, so
    // it's done; the operator can reopen it from the FEATURE panel to refine.
    // Self-dev advances its steps manually (on push, from the panel).
    const buildProgressed = appliedOps.length > 0 && unresolved.length === 0 && syntaxCritical.length === 0 && deepVerifyCritical.length === 0 && truncatedFiles.length === 0;
    if (escalatedFeature && escalatedFeature.activeStep) {
      fullReply += `\n\n// FEATURE: "${escalatedFeature.title}" — this needs ${escalatedFeature.totalSteps} steps. Built step 1 (${escalatedFeature.activeStep.title}); the rest are tracked in the FEATURE panel. Ask me to continue for the next step.`;
      // Step 1 having been drafted this turn doesn't mean it actually
      // landed — self-dev ships via reviewed/mergeable PRs (two of which,
      // #115/#116, were reverted this same session), so a step being built
      // is not the same as it being done. Self-dev advances steps manually
      // from the panel only, same as the ongoing-feature branch below
      // (!isSelfDev) — this branch was missing that same guard, silently
      // contradicting the "Self-dev advances its steps manually" comment a
      // few lines up.
      if (buildProgressed && !isSelfDev) {
        try {
          const { runUpdateSelfDevFeature } = await import('./updateSelfDevFeature.js');
          await runUpdateSelfDevFeature(user, escalatedFeature.id, 'completeStep', { stepN: escalatedFeature.activeStep.n, silent: true });
        } catch (e) { console.error('[chatWithMorpheus] feature step advance failed:', e.message); }
      }
    } else if (activeFeature && activeFeature.status === 'active' && activeFeature.activeStep && buildProgressed && !isSelfDev) {
      if (plannerResult.stepComplete === true) {
        try {
          const { runUpdateSelfDevFeature } = await import('./updateSelfDevFeature.js');
          const { feature } = await runUpdateSelfDevFeature(user, activeFeature.id, 'completeStep', { stepN: activeFeature.activeStep.n, silent: true });
          fullReply += feature.status === 'done'
            ? `\n\n// FEATURE: "${feature.title}" complete — all ${feature.totalSteps} steps built.`
            : `\n\n// FEATURE: step ${activeFeature.activeStep.n}/${feature.totalSteps} done. Next: ${feature.activeStep?.title}. (Reopen it from the FEATURE panel to keep refining.)`;
        } catch (e) { console.error('[chatWithMorpheus] feature step advance failed:', e.message); }
      } else {
        fullReply += `\n\n// FEATURE: still on step ${activeFeature.activeStep.n}/${activeFeature.totalSteps} — ${activeFeature.activeStep.title}. Say "next" when it's ready.`;
      }
    }

    await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content: fullReply } });

    if (appliedOps.length > 0) {
      await prisma.project.update({ where: { id: projectId }, data: { status: 'building' } });
    }

    // Log usage with the full toolchain manifest — SDK version, provider, and
    // the exact AI models used for each phase — so the build log records what
    // produced the output.
    const toolchain = buildToolchain(planner.provider, {
      planner: planner.model,
      coder: coderModel,
      reviewer: reviewerModel,
    });
    await logUsage(user.id, appliedOps.length > 0 ? 'chat_build' : 'chat_simple', projectId, project.name, {
      messageLength: message.length,
      needsCode,
      fileCount: appliedOps.length,
      reviewed: !!reviewerModel,
      ...toolchain,
    });

    // Decisions log: record what this change did + why, so later planning
    // turns build on it. Any project, only when files actually changed.
    if (appliedOps.length > 0) {
      await recordDecision(
        user.id, projectId,
        plannerResult.decisionSummary || plannerResult.plan?.split('\n')[0] || reply,
        plannerResult.decisionRationale || '',
      );
    }

    // A streaming handler returns nothing the dispatcher can read, so the run
    // record's chat stage has always been blank — for the stage that matters
    // most. res.locals is the one channel that outlives the stream without
    // inventing a second write path; the dispatcher reads it in its finally,
    // after res.end(), and only when there was no return value to use.
    try { res.locals.morpheusStageDetail = { rework: { syntax: syntaxFixAttempts, bundle: bundleFixAttempts, convention: conventionFixAttempts, reviewer: reviewerFixAttempts } }; } catch { /* no locals */ }
    emit({ type: 'result', data: { reply: fullReply || reply, fileOperations: appliedOps, rework: { syntax: syntaxFixAttempts, bundle: bundleFixAttempts, convention: conventionFixAttempts, reviewer: reviewerFixAttempts }, featureChanged: !!(escalatedFeature || (activeFeature && appliedOps.length > 0 && !isSelfDev)) } });
  } catch (err) {
    console.error('[chatWithMorpheus]', err);
    // If the build already LANDED, an error event is the worst response available: the files are
    // written, but the client sees a closed stream with no result, classifies it as a bare network
    // failure and re-runs the whole turn — a second full build on top of the first, for spend. A
    // throw AFTER apply (the polish pass, the chat row, the project status, usage) must not cost the
    // user their reply. So deliver what we have, and name what failed.
    if (appliedOps.length > 0) {
      // Shaped exactly like the success emit below, so the stream reader cannot tell them apart.
      try {
        emit({
          type: 'result',
          data: {
            reply: `${fullReply || reply}\n\n// NOTE: the build itself landed and everything above is applied, but something after it failed — ${err.message || 'unknown error'}. Ask me to retry the part that did not finish.`,
            fileOperations: appliedOps,
            rework: { syntax: syntaxFixAttempts, bundle: bundleFixAttempts, convention: conventionFixAttempts, reviewer: reviewerFixAttempts },
            featureChanged: false,
          },
        });
      } catch (emitErr) {
        console.error('[chatWithMorpheus] could not deliver the landed build:', emitErr.message);
      }
    } else {
      // Mirrors functions.routes.js's normal error shape (message/code/needed/
      // available) so the frontend's stream reader can react the same way it
      // would to a non-streamed error response — see base44Client.js's
      // invokeStream, in particular the INSUFFICIENT_CREDITS handling.
      emit({ type: 'error', message: err.message || 'Internal error', code: err.code, needed: err.needed, available: err.available });
    }
  } finally {
    res.end();
  }
}
