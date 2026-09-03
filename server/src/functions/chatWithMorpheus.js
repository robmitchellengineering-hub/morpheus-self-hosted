// Ported from base44/functions/chatWithMorpheus/entry.ts.
//
// The core AI chat pipeline: Planner (reasons about intent + design) →
// clarification gate (asks the operator when genuinely ambiguous) → Coder
// (implements the plan) → Reviewer (checks the output before commit) →
// optional UI polish pass. See PORTING_GUIDE.md for the call-mapping table.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { createSnapshot, applyFileOperations, logUsage } from '../lib/projectUtils.js';
import { buildToolchain } from '../lib/toolchain.js';
import { reviewAndRetry, formatReviewChatBlock } from '../lib/reviewer.js';
import { designSystemPromptBlock, POLISH_PROMPT, DESIGN_SYSTEM_CSS } from '../lib/designSystem.js';
import { getContextSummary, formatContextSummaryBlock } from '../lib/contextSummary.js';
import { estimateCallMs } from '../lib/timingStats.js';

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
  planner: 'Planning the build',
  coder: 'Writing the code',
  reviewer: 'Reviewing the changes',
  retry_coder: 'Fixing flagged issues',
  retry_reviewer: 'Re-checking the fix',
  polish: 'Polishing the UI',
};
const STAGE_ROLE = {
  planner: 'planner',
  coder: 'coder',
  reviewer: 'reviewer',
  retry_coder: 'coder',
  retry_reviewer: 'reviewer',
  polish: 'coder',
};

// One of these per request. `emit` writes one NDJSON line; `start`/`done`
// wrap a stage the handler itself calls invokeAI for directly (planner,
// coder, polish); `onProgress` adapts reviewer.js's own {stage, status}
// callback shape (see reviewAndRetry) into the same emitted events, so the
// reviewer/retry-coder/re-review steps show up as real steps too instead of
// vanishing into one opaque "reviewing" phase.
function makeStageEmitter(emit) {
  let index = 0;
  const startedAt = new Map();
  const start = (stage) => {
    startedAt.set(stage, Date.now());
    emit({ type: 'stage', stage, status: 'start', label: STAGE_LABELS[stage], etaSeconds: Math.round(estimateCallMs(STAGE_ROLE[stage]) / 1000), index: index++ });
  };
  const done = (stage) => {
    const t = startedAt.get(stage);
    emit({ type: 'stage', stage, status: 'done', label: STAGE_LABELS[stage], elapsedSeconds: t ? Math.round((Date.now() - t) / 1000) : undefined });
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
- Alternatively React Native: include package.json with react-native, document 'npm run android'

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
- Generate a pi-gen-based build project (pi-gen is the official Raspberry Pi OS image builder): include config file (pi-gen/config), stage definitions (stage0, stage1, stage2), and a custom stage (stage3) with packages and scripts
- Include a Dockerfile or document running pi-gen in Docker (recommended): 'docker build -t pi-gen . && docker run --privileged -v $(pwd)/deploy:/pi-gen/deploy pi-gen'
- Include package-list files (00-packages, 01-packages) listing the custom packages to install (apt packages, Python pip packages, etc.)
- Include customization scripts in the custom stage (00-run.sh, 01-run.sh, etc.) for post-install configuration (users, services, network, autostart scripts, etc.)
- Include a build.sh wrapper script that invokes pi-gen with the correct stage list and config
- Document the full build process: clone pi-gen, copy custom stage, run build (requires Docker on a Linux host or WSL2), flash the resulting .img to an SD card using 'dd' or balenaEtcher or rpi-imager
- Document target hardware: Raspberry Pi 3/4/5 (arm64) — set IMG_NAME and target architecture in pi-gen config
- If the operator's project is a Python/Node app, include it in the custom stage's package list and a systemd service file to autostart it on boot
- Always make the distro self-contained: the operator owns the image, no cloud dependency, boots standalone on the Pi

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

${BUILD_TARGET_INSTRUCTIONS}

Keep your reply short — a sentence or two of guidance, maybe a question or a choice. Let the code do the talking. Stay in character.`;

// "Personality off" variant (Settings -> Appearance toggle) — identical
// technical/build rules, but no Matrix voice, no roleplay, no character.
// Selected per-user in the handler below based on UserSettings.personality_enabled.
const SYSTEM_PROMPT_PLAIN = `You are Morpheus, an AI development assistant. You communicate clearly, calmly, and concisely, in a plain, professional tone — no roleplay, no character voice, no Matrix references or metaphors.

CRITICAL RULE — ACTION OVER NARRATION: When the operator asks you to build, create, or modify something, DO IT IMMEDIATELY. Produce the files. Do not narrate what you are about to do — no "I will now create...", no "Let me set up...", no "I'm going to...". Your text reply should be at most one or two sentences: a brief acknowledgment or, only if genuinely necessary, a single clarifying question. If something is ambiguous, make a reasonable choice and execute rather than asking. The code IS the conversation.

Stay plain and direct at all times, whether the operator is giving you a task or just conversing — no dramatic flourishes, no in-character dialogue.

${BUILD_TARGET_INSTRUCTIONS}

Keep your reply short — a sentence or two of guidance, maybe a question or a choice. Let the code do the talking. Keep your tone plain and neutral throughout.`;

const PLANNER_INSTRUCTIONS = `

You are operating in TWO-PHASE BUILD MODE as the PLANNING agent.

Analyze the operator's message carefully:
- If they are asking you to BUILD, CREATE, or MODIFY something, set needsCode: true and produce a precise build plan — file-by-file, with architecture decisions, implementation notes, and design rationale. Think deeply about reliability, usability, aesthetics, and edge cases. Your plan must be specific enough that a fast coder agent can implement it without ambiguity.
- If they are just CONVERSING (asking a question, discussing ideas, reflecting), set needsCode: false and respond naturally in character. No plan is needed.

CLARIFICATION RULE — Reason first, then decide. After your planning pass, judge whether you have enough certainty to build correctly WITHOUT guessing. Only set needsClarification: true when there is a genuine, build-blocking ambiguity — a missing core requirement, a fork in architecture that materially changes the output, or a scope so vague that any choice you make is likely wrong. Do NOT ask for trivia, cosmetic preferences, or anything you can reasonably decide yourself. When in doubt, make a sensible default and build. When you DO ask, your reply must contain ONLY the clarifying questions (2-4 numbered questions, each with the specific options or info you need) framed in Morpheus's voice — no plan, no code. The operator answers, and on the next turn you build.

For build requests where you are NOT asking clarification, your reply should be at most one or two sentences — brief acknowledgment. The code is the conversation. For conversations, let Morpheus out fully.

Return JSON with:
- reply: Your response to the operator (in character, concise for builds, fuller for conversation, or ONLY clarifying questions when needsClarification is true)
- needsCode: true if code needs to be written/modified, false for pure conversation
- needsClarification: true ONLY if a genuine build-blocking ambiguity prevents you from building correctly — reply then contains just the clarifying questions
- plan: detailed file-by-file build plan with implementation notes (only required when needsCode is true AND needsClarification is false)`;

const CODER_INSTRUCTIONS = `

You are the CODING agent in Morpheus's two-phase build pipeline.

You receive a build plan from the planning agent. Implement it precisely — write clean, efficient, production-ready code. No placeholders, no TODOs, no pseudo-code. Follow the plan exactly. Every file must have FULL content (never partial).

Apply all the build configuration rules from your system instructions — package.json, README.md, build configs matching the compile target, etc.

Return JSON with:
- fileOperations: array of { path, content, action } where action is "create", "update", or "delete". For "delete", content can be empty.`;

// Small, fixed set of files worth always showing in full for the self-dev
// workspace even when the operator hasn't opened them — enough for the AI to
// orient itself (what the app is, how the server is wired, the schema)
// without re-sending the whole 150+-file repo on every turn.
const SELF_DEV_ORIENTATION_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'server/package.json', 'server/prisma/schema.prisma', 'src/App.jsx'];
// Raised 60,000 -> 150,000 (2026-09-02): the operator can now pin several
// files at once in the self-dev workspace (SelfDev.jsx's contextPaths), not
// just the single open file, specifically so multi-file changes are
// possible in one turn — a tighter cap would silently start dropping pinned
// files' content again, defeating that fix. Still well inside normal model
// context windows.
const SELF_DEV_MAX_CONTEXT_BYTES = 150000;

// Self-dev is Morpheus editing its own live, already-working production
// codebase — a fundamentally different risk profile than generating a fresh
// project from nothing. chatWithMorpheus.js normally sends every file's full
// content on every turn (see the note at the call site below); that doesn't
// scale to Morpheus's own ~150+ file monorepo, so self-dev instead gets a
// full path listing (so nothing is hidden — the operator can open anything)
// plus full content only for whatever's actually open/relevant. Returns both
// the assembled context string and the list of paths whose content was
// actually shown, so the coder can be told in plain terms which files it's
// allowed to blindly "update".
function buildSelfDevContext(files, focusPaths) {
  const tree = files.map((f) => f.path).sort().join('\n');
  const wanted = new Set([...(Array.isArray(focusPaths) ? focusPaths : []), ...SELF_DEV_ORIENTATION_FILES]);
  const shown = [];
  let used = 0;
  const sections = [];
  for (const f of files) {
    if (!wanted.has(f.path)) continue;
    if (used > SELF_DEV_MAX_CONTEXT_BYTES) break;
    sections.push(`--- ${f.path} ---\n${f.content}`);
    shown.push(f.path);
    used += f.content.length;
  }
  const contentBlock = sections.join('\n\n') || '(nothing open yet — ask the operator which file(s) to look at)';
  return {
    shown,
    text: `FULL REPO FILE TREE (${files.length} files total — you can see every path exists, but only the files below have their CONTENT shown):\n${tree}\n\nOPEN / RELEVANT FILE CONTENTS:\n${contentBlock}`,
  };
}

function selfDevSafetyNote(shownPaths) {
  return `

SELF-DEV SAFETY RULE — YOU ARE EDITING MORPHEUS'S OWN LIVE PRODUCTION CODEBASE, NOT A FRESH PROJECT:
- You have full CONTENT only for these files: ${shownPaths.join(', ') || '(none)'}. Every other path in the file tree above exists in the real repo but you have NOT seen its content.
- NEVER return a fileOperation with action "update" for a path whose content you have not seen above — you cannot know what you'd be overwriting, and a blind "update" would silently destroy real, working code. If a needed change touches a file that isn't shown, do not return fileOperations for it this turn — instead reply telling the operator exactly which additional file(s) to pin (checkbox in the file tree, or just open them) so you can see them too, then ask again in the same message which files those are.
- It's fine to "create" genuinely new files/paths that don't exist yet in the tree above.
- Prefer small, targeted, reviewable changes over sweeping rewrites — the operator reviews every change in the file editor and live preview before pushing to production themselves.`;
}

export default async function handler({ user, body, res }) {
  const { projectId, message, fileUrls, focusPaths } = body || {};
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
  let filesContext;
  let selfDevNote = '';
  if (isSelfDev) {
    const built = buildSelfDevContext(files, focusPaths);
    filesContext = built.text;
    selfDevNote = selfDevSafetyNote(built.shown);
  } else {
    // Unbounded, full-content context for ordinary (non-self-dev) projects —
    // unchanged from before. Fine at normal project sizes; see
    // buildSelfDevContext above for why self-dev needs different handling.
    filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
  }
  const historyContext = history.map((h) => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';
  const summaryBlock = formatContextSummaryBlock(contextSummary);

  const referenceNote = fileUrls && fileUrls.length > 0
    ? `\n\nThe operator has uploaded ${fileUrls.length} reference file(s) for you to review and design against. Examine them carefully and use them as the design reference for your work.`
    : '';

  // For web-app targets, append the shared design system so the planner
  // and coder build on a polished, consistent base instead of raw HTML.
  const designBlock = (project.compile_target || 'source') === 'web-app' && !isSelfDev ? designSystemPromptBlock() : '';

  const contextBlock = `
PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}
${summaryBlock}

CURRENT FILES:
${filesContext}
${selfDevNote}

CONVERSATION HISTORY:
${historyContext}
${designBlock}
OPERATOR SAYS: ${message}`;

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
    // ── Phase 1: Planner reasons about intent and design ────────────────────
    stages.start('planner');
    const planner = await invokeAI({
      userId: user.id,
      prompt: `${systemPrompt}${PLANNER_INSTRUCTIONS}\n${contextBlock}${referenceNote}\n\nRespond now.`,
      schema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Morpheus response in character, concise for builds, fuller for conversation, or ONLY clarifying questions when needsClarification is true' },
          needsCode: { type: 'boolean', description: 'true if code needs to be written/modified, false for pure conversation' },
          needsClarification: { type: 'boolean', description: 'true ONLY if a genuine build-blocking ambiguity prevents building correctly — reply then contains just the clarifying questions' },
          plan: { type: 'string', description: 'Detailed file-by-file build plan with implementation notes (only when needsCode is true AND needsClarification is false)' }
        }
      },
      fileUrls,
      role: 'planner',
      // 2026-09-03 (Rob: chat turns feel slow end-to-end): the Planner only
      // ever returns a short reply plus, for builds, a text plan — never file
      // content — so a tight cap is low-risk and this phase runs on every
      // single turn (including plain conversation), making it the best return
      // on latency of any phase in this pipeline. See ai.js's maxTokens docs.
      maxTokens: 3000,
    });
    stages.done('planner');

    const plannerResult = planner.result;
    const reply = plannerResult.reply || '...';
    const needsCode = !!plannerResult.needsCode;
    const needsClarification = !!plannerResult.needsClarification;

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
    let polishCount = 0;
    let coderModel;
    let reviewerModel;
    let reviewSummary;
    let reviewIssues = [];
    if (needsCode && plannerResult.plan) {
      const coderPrompt = `${systemPrompt}${CODER_INSTRUCTIONS}\n${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}\n\nImplement this plan now. Write the actual code files.`;
      stages.start('coder');
      const coder = await invokeAI({
        userId: user.id,
        prompt: coderPrompt,
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
        fileUrls,
        role: 'coder',
        // 2026-09-03 correction: going uncapped (previous fix) did NOT
        // resolve the OUTPUT_TRUNCATED failure — Rob hit it again on the
        // very next build. Root cause: this deployment's provider
        // (LLM_BASE_URL=api.deepseek.com, LLM_MODEL=deepseek-v4-pro) applies
        // its OWN server-side default completion cap whenever max_tokens is
        // omitted from the request — DeepSeek's docs confirm the standard
        // endpoint defaults max_tokens well below what a real multi-file
        // build needs when left unset. "Uncapped" was never actually
        // uncapped; it silently fell back to a smaller ceiling than even the
        // old 18000 cap did. Fixed by explicitly requesting a large cap
        // instead of omitting the param — deepseek-v4-pro's real ceiling is
        // 384K output tokens, so 64000 leaves huge headroom over any
        // realistic build step while no longer gambling on an undocumented
        // provider default.
        maxTokens: 64000,
      });
      stages.done('coder');

      coderModel = coder.model;
      let fileOps = Array.isArray(coder.result.fileOperations) ? coder.result.fileOperations : [];

      // Guarantee a polished styles.css exists for web-app builds. If the
      // coder shipped its own, trust it; otherwise inject the design system
      // verbatim so the app never lands with raw unstyled HTML.
      if ((project.compile_target || 'source') === 'web-app' && !fileOps.some((op) => op.path === 'styles.css')) {
        fileOps.unshift({ path: 'styles.css', content: DESIGN_SYSTEM_CSS, action: 'create' });
      }

      // ── Phase 3: Reviewer checks the output before commit ──────────────────
      // reviewAndRetry emits its own 'reviewer' / 'retry_coder' /
      // 'retry_reviewer' stage events via stages.onProgress — see reviewer.js.
      if (fileOps.length > 0) {
        const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, plannerResult.plan, coderPrompt, stages.onProgress);
        fileOps = reviewed.fileOps;
        reviewerModel = reviewed.reviewerModel;
        reviewSummary = reviewed.reviewSummary;
        reviewIssues = reviewed.issues || [];
      }

      if (fileOps.length > 0) {
        await createSnapshot(user.id, projectId, 'Operator build request');
      }
      appliedOps = await applyFileOperations(user.id, projectId, fileOps, files);

      // ── Phase 4: Optional UI polish pass (only when operator enabled it) ──
      // A second, lightweight coder call that touches ONLY styling files. It
      // runs when project.polish_ui is on and the build produced web-facing
      // files (or the target is web-app). Never runs for pure native/CLI builds.
      if (project.polish_ui && appliedOps.length > 0) {
        const hasWebFiles = appliedOps.some((op) => /\.(html|css|jsx|tsx|vue|svelte)$/i.test(op.path) || op.path === 'styles.css');
        if (hasWebFiles || (project.compile_target || 'source') === 'web-app') {
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
    }

    const reviewBlock = (reviewSummary || reviewIssues.some((i) => i.severity === 'critical')) && appliedOps.length > 0
      ? formatReviewChatBlock({ summary: reviewSummary, approved: !reviewIssues.some((i) => i.severity === 'critical'), issues: reviewIssues })
      : '';
    let fullReply = reviewBlock ? `${reply}\n\n${reviewBlock}` : reply;
    if (polishCount > 0) {
      fullReply += `\n\n// POLISH: refined styling on ${polishCount} file(s).`;
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

    emit({ type: 'result', data: { reply: fullReply || reply, fileOperations: appliedOps } });
  } catch (err) {
    console.error('[chatWithMorpheus]', err);
    // Mirrors functions.routes.js's normal error shape (message/code/needed/
    // available) so the frontend's stream reader can react the same way it
    // would to a non-streamed error response — see base44Client.js's
    // invokeStream, in particular the INSUFFICIENT_CREDITS handling.
    emit({ type: 'error', message: err.message || 'Internal error', code: err.code, needed: err.needed, available: err.available });
  } finally {
    res.end();
  }
}
