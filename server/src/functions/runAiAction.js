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
    maxTokens: 1200,
  });

  const mappings = Array.isArray(result.mappings) ? result.mappings : [];
  return { mappings: mappings.filter((m) => m && typeof m.column === 'string' && typeof m.label === 'string') };
}

const TASKS = { schema_mapping: schemaMapping };

export default async function handler({ user, body }) {
  const { task } = body || {};
  const run = TASKS[task];
  if (!run) throw Object.assign(new Error(`Unknown task "${task}". Supported: ${Object.keys(TASKS).join(', ')}`), { status: 400 });
  return run(user.id, body || {});
}
