import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { createSnapshot, applyFileOperations, logUsage } from '../../shared/projectUtils.ts';
import { invokeAI } from '../../shared/aiUtils.ts';
import { buildToolchain } from '../../shared/toolchain.ts';
import { reviewAndRetry, formatReviewChatBlock } from '../../shared/reviewer.ts';
import { designSystemPromptBlock, POLISH_PROMPT } from '../../shared/designSystem.ts';

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

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, message, fileUrls } = body;
    if (!projectId || !message) return Response.json({ error: 'projectId and message required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    // Perpetual project memory: load the ENTIRE conversation history for this
    // construct (chronological order), not just a recent window. Every message
    // the operator ever entered is retained and fed back as context so Morpheus
    // builds with full knowledge of prior decisions, requirements, and fixes.
    const history = await base44.entities.ChatMessage.filter({ project_id: projectId }, 'created_date');

    await base44.entities.ChatMessage.create({ project_id: projectId, role: 'user', content: message });

    const filesContext = files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
    const historyContext = history.map(h => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';

    const referenceNote = fileUrls && fileUrls.length > 0
      ? `\n\nThe operator has uploaded ${fileUrls.length} reference file(s) for you to review and design against. Examine them carefully and use them as the design reference for your work.`
      : '';

    // For web-app targets, append the shared design system so the planner
    // and coder build on a polished, consistent base instead of raw HTML.
    const designBlock = (project.compile_target || 'source') === 'web-app' ? designSystemPromptBlock() : '';

    const contextBlock = `
PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}

CURRENT FILES:
${filesContext}

CONVERSATION HISTORY:
${historyContext}
${designBlock}
OPERATOR SAYS: ${message}`;

    // ── Phase 1: Planner reasons about intent and design ──────────────────────
    const planner = await invokeAI(base44, `${SYSTEM_PROMPT}${PLANNER_INSTRUCTIONS}\n${contextBlock}${referenceNote}\n\nRespond now.`, {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'Morpheus response in character, concise for builds, fuller for conversation, or ONLY clarifying questions when needsClarification is true' },
        needsCode: { type: 'boolean', description: 'true if code needs to be written/modified, false for pure conversation' },
        needsClarification: { type: 'boolean', description: 'true ONLY if a genuine build-blocking ambiguity prevents building correctly — reply then contains just the clarifying questions' },
        plan: { type: 'string', description: 'Detailed file-by-file build plan with implementation notes (only when needsCode is true AND needsClarification is false)' }
      }
    }, fileUrls, 'planner');

    const plannerResult = planner.result;
    const reply = plannerResult.reply || '...';
    const needsCode = !!plannerResult.needsCode;
    const needsClarification = !!plannerResult.needsClarification;

    // ── Clarification gate: if the Planner is genuinely unsure, ask before building ─
    if (needsClarification) {
      await base44.entities.ChatMessage.create({ project_id: projectId, role: 'morpheus', content: reply });
      const toolchain = buildToolchain(planner.provider, { planner: planner.model });
      await logUsage(base44, 'chat_simple', projectId, project.name, {
        messageLength: message.length,
        needsCode,
        needsClarification: true,
        ...toolchain,
      });
      return Response.json({ reply, fileOperations: [], needsClarification: true });
    }

    // ── Phase 2: Coder implements the plan (only if code is needed) ────────────
    let appliedOps: any[] = [];
    let polishCount = 0;
    let coderModel: string | undefined;
    let reviewerModel: string | undefined;
    let reviewSummary: string | undefined;
    let reviewIssues: any[] = [];
    if (needsCode && plannerResult.plan) {
      const coder = await invokeAI(base44, `${SYSTEM_PROMPT}${CODER_INSTRUCTIONS}\n${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}\n\nImplement this plan now. Write the actual code files.`, {
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
      }, fileUrls, 'coder');

      coderModel = coder.model;
      let fileOps = Array.isArray(coder.result.fileOperations) ? coder.result.fileOperations : [];

      // Guarantee a polished styles.css exists for web-app builds. If the
      // coder shipped its own, trust it; otherwise inject the design system
      // verbatim so the app never lands with raw unstyled HTML.
      if ((project.compile_target || 'source') === 'web-app' && !fileOps.some(op => op.path === 'styles.css')) {
        fileOps.unshift({ path: 'styles.css', content: (await import('../../shared/designSystem.ts')).DESIGN_SYSTEM_CSS, action: 'create' });
      }

      // ── Phase 3: Reviewer checks the output before commit ──────────────────
      if (fileOps.length > 0) {
        const coderPrompt = `${SYSTEM_PROMPT}${CODER_INSTRUCTIONS}\n${contextBlock}\n\nBUILD PLAN FROM PLANNER:\n${plannerResult.plan}\n\nImplement this plan now. Write the actual code files.`;
        const reviewed = await reviewAndRetry(base44, fileOps, contextBlock, plannerResult.plan, coderPrompt);
        fileOps = reviewed.fileOps;
        reviewerModel = reviewed.reviewerModel;
        reviewSummary = reviewed.reviewSummary;
        reviewIssues = reviewed.issues || [];
      }

      if (fileOps.length > 0) {
        await createSnapshot(base44, projectId, 'Operator build request');
      }
      appliedOps = await applyFileOperations(base44, projectId, fileOps, files);

      // ── Phase 4: Optional UI polish pass (only when operator enabled it) ──
      // A second, lightweight coder call that touches ONLY styling files. It
      // runs when project.polish_ui is on and the build produced web-facing
      // files (or the target is web-app). Never runs for pure native/CLI builds.
      if (project.polish_ui && appliedOps.length > 0) {
        const hasWebFiles = appliedOps.some(op => /\.(html|css|jsx|tsx|vue|svelte)$/i.test(op.path) || op.path === 'styles.css');
        if (hasWebFiles || (project.compile_target || 'source') === 'web-app') {
          const freshFiles = await base44.entities.ProjectFile.filter({ project_id: projectId });
          const filesForPolish = freshFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
          const polish = await invokeAI(base44, `${SYSTEM_PROMPT}${POLISH_PROMPT}\n${contextBlock}\n\nCURRENT FILES (after main build):\n${filesForPolish}\n\nProduce the polished fileOperations now.`, {
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
          }, undefined, 'coder');
          const polishOps = Array.isArray(polish.result.fileOperations) ? polish.result.fileOperations : [];
          if (polishOps.length > 0) {
            await createSnapshot(base44, projectId, 'UI polish pass (pre-polish)');
            const appliedPolish = await applyFileOperations(base44, projectId, polishOps, freshFiles);
            appliedOps = [...appliedOps, ...appliedPolish];
            polishCount = appliedPolish.length;
          }
        }
      }
    }

    const reviewBlock = (reviewSummary || reviewIssues.some(i => i.severity === 'critical')) && appliedOps.length > 0
      ? formatReviewChatBlock({ summary: reviewSummary, approved: !reviewIssues.some(i => i.severity === 'critical'), issues: reviewIssues })
      : '';
    let fullReply = reviewBlock ? `${reply}\n\n${reviewBlock}` : reply;
    if (polishCount > 0) {
      fullReply += `\n\n// POLISH: refined styling on ${polishCount} file(s).`;
    }
    await base44.entities.ChatMessage.create({ project_id: projectId, role: 'morpheus', content: fullReply });

    if (appliedOps.length > 0) {
      await base44.entities.Project.update(projectId, { status: 'building' });
    }

    // Log usage with the full toolchain manifest — SDK version, provider, and
    // the exact AI models used for each phase — so the build log records what
    // produced the output.
    const toolchain = buildToolchain(planner.provider, {
      planner: planner.model,
      coder: coderModel,
      reviewer: reviewerModel,
    });
    await logUsage(base44, appliedOps.length > 0 ? 'chat_build' : 'chat_simple', projectId, project.name, {
      messageLength: message.length,
      needsCode,
      fileCount: appliedOps.length,
      reviewed: !!reviewerModel,
      ...toolchain,
    });

    return Response.json({ reply: fullReply || reply, fileOperations: appliedOps });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}