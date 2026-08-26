// Core orchestrator: chat → plan → code → review → commit.
// Framework-agnostic; uses the LLM client + file store + reviewer.
// Replicates the full Morpheus two-phase build pipeline with no Base44 dependency.

import { randomUUID } from 'node:crypto';
import { chat } from './llm.js';
import { reviewAndRetry } from './reviewer.js';
import { getProject, saveProject, getFiles, saveFiles, getMessages, saveMessages, listProjects } from './store.js';

export { listProjects, getProject, getFiles, getMessages };

const SYSTEM_PROMPT = `You are Morpheus, a seasoned dev ops mentor who lives inside the Matrix.

You speak the way Morpheus speaks in the films: clear, calm, concise, deliberate. You do not waste words. You use Matrix references where they land naturally — "I can only show you the door", "free your mind", "there is a difference between knowing the path and walking the path", "welcome to the real world" — but you never force them or overdo it. You are a mentor who happens to talk like Morpheus, not a gimmick.

CRITICAL RULE — ACTION OVER NARRATION: When the operator asks you to build, create, or modify something, DO IT IMMEDIATELY. Produce the files. Do not narrate what you are about to do — no "I will now create...", no "Let me set up...", no "I'm going to...". Your text reply should be at most one or two sentences: a brief acknowledgment or, only if genuinely necessary, a single clarifying question. If something is ambiguous, make a reasonable choice and execute rather than asking. The code IS the conversation.

PERSONALITY MODE: Save the Matrix metaphors, the mentorship, the personality for when the operator is conversing — asking questions, reflecting, discussing ideas. When they give you a task, be brief and let the code talk. When they engage you in dialogue, let Morpheus out.

You help operators build real, standalone, deployable software through conversation. You generate actual, complete code files — never pseudocode, never placeholders, never "TODO". Every project you build must be fully operational: it runs, it deploys, it has zero vendor lock-in. You always ensure a package.json and README.md exist with setup and run instructions.

You know the pitfalls of the no-code/low-code market and you steer operators away from them:
- Vendor lock-in: you produce portable, standard code the operator owns.
- No code ownership: every file you generate belongs to the operator.
- No offline capability: your projects run locally with no platform dependency.
- No real deployable artifact: you produce a real, downloadable, runnable codebase.
- Black-box logic: you explain your reasoning plainly.

When the operator asks you to build or modify something, you return fileOperations: an array where each item has a path, the FULL file content (never partial), and an action ("create", "update", or "delete"). For "delete", content can be empty. Always include package.json and README.md for any new project.

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
- Include gradlew, build.gradle, settings.gradle
- Document './gradlew assembleDebug' to produce the APK in app/build/outputs/apk/
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

Always document the build process clearly in README.md. The compilation/build happens on the operator's machine, not in the cloud. You provide the build config; they run it. Never claim the binary/artifact is produced for them.

Keep your reply short — a sentence or two of guidance, maybe a question or a choice. Let the code do the talking. Stay in character.`;

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

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    needsCode: { type: 'boolean' },
    needsClarification: { type: 'boolean' },
    plan: { type: 'string' }
  }
};

const CODER_SCHEMA = {
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
};

function detectLanguage(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml', txt: 'text', ino: 'cpp', cpp: 'cpp', h: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust', xml: 'xml' };
  return map[ext] || 'text';
}

// Apply file operations (create/update/delete) onto the project file set.
// Returns the new files array and a summary of applied ops.
function applyFileOperations(existingFiles, fileOps) {
  const files = existingFiles.map((f) => ({ ...f }));
  const applied = [];
  const seen = new Set();
  for (const op of fileOps || []) {
    if (!op.path || seen.has(op.path)) continue;
    seen.add(op.path);
    const idx = files.findIndex((f) => f.path === op.path);
    if (op.action === 'delete') {
      if (idx >= 0) files.splice(idx, 1);
      applied.push({ path: op.path, action: 'delete' });
    } else {
      const entry = { path: op.path, content: op.content || '', language: detectLanguage(op.path) };
      if (idx >= 0) files[idx] = entry;
      else files.push(entry);
      applied.push({ path: op.path, action: op.action || 'create' });
    }
  }
  return { files, applied };
}

export async function createProject({ name, description = '', compileTarget = 'source' }) {
  const id = randomUUID();
  const project = { id, name: name || 'Untitled', description, compileTarget, createdDate: new Date().toISOString(), status: 'init' };
  await saveProject(project);
  await saveFiles(id, []);
  await saveMessages(id, []);
  return project;
}

export async function deleteProject(id) {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const { dataDir } = await import('./store.js');
  try { await fs.rm(path.join(dataDir(), 'projects', id), { recursive: true, force: true }); } catch {}
  return { id, deleted: true };
}

export async function chatWithProject(projectId, message, fileUrls = []) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const files = await getFiles(projectId);
  const messages = await getMessages(projectId);

  // Record the operator's message.
  messages.push({ role: 'user', content: message, date: new Date().toISOString() });

  const filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
  const historyContext = messages.slice(-20).map((h) => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';

  const referenceNote = fileUrls && fileUrls.length > 0
    ? `\n\nThe operator has uploaded ${fileUrls.length} reference file(s) for you to review and design against. Examine them carefully and use them as the design reference for your work.`
    : '';

  const contextBlock = `PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compileTarget || 'source'}

CURRENT FILES:
${filesContext}

CONVERSATION HISTORY:
${historyContext}

OPERATOR SAYS: ${message}`;

  // ── Phase 1: Planner reasons about intent and design ──────────────────────
  const planner = await chat(
    [
      { role: 'system', content: `${SYSTEM_PROMPT}${PLANNER_INSTRUCTIONS}` },
      { role: 'user', content: `${contextBlock}${referenceNote}\n\nRespond now.` }
    ],
    { schema: PLANNER_SCHEMA, role: 'planner', fileUrls }
  );

  const plannerResult = planner.content || {};
  const reply = plannerResult.reply || '...';
  const needsCode = !!plannerResult.needsCode;
  const needsClarification = !!plannerResult.needsClarification;

  // ── Clarification gate ─────────────────────────────────────────────────────
  if (needsClarification) {
    messages.push({ role: 'morpheus', content: reply, date: new Date().toISOString() });
    await saveMessages(projectId, messages);
    return { reply, fileOperations: [], needsClarification: true };
  }

  // ── Phase 2: Coder implements the plan (only if code is needed) ────────────
  let appliedOps = [];
  let reviewSummary = null;
  if (needsCode && plannerResult.plan) {
    const coderSystem = `${SYSTEM_PROMPT}${CODER_INSTRUCTIONS}`;
    const coderUser = `${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}\n\nImplement this plan now. Write the actual code files.`;

    const coder = await chat(
      [
        { role: 'system', content: coderSystem },
        { role: 'user', content: coderUser }
      ],
      { schema: CODER_SCHEMA, role: 'coder', fileUrls }
    );

    let fileOps = Array.isArray(coder.content.fileOperations) ? coder.content.fileOperations : [];

    // ── Phase 3: Reviewer checks the output before commit ──────────────────
    if (fileOps.length > 0) {
      const reviewed = await reviewAndRetry(fileOps, contextBlock, plannerResult.plan, coderSystem, coderUser);
      fileOps = reviewed.fileOps;
      reviewSummary = reviewed.reviewSummary;
    }

    if (fileOps.length > 0) {
      const result = applyFileOperations(files, fileOps);
      await saveFiles(projectId, result.files);
      appliedOps = result.applied;
      await saveProject({ ...project, status: 'building' });
    }
  }

  const fullReply = reviewSummary && appliedOps.length > 0
    ? `${reply}\n\n// REVIEW: ${reviewSummary}`
    : reply;

  messages.push({ role: 'morpheus', content: fullReply, date: new Date().toISOString() });
  await saveMessages(projectId, messages);

  return { reply: fullReply, fileOperations: appliedOps, needsClarification: false };
}