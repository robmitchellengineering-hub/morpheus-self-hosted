// Run the REAL backend generator with no API key, no network and no credits — and assert it produced a
// backend that holds together.
//
// WHY THIS EXISTS. Every question about the backend generator used to cost money and an hour: verifying
// the two context fixes needed four attempts and ~824 credits, and one attempt was misleading because the
// local instance had no role settings so the coder ran on a reasoning model. Neither is necessary. The
// generator talks to an OpenAI-compatible endpoint, so pointing it at `fake-backend-provider.mjs` — which
// serves a known-good backend in the shape the generator asks for — exercises the whole path offline:
//
//   the planner call → the file list → every coder chunk → the context each chunk is given
//   → the syntax gate → the reviewer → the persistence write → what ends up in the project
//
// It asserts the properties that were DEFECTS, as behaviour rather than as prose:
//
//   * #444 — one file with no content must not discard the batch;
//   * #445 — a later chunk must be shown what an earlier one wrote (the context path, end to end);
//   * the generated set must be internally consistent (the thing three real files were not).
//
// WHAT IT IS NOT. It proves the WIRING, never the intelligence: the fake serves fixed files and reads back
// the chunk it was asked for. A real generation can still produce incoherent code — that is what
// `verify-generated-app.mjs` and a real run are for. This is the cheap test that must pass first, so that
// a paid run is spent on the model rather than on a broken pipe.
//
// Run:  node scripts/backend-generation-harness.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, requestedFilesFrom, wantsPlan, answerFor, receivedPrompts, resetReceivedPrompts, FILES_BY_PATH } from './fake-backend-provider.mjs';
import { INTENDED_ROLE_SETTINGS, resolvedModelFor } from '../server/src/lib/localRoleSettings.js';
import { buildBackendChunkContext } from '../server/src/lib/backendChunkContext.js';
import { generatedAppProblems } from '../server/src/lib/generatedAppCheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const PORT = Number(process.env.FAKE_PROVIDER_PORT || 4621);
const server = await startServer(PORT);
const base = `http://127.0.0.1:${PORT}/v1`;

try {
  console.log('\n1. the coder is not left on the fallback model — the mistake that made a measurement wrong');
  // Measured 2026-09-29: a local instance with NO platform settings ran every coder call on
  // `default_model` (a reasoning model), which is why a backend generation appeared to take ~26 minutes.
  // A slow measurement on an unconfigured instance measures the fallback, not the pipeline.
  check('the coder resolves to a fast model, not the reasoning default',
    resolvedModelFor('coder'), 'deepseek-flash');
  check('…and it is genuinely not the fallback', resolvedModelFor('coder') === INTENDED_ROLE_SETTINGS.default_model, false);
  check('the planner keeps the reasoning model', resolvedModelFor('planner'), 'deepseek-v4-pro');
  check('every role resolves to something', ['planner', 'coder', 'reviewer', 'diagnosis', 'classify', 'draft']
    .every((r) => typeof resolvedModelFor(r) === 'string'), true);

  console.log('\n2. the fake provider answers the two shapes the generator sends');
  const planAsk = 'Respond as JSON: { "plannedFiles": [...] }';
  check('the plan ask is recognised', wantsPlan(planAsk), true);
  const plan = answerFor(planAsk);
  check('…and answered with a file list', plan.plannedFiles.length >= 4, true);
  const chunkAsk = 'FOR THIS STEP, implement ONLY these file(s): server/db.js, server/routes/tasks.js. Return fileOperations';
  check('the chunk ask is read back', requestedFilesFrom(chunkAsk), ['server/db.js', 'server/routes/tasks.js']);
  check('…and answered for exactly those files',
    answerFor(chunkAsk).fileOperations.map((f) => f.path), ['server/db.js', 'server/routes/tasks.js']);
  check('every returned file carries content — the #444 defect was a missing one',
    answerFor(chunkAsk).fileOperations.every((f) => typeof f.content === 'string' && f.content.length > 0), true);

  console.log('\n3. a live endpoint answers like a provider, so the generator can be pointed at it');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: chunkAsk }] }),
  });
  const body = await res.json();
  check('it answers 200', res.status, 200);
  check('in the OpenAI shape the generator parses', typeof body.choices?.[0]?.message?.content, 'string');
  check('…with usage, so metering behaves as it does in production', typeof body.usage?.prompt_tokens, 'number');
  const parsed = JSON.parse(body.choices[0].message.content);
  check('…and the content is the generator\'s expected JSON', Array.isArray(parsed.fileOperations), true);

  console.log('\n4. the context path, end to end — the property #445 added');
  // Replay the real chunk sequence through the real context builder and check what each chunk is TOLD,
  // which is the only thing that can stop two generated files disagreeing.
  const planned = plan.plannedFiles;
  const written = [];
  const contexts = [];
  for (let i = 0; i < planned.length; i += 2) {
    const chunk = planned.slice(i, i + 2);
    contexts.push({ chunk, text: buildBackendChunkContext({ plannedFiles: planned, writtenSoFar: written, chunk, frontendBlock: 'fetch("/api/tasks")', planBlock: '{"tables":[]}' }).text });
    written.push(...answerFor(`implement ONLY these file(s): ${chunk.join(', ')}.`).fileOperations);
  }
  check('there was more than one chunk, or this proves nothing', contexts.length > 1, true);
  check('the FIRST chunk is shown no earlier file', contexts[0].text.includes('ALREADY WRITTEN'), false);
  // Every chunk after the first must see the files before it — the exact mechanism that was missing.
  const laterContexts = contexts.slice(1);
  check('every later chunk is shown what came before',
    laterContexts.every((c) => c.text.includes('ALREADY WRITTEN BY EARLIER STEPS')), true);
  check('…and every later chunk sees the complete file list, so nothing is invented',
    laterContexts.every((c) => planned.every((p) => c.text.includes(p))), true);
  check('…including a file written in the FIRST chunk, by name',
    contexts[1].text.includes(`--- ${planned[0]} ---`), true);
  check('…and no chunk is shown a file it has not written yet',
    contexts.every((c) => {
      const own = new Set(c.chunk);
      const others = planned.filter((p) => !own.has(p));
      return others.every((p) => !c.text.includes(`--- ${p} ---`) || written.some((w) => w.path === p));
    }), true);

  console.log('\n5. the assembled backend holds together, and the source checker agrees');
  const produced = planned.map((p) => {
    const a = answerFor(`implement ONLY these file(s): ${p}.`);
    return a.fileOperations[0] || { path: p, content: '' };
  });
  check('every planned file was answered', produced.every((f) => typeof f.content === 'string' && f.content.length > 0), true);
  const problems = generatedAppProblems(produced);
  check('the source checker finds nothing wrong with it', problems, []);

  console.log('\n6. one file with no content must not discard the rest (#444, as behaviour)');
  // The real failure: a `.env.example` with no content reached `createMany`, and Prisma rejects the whole
  // batch for one missing argument. The fix coerces to a string; this asserts the shape it produces.
  const gen = code(read('server/src/functions/generateBackend.js'));
  check('the write coerces missing content rather than passing it through',
    /content: typeof f\.content === 'string' \? f\.content : ''/.test(gen), true);
  check('…and there is still exactly one write path, so the batch cannot half-apply',
    (gen.match(/projectFile\.createMany\(/g) || []).length, 1);

  console.log('\n7. the REAL handler, run end to end against a database and the fake provider');
  // The strongest test available for zero credits: call the actual function the app calls, with the
  // provider pointed at the fake, a throwaway Postgres and a real project row. This is the test that
  // would have caught the #444 write crash and the #445 blind-chunk defect without a single credit.
  const dbUrl = process.env.HARNESS_DATABASE_URL;
  if (!dbUrl) {
    console.log('  NOT VERIFIED — HARNESS_DATABASE_URL is unset, so the handler was not run.');
    console.log('     Set it to a throwaway Postgres (see scripts/backend-generation-harness.mjs header).');
    console.log('     This is NOT a pass.\n');
    process.exitCode = 2;
  } else {
    process.env.DATABASE_URL = dbUrl;
    process.env.LLM_BASE_URL = base;
    process.env.LLM_API_KEY = 'harness-fake-key';
    process.env.LLM_MODEL = 'fake-backend-1';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'harness-only-secret';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');

    const { prisma } = await import('../server/src/db.js');
    const handler = (await import('../server/src/functions/generateBackend.js')).default;

    // A fresh project each run, so a previous run's files can never be mistaken for this one's.
    const user = await prisma.user.create({
      data: { email: `harness-${Date.now()}@local.test`, password_hash: 'x', full_name: 'Harness', email_verified: true, role: 'user', credit_balance: 100000, billing_exempt: true },
    });
    const project = await prisma.project.create({
      data: { created_by_id: user.id, name: 'Harness backend', description: 'A task list. The frontend calls GET /api/tasks and POST /api/tasks and expects { tasks: [{ id, title, done }] }.', project_type: 'backend', status: 'init' },
    });
    await prisma.projectFile.create({
      data: { created_by_id: user.id, project_id: project.id, path: 'backend/.plan.json', content: JSON.stringify({ summary: 'tasks', database: { tables: [{ name: 'tasks' }] } }), language: 'json' },
    });

    // The plan the harness asserted above, written the way planBackend writes it.
    resetReceivedPrompts();
    const result = await handler({
      user,
      body: { projectId: project.id, components: { api_host: 'standalone', database: 'sqlite-local', auth: 'jwt-self', file_storage: 'local', cache: 'none' } },
    });
    check('the handler returns a file count', typeof result.fileCount, 'number');
    check('…and it is more than the plan alone', result.fileCount > 1, true);

    const rows = await prisma.projectFile.findMany({ where: { project_id: project.id }, select: { path: true, content: true } });
    const written = rows.filter((r) => r.path !== 'backend/.plan.json');
    check('the files are actually IN THE DATABASE — the #444 failure persisted nothing', written.length > 1, true);
    check('…every one of them has content, so no row is an empty shell',
      written.every((r) => typeof r.content === 'string' && r.content.length > 0), true);
    check('…and none was silently dropped in the write',
      written.length, rows.length - 1);

    // THE CONSISTENCY PROPERTY, on what a real handler run produced: whatever the coder emitted, it must
    // not be a backend whose files disagree about their own modules.
    const asOps = written.map((r) => ({ path: r.path.replace(/^backend\//, ''), content: r.content }));
    check('what the handler persisted passes the source checker',
      generatedAppProblems(asOps), []);

    // WHAT THE MODEL WAS ACTUALLY TOLD. This is the assertion the first version of this harness was
    // missing: it checked `buildBackendChunkContext` directly and therefore passed while the generator
    // was blind, because the helper worked and nothing called it. Only the wire tells the truth.
    const coderPrompts = receivedPrompts.filter((r) => /implement ONLY these file/i.test(r.prompt));
    // The file list the handler's own planner call was answered with — read from the wire, not assumed.
    const planPrompt = receivedPrompts.find((r) => wantsPlan(r.prompt));
    const wantedPlanList = planPrompt ? answerFor(planPrompt.prompt).plannedFiles : [];
    check('the handler made more than one coder call, or chunking is not being exercised', coderPrompts.length > 1, true);
    const firstCoderFiles = requestedFilesFrom(coderPrompts[0]?.prompt || '') || [];
    check('…and the first call asked for a named subset', firstCoderFiles.length > 0, true);
    if (coderPrompts.length > 1 && firstCoderFiles.length > 0) {
      const contentOfFirst = FILES_BY_PATH[firstCoderFiles[0]] || '';
      check('a LATER coder call is shown the content of a file an earlier call produced',
        coderPrompts[1].prompt.includes(contentOfFirst.slice(0, 80)), true);
      check('…under the heading that tells it to match, not restate',
        /ALREADY WRITTEN BY EARLIER STEPS/.test(coderPrompts[1].prompt), true);
      check('…and the first call was shown no such section, because nothing had been written yet',
        /ALREADY WRITTEN BY EARLIER STEPS/.test(coderPrompts[0].prompt), false);
      check('every coder call is shown the complete file list',
        coderPrompts.every((c) => wantedPlanList.every((p) => c.prompt.includes(p))), true);
    }

    // Clean up this run's rows so repeated runs do not accumulate.
    await prisma.projectFile.deleteMany({ where: { project_id: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }

  console.log('\n8. the syntax gate the backend path was missing is wired in');
  check('generateBackend runs checkSyntax', /await checkSyntax\(/.test(gen), true);
  check('…over the files it generated', /generatedFiles[\s\S]{0,200}checkSyntax/.test(gen), true);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log('\n✗ the backend generation path is not exercised, or does not hold together\n');
    process.exitCode = 1;
  } else {
    console.log('the backend path runs offline, deterministically, and each chunk can see the last\n');
  }
} finally {
  server.close();
}
