// A narrow, billed AI endpoint for native/compiled apps connected via
// Morpheus Connect (see lib/deviceToken.js) — deliberately NOT the full
// chatWithMorpheus pipeline (no file operations, no project context, no
// code-editing surface), since this is reachable by an anonymous compiled
// binary. `task` is a discriminator so more action types can be added later
// without a new endpoint or a new device scope.
//
// Bills against req.user (the end user who approved the device connection,
// resolved by auth.js's optionalAuth from the dvc_ token) via the exact
// same invokeAI path every other AI call in this app already goes through —
// no new billing code needed here; role==='admin' and the billing_exempt
// flag (see server/prisma/add-billing-exempt-flag.sql) are both honored
// automatically because this is just another invokeAI({ userId, ... }) call.
import { invokeAI } from '../ai.js';
import { buildReviewPrompt, REVIEW_SCHEMA, REVIEW_STEP_MAX_TOKENS } from '../lib/reviewer.js';

const MAX_COLUMNS = 50;
const MAX_SAMPLE_ROWS = 5;

// schema_mapping: given column headers + a few sample rows, suggest which
// Wikidata property label each column represents. Matches the real,
// currently-shipping request/response contract in the Wikidata Batch
// Uploader's ui/mapping_panel.py (columns + samples as a list of rows of
// stringified values; NOT core/schema_ai.py's slightly different, unused
// sample_rows-of-dicts shape) — verified against that source directly
// before writing this, not assumed. Response shape is the one both that
// app and its existing Gemini fallback (core/gemini_adapter.py) already
// expect: { mappings: [{ column, label }] }.
async function schemaMapping(userId, body) {
  const columns = (Array.isArray(body.columns) ? body.columns : []).map((c) => String(c)).slice(0, MAX_COLUMNS);
  if (columns.length === 0) throw Object.assign(new Error('columns required'), { status: 400 });
  const samples = (Array.isArray(body.samples) ? body.samples : []).slice(0, MAX_SAMPLE_ROWS)
    .map((row) => (Array.isArray(row) ? row : []).slice(0, columns.length).map((v) => (v == null ? '' : String(v))));

  const sampleLines = samples.map((row, i) => `Row ${i + 1}: ${JSON.stringify(row)}`).join('\n');
  const prompt = `You are a Wikidata schema mapping assistant. Given the following dataset column headers and sample rows, suggest for each column the most appropriate Wikidata property label (e.g., "inception", "country", "population"). Use the exact column names as given. If a column does not map to a known Wikidata property, skip it.

Column headers:
${JSON.stringify(columns)}

Sample rows (each row is a list where values correspond to columns order):
${sampleLines || '(no sample rows given)'}`;

  const { result } = await invokeAI({
    userId,
    prompt,
    schema: {
      type: 'object',
      properties: {
        mappings: {
          type: 'array',
          description: 'One entry per column that maps to a real Wikidata property; omit columns with no good match.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Exact column name as given.' },
              label: { type: 'string', description: 'Wikidata property label, e.g. "inception".' },
            },
            required: ['column', 'label'],
          },
        },
      },
      required: ['mappings'],
    },
    role: 'diagnosis',
    // 1200 was too small for the role, not for the answer. The mapping reply is
    // ~100 tokens for eight columns, but `diagnosis` resolves to the deployment's
    // DEFAULT model (deepseek-v4-pro in production, with no per-role override),
    // which is a reasoning model — and reasoning is billed against this same
    // output budget. Every call truncated and returned HTTP 500, so Morpheus
    // Connect's only action did nothing for any app that used it.
    //
    // The budget is for the thinking, so it has to be sized for the thinking. This
    // is still bounded well below the coder's 24000-64000, and the output itself
    // is schema-limited to one small entry per column.
    maxTokens: 8000,
  });

  const mappings = Array.isArray(result.mappings) ? result.mappings : [];
  return { mappings: mappings.filter((m) => m && typeof m.column === 'string' && typeof m.label === 'string') };
}

// review_probe: run the REVIEWER's real prompt over supplied file operations.
//
// Why this exists: the reviewer is 30.6% of production AI spend (1,254 calls,
// 26,138 avg input tokens), so its context is worth shrinking — but the only way
// to get the reviewer to run used to be a full build, which takes minutes, costs
// a planner + coder pass, and cannot inject a KNOWN defect to check the review
// still catches it. This makes the reviewer directly runnable: same prompt
// builder as the pipeline (lib/reviewer.js buildReviewPrompt), same schema, same
// role and budget, so a probe measures the real thing rather than a copy of it.
//
// Deliberately narrow: it reviews file operations and nothing else. It is on the
// `ai_action` scope (server/src/lib/deviceToken.js), the same one that already
// reaches schema_mapping, and it bills against the approving user like every
// other call here.
const PROBE_MAX_OPS = 3;      // matches REVIEW_CHUNK_SIZE — one real reviewer batch
// Sized ABOVE the pipeline's own context budget (SCOPED_MAX_CONTEXT_BYTES, 150000 chars)
// so a probe can reproduce any context the reviewer is really sent. An over-long context is
// REJECTED rather than sliced: truncating it would silently measure a different prompt than
// the one asked about, and a check that cannot run is not a pass.
const PROBE_MAX_CONTEXT = 250000;

async function reviewProbe(userId, body) {
  const ops = (Array.isArray(body.ops) ? body.ops : [])
    .filter((op) => op && typeof op.path === 'string' && op.path)
    .slice(0, PROBE_MAX_OPS)
    .map((op) => ({
      path: op.path,
      content: typeof op.content === 'string' ? op.content : '',
      action: ['create', 'update', 'delete'].includes(op.action) ? op.action : 'create',
    }));
  if (ops.length === 0) throw Object.assign(new Error('ops required (1-3 file operations, each with a path)'), { status: 400 });

  const raw = typeof body.context === 'string' ? body.context : '';
  if (raw.length > PROBE_MAX_CONTEXT) {
    throw Object.assign(new Error(`context is ${raw.length} chars, over the ${PROBE_MAX_CONTEXT} limit — send a whole context, not a truncated one`), { status: 400 });
  }
  const context = raw;
  const plan = typeof body.plan === 'string' ? body.plan : '';

  const { result, model, provider, usage } = await invokeAI({
    userId,
    prompt: buildReviewPrompt({ contextBlock: context, chunk: ops, allOps: ops, plan }),
    schema: REVIEW_SCHEMA,
    fileUrls: undefined,
    role: 'reviewer',
    maxTokens: REVIEW_STEP_MAX_TOKENS,
  });

  return {
    issues: Array.isArray(result.issues) ? result.issues : [],
    summary: result.summary || '',
    approved: result.approved === true,
    model,
    provider,
    // Echoed so a caller can tell a real review from one that ran on an empty
    // context block — the whole point of the probe is to compare contexts.
    contextChars: context.length,
    promptChars: (context.length + ops.reduce((n, o) => n + o.content.length, 0)),
    usage,
  };
}

const TASKS = { schema_mapping: schemaMapping, review_probe: reviewProbe };

export default async function handler({ user, body }) {
  const { task } = body || {};
  const run = TASKS[task];
  if (!run) throw Object.assign(new Error(`Unknown task "${task}". Supported: ${Object.keys(TASKS).join(', ')}`), { status: 400 });
  return run(user.id, body || {});
}
