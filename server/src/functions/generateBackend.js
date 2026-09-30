// Ported from base44/functions/generateBackend/entry.ts.
//
// Generates production-ready backend code files based on the architecture
// plan and the chosen deployment target. Uses the coder model, then runs the
// review-and-retry pass before committing. Files are saved as ProjectFile
// records with a "backend/" path prefix.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { buildCodegenPrompt, buildEnvVars, selfContainedRequirement } from '../lib/infrastructureComponents.js';
import { logUsage } from '../lib/projectUtils.js';
import { reviewAndRetry } from '../lib/reviewer.js';
import { checkSyntax } from '../lib/syntaxCheck.js';
import { buildBackendChunkContext } from '../lib/backendChunkContext.js';
import {
  planWrites, staleBackendPaths, persistIncrementally, removeStale, partialRunNote, normalizeBackendPath,
} from '../lib/incrementalPersist.js';
import { generateFilesChunked } from '../lib/chunkedFileGen.js';

function detectLanguage(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', sql: 'sql', toml: 'toml',
    yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
    env: 'bash', dockerfile: 'dockerfile',
  };
  return map[ext] || 'text';
}

export default async function handler({ user, body }) {
  const { projectId, components } = body || {};
  if (!projectId || !components) throw Object.assign(new Error('projectId and components required'), { status: 400 });

  const codegenHint = buildCodegenPrompt(components);
  const envVars = buildEnvVars(components);

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const planFile = files.find((f) => f.path === 'backend/.plan.json');
  if (!planFile) throw Object.assign(new Error('No backend plan found. Run planning first.'), { status: 400 });

  const plan = JSON.parse(planFile.content);
  const frontendFiles = files.filter((f) => !f.path.startsWith('backend/'));
  const isStandalone = project.project_type === 'backend';
  const fileSummary = frontendFiles
    .map((f) => `--- ${f.path} ---\n${f.content.substring(0, 1500)}`)
    .join('\n\n')
    .substring(0, 15000);

  // The one thing that makes "runs on your own machine" true rather than advertised: a single command
  // that brings the WHOLE thing up. Derived from the components (lib/infrastructureComponents.js) rather
  // than from a posture name, so a stack that needs an account can never be handed this instruction —
  // and so the exact words the model receives are assertable by a guard.
  const runnableRequirement = selfContainedRequirement(components);

  const refSection = frontendFiles.length > 0
    ? `Reference files (for API contract reference — match the fetch/axios calls the frontend makes):\n${fileSummary}`
    : (isStandalone ? 'No reference files provided — generate the backend based on the plan and project description.' : 'No frontend files available.');

  const backendBrief = `You are Morpheus, a backend code generator. Generate production-ready backend code.
${runnableRequirement}

Infrastructure components (generate code that connects ALL of these):
${codegenHint}

Required environment variables: ${envVars.join(', ')}

Backend Plan:
${JSON.stringify(plan, null, 2)}

${refSection}`;

  // 2026-09-03: this used to be a single "generate ALL backend files" call
  // with NO maxTokens set — the same unbounded-multi-file-output shape that
  // caused the chatWithMorpheus OUTPUT_TRUNCATED incident (see that file's
  // comments, and chunkedFileGen.js). Split into a small file-list PLAN call
  // followed by a chunked WRITE pass, same pattern as chatWithMorpheus.js
  // and generateTests.js.
  const planPrompt = `${backendBrief}

Decide which backend files are needed. You do not write file content yet. Include:
- Server entry point and all route handlers
- Database schema / migrations
- Auth middleware
- Config files (package.json, wrangler.toml, docker-compose.yml, Dockerfile, .env.example, etc.)
- README with setup instructions

Respond as JSON: { "plannedFiles": ["string" (path, relative, WITHOUT "backend/" prefix), ...], "summary": "string" }`;

  const planSchema = {
    type: 'object',
    properties: {
      plannedFiles: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['plannedFiles', 'summary'],
  };

  const { result: filePlan } = await invokeAI({ userId: user.id, prompt: planPrompt, schema: planSchema, role: 'planner', maxTokens: 6000 });
  const plannedFiles = Array.isArray(filePlan.plannedFiles) ? filePlan.plannedFiles.filter((p) => typeof p === 'string' && p) : [];
  const summary = filePlan.summary || 'Backend generated.';

  const writePrompt = `You are Morpheus, a backend code generator. Write full, production-ready file content for the requested file(s) only.

${backendBrief}

Keep code concise but complete — no placeholders, no TODOs, no "// implement this". Every file must be fully functional.

HOW TO REPLY, and it matters more than it looks: reply with a single JSON object. Its "fileOperations" array has one entry per file, each with "path" (relative, WITHOUT the "backend/" prefix), FULL "content", and action "create".

Do NOT reply with a JSON schema, a description of the shape, or the string "fileOperations" on its own — the whole object, with the real file content inside it. A reply that describes the format instead of using it produces nothing usable, and the run is wasted.`;

  // ── Persist as we go ────────────────────────────────────────────────────────────────────────────
  // The store writes ONE file at a time, replacing by path, so a run that dies halfway keeps everything it
  // had produced and leaves the previous version of anything it had not reached. The old code deleted the
  // whole existing backend and then wrote the new set in a single batch at the very end, which is how a
  // truncation, a schema echo and a runaway review each cost every file the run had generated.
  const store = {
    writeFile: async ({ path, content }) => {
      const language = detectLanguage(path);
      const existing = await prisma.projectFile.findUnique({
        where: { project_id_path: { project_id: projectId, path } },
        select: { id: true },
      });
      if (existing) {
        await prisma.projectFile.update({ where: { id: existing.id }, data: { content, language } });
      } else {
        await prisma.projectFile.create({ data: { created_by_id: user.id, project_id: projectId, path, content, language } });
      }
    },
    deleteByPath: async (path) => {
      await prisma.projectFile.deleteMany({ where: { project_id: projectId, path } });
    },
    existingPaths: async () => (await prisma.projectFile.findMany({ where: { project_id: projectId }, select: { path: true } }))
      .map((r) => r.path),
  };

  // Every path this run has put on disk, so the stale sweep at the end knows what it did NOT produce.
  const savedPaths = new Set();
  // Persist one chunk's operations the moment they arrive, and report what could not be saved without
  // abandoning the chunks that could. `generateFilesChunked` accumulates its own in-memory ops for the
  // context each chunk is shown; this mirrors them to the database as they land.
  const persistChunk = async (ops) => {
    const { writes } = planWrites(ops);
    if (writes.length === 0) return { written: [], failed: [] };
    const result = await persistIncrementally({ writes, store });
    for (const p of result.written) savedPaths.add(p);
    if (result.failed.length > 0) {
      console.error(`[generateBackend] could not save ${result.failed.length} file(s): ${result.failed.map((f) => `${f.path} (${f.reason})`).join('; ')}`);
    }
    return result;
  };

  try {
    // THE SAME MECHANISM THE BUILD PIPELINE USES. `generateFilesChunked` calls the model once per chunk of
    // files, so each call must be shown what the earlier calls produced — otherwise `routes/tasks.js` is
    // written with no idea what `db.js` looks like, which is exactly how a generated backend ends up with
    // three files holding three different beliefs about `db`. The pipeline solves this by assembling its
    // context from the project's CURRENT files before every Coder call (lib/scopedContext.js); this does
    // the same thing for a backend that does not exist on disk yet, from the operations generated so far.
    //
    // Measured 2026-09-29: without this, `server/index.js` awaited `initializeDatabase` from `./db` while
    // `server/routes/tasks.js` called `db.all(...)` on the same module, and a third file imported a
    // `middleware/auth` directory that was never in the file list.
    const writerContext = (chunk, allPlanned, writtenSoFar) => buildBackendChunkContext({
      plannedFiles: allPlanned || [],
      writtenSoFar,
      chunk: chunk || [],
      planBlock: JSON.stringify(plan, null, 2),
      frontendBlock: fileSummary,
    }).text;

    // `writtenSoFar` is threaded through `buildPrompt`'s third argument — see chunkedFileGen.js, which
    // passes the accumulated operations to each subsequent call for exactly this purpose.
    const { fileOps: rawFileOps } = await generateFilesChunked({
      userId: user.id,
      plannedFiles,
      role: 'coder',
      // Files land in the database as each chunk arrives, so a failure in any later stage keeps them.
      onChunk: persistChunk,
      buildPrompt: (chunk, allPlanned, writtenSoFar) => {
        const context = writerContext(chunk, allPlanned, writtenSoFar);
        if (!chunk) {
          return `${writePrompt}\n\n${context}\n\nGenerate ALL backend files needed now — the full set listed above.`;
        }
        // The trailing sentence used to read "Return fileOperations for ONLY this file set", and THAT is
        // what the model parroted back — it replied with the schema (`{"type":"object","properties":...}`)
        // rather than any file. Measured by A/B on real calls, one variable at a time:
        //
        //   plan as JSON  + "Return fileOperations"  -> SCHEMA ECHO
        //   plan as JSON  + "Reply with a single JSON object whose fileOperations array ..."  -> OK
        //   no plan       + "Return fileOperations"  -> SCHEMA ECHO
        //   plan as text  + "Return fileOperations"  -> OK
        //
        // So the instruction was the primary trigger and the plan format a secondary one; both are fixed.
        // Asking for a named key and then naming it again as the instruction is an invitation to describe
        // it rather than produce it.
        return `${writePrompt}\n\n${context}\n\nFOR THIS STEP, implement ONLY these file(s): ${chunk.join(', ')}. Reply with that single JSON object now, containing only this file set.`;
      },
    });
    let generatedFiles = rawFileOps.map((f) => ({ path: f.path, content: f.content }));

    // ── Reviewer: check the generated backend code before commit, retry on critical issues ──
    if (generatedFiles.length > 0) {
      const fileOps = generatedFiles.map((f) => ({
        path: f.path.startsWith('backend/') ? f.path : `backend/${f.path}`,
        content: f.content,
        action: 'create',
      }));
      const contextBlock = `BACKEND CODE GENERATION\nProject: ${project.name}\n${project.description ? 'Description: ' + project.description : ''}\nCompile target: ${project.compile_target || 'source'}\nComponents: ${JSON.stringify(components)}\n\nBACKEND PLAN:\n${JSON.stringify(plan, null, 2)}`;
      const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, JSON.stringify(plan, null, 2), writePrompt);
      generatedFiles = reviewed.fileOps.map((op) => ({ path: op.path, content: op.content }));
      // The reviewer may have corrected files. Write those too, so what was reviewed is what is on disk —
      // and note that this REPLACES by path rather than deleting first, so a failure here leaves the
      // pre-review version rather than nothing.
      await persistChunk(reviewed.fileOps.map((op) => ({ path: op.path, content: op.content })));
    }

    // ── Syntax gate: the same deterministic check the build pipeline runs, which the backend path
    // never did. `reviewAndRetry` is an AI opinion; this is a parser. A generated backend that does not
    // parse cannot be reviewed meaningfully, and shipping one means the operator's first command fails on
    // a file the model was confident about. Cheap, local, no tokens.
    if (generatedFiles.length > 0) {
      const parseErrors = await checkSyntax(
        generatedFiles
          .filter((f) => typeof f.content === 'string')
          .map((f) => ({ path: f.path, content: f.content })),
      );
      if (parseErrors.length > 0) {
        // Reported, not swallowed, and the files are still kept: a partial backend the operator can see
        // beats an empty project, and the message names the file so the next turn can fix it.
        const named = parseErrors.slice(0, 5).map((e) => `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}`).join('; ');
        console.error(`[generateBackend] generated backend has ${parseErrors.length} syntax error(s): ${named}`);
      }
    }

    // A LATER STAGE FAILING MUST NOT ERASE WHAT EARLIER ONES SAVED. Everything above persists as it goes,
    // so by the time the reviewer or the syntax gate runs, the generated files are already on disk. Rethrown
    // as-is, the failure reaches the caller as a bare error and the operator is told nothing about the work
    // that succeeded — which is how a 473-credit run reported only "nothing was persisted". The note names
    // the files that DID land and the ones that did not, so a partial backend is actionable.
  } catch (err) {
    const saved = [...savedPaths];
    const note = partialRunNote({
      written: saved,
      total: plannedFiles.length || null,
      reason: (err && err.message) || String(err),
    });
    if (note) console.error(`[generateBackend] run failed after saving ${saved.length} file(s): ${note}`);
    const wrapped = new Error(`${(err && err.message) || String(err)}${note ? ` ${note}` : ''}`);
    wrapped.cause = err;
    wrapped.savedFiles = saved;
    wrapped.partial = true;
    throw wrapped;
  }

  // ── The stale sweep, ONLY now ────────────────────────────────────────────────────────────────────
  // Files this run did not produce are leftovers from an earlier generation. The sweep runs LAST, after
  // every stage that can still fail, because deleting first is exactly the mistake this replaced: the old
  // code removed the whole existing backend up front and then began producing the one that might never
  // arrive, so a failure left the operator with neither.
  //
  // It also cannot run before the reviewer has had its say: a file the reviewer DROPPED is legitimately
  // stale, and one it merely has not corrected yet is not.
  const existingPaths = await store.existingPaths();
  const stale = staleBackendPaths(existingPaths, [...savedPaths]);
  const swept = await removeStale({ paths: stale, store });
  if (swept.failed.length > 0) {
    console.error(`[generateBackend] could not remove ${swept.failed.length} stale file(s): ${swept.failed.map((f) => f.path).join(', ')}`);
  }

  const savedCount = savedPaths.size;
  await logUsage(user.id, 'autonomous_step', projectId, project.name, { phase: 'backend_generate', components, fileCount: savedCount });

  // `summary` describes the WHOLE planned set; `fileCount` is what actually reached disk. When they
  // disagree the caller is told, because a backend missing files and saying nothing is the failure this
  // whole area keeps producing.
  const allWritten = plannedFiles.length === 0 || plannedFiles.every((p) => savedPaths.has(normalizeBackendPath(p)));
  return {
    fileCount: savedCount,
    summary,
    status: 'generated',
    incomplete: !allWritten,
    missing: plannedFiles.map(normalizeBackendPath).filter((p) => !savedPaths.has(p)),
  };
}
