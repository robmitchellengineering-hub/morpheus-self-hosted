// An OpenAI-compatible fake provider that serves a BACKEND GENERATION, so the whole path can be
// exercised for zero credits.
//
// WHY THIS EXISTS. Verifying "does the backend generator produce something that runs" cost ~824 credits
// and an hour across four attempts, because every check needed a real model. That is not a testing
// strategy; it is a budget. The pipeline's own mock (`scripts/dock-rig-mock-llm.mjs`) solves the opposite
// problem — it synthesises the SMALLEST valid object and keeps `fileOperations` EMPTY, deliberately, so a
// browser rig can never write files. Empty file operations are exactly what a backend generation test
// cannot use.
//
// So this serves a FIXED, KNOWN-GOOD backend in the shape the generator asks for, from the same fixture
// the smoke test installs and boots. The result is a seam test that needs no key, no network and no
// credits, and that can therefore run on every PR:
//
//   * the planner call gets a file list;
//   * every coder chunk gets the file(s) it asked for, with real content;
//   * the files are internally consistent — which is the property #445 added context for — so this also
//     acts as the fixture that proves the mechanism end to end.
//
// WHAT IT DELIBERATELY DOES NOT DO: it is not a model, it does not read the app, and it makes no judgement.
// It answers a request for `server/db.js` with the `server/db.js` from the fixture. A test that passed
// against it would prove the WIRING, never the intelligence — which is why the source checker
// (`lib/generatedAppCheck.js`) and the real run both still exist.
//
//   node scripts/fake-backend-provider.mjs              # :4620
//   FAKE_PROVIDER_PORT=4620 node scripts/fake-backend-provider.mjs
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FAKE_PROVIDER_PORT || 4620);
const MODEL = process.env.FAKE_PROVIDER_MODEL || 'fake-backend-1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'server', 'test-fixtures', 'runnable-app');

/** The fixture, keyed by backend-relative path — the files a real generation of this shape would produce. */
function fixtureFiles() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(join(dir, e.name));
    return [join(dir, e.name)];
  });
  return walk(FIXTURE)
    .map((p) => ({ path: relative(FIXTURE, p).split('\\').join('/'), content: readFileSync(p, 'utf8') }))
    // A fixture's own .gitignore is not a backend file the generator would write, and its README is
    // replaced below by one written the way the generator is asked to write it.
    .filter((f) => f.path !== '.gitignore' && f.path !== 'README.md');
}

const FILES = fixtureFiles();
const FILE_LIST = FILES.map((f) => f.path);

/** The fixture keyed by path, so a test can check that a specific file's CONTENT reached a later prompt. */
export const FILES_BY_PATH = Object.fromEntries(FILES.map((f) => [f.path, f.content]));

/** The plan the planner call is answered with — the file list the coder chunks are then held to. */
const PLAN = {
  plannedFiles: FILE_LIST,
  summary: 'A minimal self-contained task-list API: Express, sqlite3, JWT, no external services.',
};

/**
 * Which files this request is asking for.
 *
 * The coder prompt names its chunk ("implement ONLY these file(s): a, b"), so the fake reads it back
 * rather than guessing — which is what makes this a test of the real prompt path instead of a stub that
 * happens to satisfy the schema.
 */
export function requestedFilesFrom(prompt) {
  // Stops at the sentence end, NOT at the first dot — every file here ends in one, so `[^.]+` returns
  // "server/db.js, server/routes" and the fake then answers with nothing for either. Found by running it.
  const m = /implement ONLY these file\(s\):\s*([^\n]+?)\.\s/i.exec(`${String(prompt || '')} `);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
}

/** The planner prompt asks for a JSON object with plannedFiles — answered with the fixture's list. */
export function wantsPlan(prompt) {
  return /"plannedFiles"/.test(String(prompt || '')) && /Respond as JSON/i.test(String(prompt || ''));
}

const README = `# Task list API

A self-contained task list backend. No external services, no accounts.

## One command to start

\`\`\`bash
npm install && npm start
\`\`\`

Then open http://localhost:3000

The database file is created on first run and the schema is applied at startup.
`;

export function answerFor(prompt) {
  if (wantsPlan(prompt)) return { plannedFiles: PLAN.plannedFiles, summary: PLAN.summary };

  const requested = requestedFilesFrom(prompt);
  const wanted = requested && requested.length > 0 ? requested : FILE_LIST;
  const fileOperations = [];
  for (const path of wanted) {
    const normalized = String(path).replace(/^backend\//, '');
    // Order matters: the README is generated rather than served from the fixture, and the fixture has no
    // README (it is filtered out) — so this must be tested BEFORE the fixture lookup, or a requested
    // README silently produces nothing. The first version had these the other way round and a requested
    // file went missing without a word.
    if (/(^|\/)README\.md$/i.test(normalized)) {
      fileOperations.push({ path: normalized, content: README, action: 'create' });
      continue;
    }
    const known = FILES.find((f) => f.path === normalized);
    if (known) fileOperations.push({ path: known.path, content: known.content, action: 'create' });
  }
  return { fileOperations };
}

/**
 * Every prompt this provider has been asked, in order.
 *
 * This is the point of the whole file: a test can assert on what the MODEL was actually told, rather than
 * on the helper that is supposed to tell it. The first version of the harness checked
 * `buildBackendChunkContext` directly and therefore passed while the generator was blind — because the
 * helper worked and nothing called it. Only the wire tells the truth.
 */
export const receivedPrompts = [];

export function resetReceivedPrompts() {
  receivedPrompts.length = 0;
}

export function startServer(port = PORT) {
  const server = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* answered as an empty prompt */ }
      const prompt = (parsed.messages || []).map((m) => m.content).join('\n');
      receivedPrompts.push({ prompt, at: Date.now() });
      const answer = answerFor(prompt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'fake-backend', object: 'chat.completion', model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
        // Reported so metering behaves as it does against a real provider.
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: JSON.stringify(answer).length / 4 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// Run directly (not imported by a test): stand up and stay up.
if (process.argv[1] && process.argv[1].endsWith('fake-backend-provider.mjs')) {
  await startServer();
  console.log(`[fake-backend-provider] listening on http://127.0.0.1:${PORT}/v1 (model ${MODEL})`);
  console.log(`[fake-backend-provider] serves ${FILES.length} fixture files: ${FILE_LIST.join(', ')}`);
}
