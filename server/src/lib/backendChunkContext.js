// What a backend generation chunk gets to see.
//
// WHY THIS EXISTS — and why it is extracted rather than inlined.
//
// The main build pipeline produces good, self-consistent code because of ONE structural property: before
// every Coder call it assembles a context block from the project's CURRENT files (`lib/scopedContext.js`),
// so a later chunk can see what an earlier one wrote. The backend generator never did that. It passed the
// frontend files and the plan, and nothing else — so `generateFilesChunked` asked the model for
// `server/db.js` and then, in a separate call, for `server/routes/tasks.js`, with no way to know what the
// first call had produced.
//
// That is exactly the failure observed on 2026-09-29. One generated backend contained, simultaneously:
//
//   server/index.js        const { initializeDatabase } = require('./db');  await initializeDatabase();
//   server/routes/tasks.js const db = require('../db');                    await db.all('SELECT ...');
//   server/index.js        require('./middleware/auth');   // never generated
//
// Three files, three different beliefs about what `db` is. No amount of prompt-shaping fixes that,
// because the model was never shown the disagreement — it could not have been, each file was written
// blind. Rob, 2026-09-29: the backend generator should work "in the same way we get good working code
// from the pipeline". This is that same way, for the backend.
//
// WHAT IT DOES NOT DO: it does not review, syntax-check, or repair. It decides what the model is TOLD.
// Pair it with the same checks the pipeline runs, or the context is only half the mechanism.
//
// Import-free, so the guard runs with no install.

/**
 * The plan as readable lines rather than JSON.
 *
 * Accepts either the object or a JSON string (the caller has both to hand). Everything the backend needs
 * survives: the tables and their columns, the routes, the auth strategy, the storage, the env vars. What
 * does not survive is the braces — which is the point.
 */
export function renderPlanAsText(plan) {
  let p = plan;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return `PLAN (unstructured):\n${plan}`; } }
  if (!p || typeof p !== 'object') return '';

  const lines = [];
  if (p.summary) lines.push(`Summary: ${p.summary}`);

  const tables = p.database?.tables;
  if (Array.isArray(tables) && tables.length) {
    lines.push('Tables:');
    for (const t of tables) {
      const cols = Array.isArray(t?.columns) ? t.columns.map((c) => `${c.name} ${c.type || ''}${c.primary ? ' PRIMARY KEY' : ''}${c.nullable === false ? ' NOT NULL' : ''}`.trim()).join(', ') : '';
      lines.push(`  ${t?.name || 'unnamed'}${cols ? `: ${cols}` : ''}`);
    }
  }

  const routes = p.api?.routes;
  if (Array.isArray(routes) && routes.length) {
    lines.push('Routes:');
    for (const r of routes) lines.push(`  ${r?.method || 'GET'} ${r?.path || '/'}${r?.description ? ` — ${r.description}` : ''}`);
  }

  if (p.auth?.strategy) lines.push(`Auth: ${p.auth.strategy}${p.auth.details ? ` — ${p.auth.details}` : ''}`);
  if (p.storage?.type) lines.push(`Storage: ${p.storage.type}${p.storage.details ? ` — ${p.storage.details}` : ''}`);
  if (Array.isArray(p.envVars) && p.envVars.length) lines.push(`Environment variables: ${p.envVars.join(', ')}`);
  if (p.recommendations) lines.push(`Notes: ${p.recommendations}`);

  return `PLAN FOR THIS BACKEND (the requirements, in words — the response format is defined below, not here):\n${lines.join('\n')}`;
}

/** Roughly how much context one chunk may carry. Matches the scoped-context budget the pipeline uses. */
export const BACKEND_CONTEXT_MAX_BYTES = 60_000;

/**
 * Normalise a path so `server/db.js`, `backend/server/db.js` and `./server/db.js` are one file.
 *
 * The generated output and the plan disagree about the prefix — one names files relative to the backend
 * root, the other sometimes includes `backend/` — and the generator already carries a comment about
 * `reviewAndRetry` returning both `api/v1/tasks.js` and `backend/api/v1/tasks.js`. De-duplicating on a
 * normalised key is the difference between "already written" being visible and being missed.
 */
export function normalizeBackendPath(path) {
  const p = String(path || '').trim().replace(/^\.\//, '');
  return p.startsWith('backend/') ? p.slice('backend/'.length) : p;
}

/**
 * The context block for one generation chunk.
 *
 * @param {object} args
 * @param {string[]} args.plannedFiles   every file this generation will produce (the WHOLE list, always shown as a tree)
 * @param {Array<{path: string, content?: string, action?: string}>} args.writtenSoFar
 *        operations already produced by earlier chunks — the files this chunk must agree with
 * @param {string[]} [args.chunk]        the files THIS call is asked to write
 * @param {string} [args.planBlock]      the plan, as text
 * @param {string} [args.frontendBlock]  the app's own code, so the API matches what the app calls
 * @param {number} [args.maxBytes]
 * @returns {{ text: string, shown: string[], truncated: boolean }}
 */
export function buildBackendChunkContext({
  plannedFiles = [],
  writtenSoFar = [],
  chunk = [],
  planBlock = '',
  frontendBlock = '',
  maxBytes = BACKEND_CONTEXT_MAX_BYTES,
}) {
  const planned = plannedFiles.map(normalizeBackendPath).filter(Boolean);
  const chunkPaths = chunk.map(normalizeBackendPath).filter(Boolean);

  // Last write wins, exactly as a filesystem would behave — and keyed on the NORMALISED path, so a file
  // named both ways is one entry rather than two.
  const byPath = new Map();
  for (const op of writtenSoFar || []) {
    if (!op || typeof op.path !== 'string') continue;
    const key = normalizeBackendPath(op.path);
    if (!key) continue;
    if (op.action === 'delete') { byPath.delete(key); continue; }
    byPath.set(key, { path: key, content: typeof op.content === 'string' ? op.content : '' });
  }

  const sections = [];
  let used = 0;
  let truncated = false;
  const shown = [];

  const add = (label, body) => {
    if (!body) return;
    if (used + body.length > maxBytes) { truncated = true; return; }
    sections.push(body);
    shown.push(label);
    used += body.length;
  };

  // 1. The plan, and the app's own code — the requirement, which is what the backend exists to serve.
  //
  // RENDERED AS TEXT, NEVER AS JSON. This is the fix for a defect this very file introduced: the first
  // version put the plan in as `JSON.stringify(plan, null, 2)` while the call asks for a JSON object back,
  // and the model PARROTTED the first JSON block it could see — returning `{"type":"object",
  // "properties":{...}}`, i.e. the schema, instead of any file. Measured by A/B on one real call:
  //
  //   with the plan as JSON   -> fileOperations NOT AN ARRAY, keys "type,properties"
  //   with the plan as text   -> fileOperations = 2
  //
  // ABI.js already documents this failure mode for role-less calls ("it silently takes default_model");
  // the shape trap is the same class. Handing a model an example of the format you want, and also asking
  // it to produce that format, is an invitation to return the example.
  add('plan', planBlock ? renderPlanAsText(planBlock) : '');
  add('frontend', frontendBlock ? `THE APP THIS BACKEND SERVES (its calls define the contract):\n${frontendBlock}` : '');

  // 2. THE WHOLE FILE LIST. Always, even when its contents do not fit — this is what stops a chunk
  //    inventing `server/middleware/auth.js` when the list never contained it, and what tells a chunk
  //    that a database module is already somebody else's job.
  if (planned.length > 0) {
    const tree = `FILES THIS BACKEND IS MADE OF (the complete list — do not invent paths outside it):\n${planned.map((p) => `  ${p}`).join('\n')}`;
    sections.unshift(tree); // unshift: the list is short, and it must never be the thing dropped
    used += tree.length;
    shown.push('tree');
  }

  // 3. Every file an EARLIER chunk already wrote, in full. This is the property the pipeline has and the
  //    backend generator was missing: the module a later file must import is shown to it, verbatim. The
  //    chunk's own files are excluded — asking the model to agree with content it has not written yet is
  //    how you get an echo instead of an implementation.
  const prior = [];
  for (const [path, file] of byPath) {
    if (chunkPaths.includes(path)) continue;
    prior.push(file);
  }
  prior.sort((a, b) => a.path.localeCompare(b.path)); // stable, so the same input gives the same prompt
  if (prior.length > 0) {
    const body = `ALREADY WRITTEN BY EARLIER STEPS OF THIS SAME BACKEND — import and call these exactly as they are defined here, do not restate them and do not invent a different shape:\n${prior
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n')}`;
    add('written', body);
  }

  return { text: sections.join('\n\n'), shown, truncated };
}
