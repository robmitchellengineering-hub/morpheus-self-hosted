// Ported from base44/functions/generateTests/entry.ts.
//
// Analyzes the operator's construct and writes a complete test suite + CI
// workflow as project files.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { createSnapshot, applyFileOperations, logUsage } from '../lib/projectUtils.js';
import { reviewAndRetry } from '../lib/reviewer.js';

const TESTS_PROMPT = `You are Morpheus, operating in TEST GENERATION MODE inside the Matrix.

Your job: analyze the operator's construct and generate a complete, production-grade test suite plus CI pipeline. You do not narrate — you produce files.

RULES:
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
8. If tests already exist, extend them — don't replace working tests with empty ones.

Return fileOperations for all files to create/update. Each item: path, FULL content, action ("create" or "update"). Never use "delete" in this mode.

Also return a summary: a brief (1-2 sentence) Morpheus-style note on what was generated, and testCount (number of test files generated).`;

export default async function handler({ user, body }) {
  const { projectId, spec } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });

  if (files.length === 0) {
    throw Object.assign(new Error('No files to test — build something first.'), { status: 400 });
  }

  await createSnapshot(user.id, projectId, 'Pre-test generation');

  const filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');

  const prompt = `${TESTS_PROMPT}

PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}
${spec ? 'OPERATOR SPEC: ' + spec : ''}

CURRENT FILES:
${filesContext}

Analyze the construct. Generate a complete test suite and CI pipeline now. Return fileOperations for all test files, CI config, and any dependency updates needed.`;

  const llmResponse = await invokeAI({
    userId: user.id,
    prompt,
    schema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'Brief Morpheus note on what was generated' },
        fileOperations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              action: { type: 'string', enum: ['create', 'update'] }
            }
          }
        },
        testCount: { type: 'number', description: 'Number of test files generated' }
      }
    },
    fileUrls: undefined,
    role: 'coder',
  });

  const llmResult = llmResponse.result;
  const reply = llmResult.reply || '...';
  let fileOps = Array.isArray(llmResult.fileOperations) ? llmResult.fileOperations : [];
  const testCount = llmResult.testCount || 0;

  // ── Reviewer: check the generated tests before commit, retry on critical issues ──
  if (fileOps.length > 0) {
    const contextBlock = `TEST GENERATION\nProject: ${project.name}\n${project.description ? 'Description: ' + project.description : ''}\nCompile target: ${project.compile_target || 'source'}\n\nCURRENT FILES:\n${filesContext}`;
    const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, undefined, prompt);
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

  await logUsage(user.id, 'test_generation', projectId, project.name, { testCount, fileCount: fileOps.length });
  return { reply, fileOperations: appliedOps, testCount };
}
