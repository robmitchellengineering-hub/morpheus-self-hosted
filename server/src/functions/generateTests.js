// Ported from base44/functions/generateTests/entry.ts.
//
// Analyzes the operator's construct and writes a complete test suite + CI
// workflow as project files.
import { prisma } from '../db.js';
import { appliedPaths } from '../lib/appliedOps.js';
import { invokeAI } from '../ai.js';
import { createSnapshot, applyFileOperations, logUsage } from '../lib/projectUtils.js';
import { reviewAndRetry } from '../lib/reviewer.js';
import { generateFilesChunked } from '../lib/chunkedFileGen.js';

// 2026-09-03: this used to be one prompt asking for the ENTIRE test suite +
// CI config as fileOperations in a single invokeAI call, with no maxTokens
// set at all — the exact same "unbounded multi-file output, provider's
// undocumented default silently truncates it" shape that caused the
// chatWithMorpheus OUTPUT_TRUNCATED incident (see that file's Planner/Coder
// comments). A real project's test suite is easily more files than one
// completion can safely hold. Split into a small PLAN call (enumerate which
// test/CI files are needed) followed by a chunked WRITE pass (a few files'
// full content per call), same pattern chatWithMorpheus.js uses for builds.
const TESTS_RULES = `RULES:
1. Detect the project's language, framework, and test runner from the existing files (package.json scripts, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, etc.).
2. Generate REAL test files — actual assertions, real edge cases, no placeholders, no "TODO: write tests", no skipped tests. Every test must exercise real logic from the source files.
3. Cover the core modules: unit tests for key functions/classes, and integration tests where multiple components interact. Aim for meaningful coverage — test happy paths, edge cases, and error handling.
4. Generate a CI configuration file appropriate to the platform:
   - Node.js/JS/TS: .github/workflows/ci.yml using GitHub Actions — install deps, run tests, lint if configured. Use the test runner detected from package.json (jest, vitest, mocha, npm test).
   - Python: .github/workflows/ci.yml — pip install -r requirements.txt, pytest (or unittest). If pytest not in requirements, add it and generate pytest.ini or conftest.py as needed.
   - Go: .github/workflows/ci.yml — go test ./...
   - Rust: .github/workflows/ci.yml — cargo test
   - Java/Kotlin (Gradle): .github/workflows/ci.yml — ./gradlew test
   - Arduino/PlatformIO: .github/workflows/ci.yml — pio run (compile check, no unit test on CI for embedded)
   - If the project has no recognizable test runner, add one to the dependencies and document it.
5. If the project is a web app (React/Vue/Vite), also add a test script to package.json if missing, and use vitest or jest with jsdom environment.
6. For compile targets that produce binaries (windows-exe, mac-app, linux-binary), the CI should also run the build step to verify the artifact compiles.
7. Never delete or overwrite existing source files. Only create or update test files, CI config, and dependency manifests (package.json, requirements.txt) to add test dependencies.
8. If tests already exist, extend them — don't replace working tests with empty ones.`;

const TESTS_PLAN_PROMPT = `You are Morpheus, planning a TEST GENERATION pass inside the Matrix.

Your job here is ONLY to decide which files are needed — you do not write file content yet.

${TESTS_RULES}

Return JSON:
- reply: brief (1-2 sentence) Morpheus-style note on what you're about to generate
- plannedFiles: ordered array of every file path you will create or update (test files, CI config, dependency manifests) — list EVERY file, a later pass implements this list a few files at a time so it must be complete and exact`;

const TESTS_WRITE_PROMPT = `You are Morpheus, operating in TEST GENERATION MODE inside the Matrix.

You do not narrate — you produce files.

${TESTS_RULES}

Reply with a single JSON object whose "fileOperations" array has one entry per requested file (path, FULL content, action "create" or "update"). Never "delete" in this mode, never partial content, never "continued". Do NOT reply with a schema or a description of the shape — the whole object, with the real content inside it.`;

export default async function handler({ user, body }) {
  const { projectId, spec } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // 2026-09-02 fix: ProjectFile's real uniqueness is [project_id, path]
  // (schema.prisma), not per-user -- same fix as chatWithMorpheus.js /
  // autonomousBuildStep.js. Scoping by project_id alone avoids a blind
  // create() -> Prisma P2002 crash on a path that already exists under a
  // different created_by_id; project ownership is already enforced above.
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId } });

  if (files.length === 0) {
    throw Object.assign(new Error('No files to test — build something first.'), { status: 400 });
  }

  await createSnapshot(user.id, projectId, 'Pre-test generation');

  const filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');

  const projectContext = `PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}
${spec ? 'OPERATOR SPEC: ' + spec : ''}

CURRENT FILES:
${filesContext}`;

  // ── Phase 1: plan which test/CI files are needed (small, bounded output) ──
  const planResponse = await invokeAI({
    userId: user.id,
    prompt: `${TESTS_PLAN_PROMPT}\n\n${projectContext}\n\nAnalyze the construct and plan the test suite + CI pipeline now.`,
    schema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: "Brief Morpheus-style note on what's about to be generated" },
        plannedFiles: { type: 'array', items: { type: 'string' }, description: 'Every test/CI/dependency-manifest file path to create or update' },
      },
    },
    fileUrls: undefined,
    role: 'planner',
    maxTokens: 6000,
  });
  const reply = planResponse.result.reply || '...';
  const plannedFiles = Array.isArray(planResponse.result.plannedFiles)
    ? planResponse.result.plannedFiles.filter((p) => typeof p === 'string' && p)
    : [];

  // ── Phase 2: write the planned files a few at a time (chunked — see chunkedFileGen.js) ──
  const { fileOps: generatedOps, chunked } = await generateFilesChunked({
    userId: user.id,
    plannedFiles,
    role: 'coder',
    buildPrompt: (chunk, allPlanned) => {
      if (!chunk) {
        // No plannedFiles came back — fall back to the original one-shot ask.
        return `${TESTS_WRITE_PROMPT}\n\n${projectContext}\n\nAnalyze the construct. Generate a complete test suite and CI pipeline now. Reply with that single JSON object now, covering the test files, CI config, and any dependency updates.`;
      }
      return `${TESTS_WRITE_PROMPT}\n\n${projectContext}\n\nFULL FILE LIST FOR THIS TEST SUITE (for context only — do not write these now): ${allPlanned.join(', ')}\n\nFOR THIS STEP, implement ONLY these file(s): ${chunk.join(', ')}. Reply with that single JSON object now, containing only these files.`;
    },
  });
  let fileOps = generatedOps;
  const testCount = fileOps.filter((op) => !/ci\.ya?ml$|workflows\//i.test(op.path)).length;

  // ── Reviewer: check the generated tests before commit, retry on critical issues ──
  if (fileOps.length > 0) {
    const contextBlock = `TEST GENERATION\nProject: ${project.name}\n${project.description ? 'Description: ' + project.description : ''}\nCompile target: ${project.compile_target || 'source'}\n\nCURRENT FILES:\n${filesContext}`;
    const retryPrompt = `${TESTS_WRITE_PROMPT}\n\n${projectContext}`;
    const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, undefined, retryPrompt);
    fileOps = reviewed.fileOps;
  }

  const appliedOps = await applyFileOperations(user.id, projectId, fileOps, files);

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      role: 'morpheus',
      content: `[TESTS] ${reply}`,
    },
  });

  await logUsage(user.id, 'test_generation', projectId, project.name, { testCount, fileCount: fileOps.length, chunked });
  return { reply, fileOperations: appliedOps, changedPaths: appliedPaths(appliedOps), testCount };
}
