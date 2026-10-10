#!/usr/bin/env node
/**
 * OpenAI-compatible mock provider for the dock rig (server/.env's LLM_BASE_URL
 * points here: http://localhost:4599/v1, model `mock-1`).
 *
 * WHY A MOCK, AND WHY THIS ONE IS SCHEMA-AWARE
 *
 * The dock's CHAT tab calls chatWithMorpheus, which asks invokeAI() for a JSON
 * object matching a schema it embeds in the prompt. A mock that returned a fixed
 * blob would satisfy exactly one caller and silently break every other one, so
 * this reads the schema out of the prompt and synthesises the smallest object
 * that satisfies it. `fileOperations`/`edits` are always empty on purpose: a
 * rig must never write project files by accident.
 *
 * Not a general-purpose fake model. It exists so a browser can drive the dock
 * with zero real model calls and zero cost — see scripts/dev-dock-rig.mjs.
 *
 *   node scripts/dock-rig-mock-llm.mjs        # listens on :4599
 *   MOCK_LLM_PORT=4599 MOCK_LLM_DELAY_MS=0 node scripts/dock-rig-mock-llm.mjs
 *   MOCK_LLM_BUILD=1 node scripts/dock-rig-mock-llm.mjs
 *
 * `MOCK_LLM_BUILD=1` additionally answers the planner and coder schemas with a SCRIPTED BUILD — a real
 * `plannedFiles` list and three independent `lanes`, and coder answers with real file content — so the whole
 * build pipeline (including the concurrent-lane fan-out) can be driven end to end, in a browser or from
 * `scripts/rig-build-check.mjs`. Off unless asked for; see the BUILD section below.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 4599);
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS || 0);
const MODEL = process.env.MOCK_LLM_MODEL || 'mock-1';

// Deliberately loud and unique: the browser assertions in the rig search for
// this exact string, so "the model answered" cannot be confused with a cached
// render or a placeholder.
const MOCK_REPLY = process.env.MOCK_LLM_REPLY ||
  '[dock-rig mock-ai] The widget token reached chatWithMorpheus and the reply came back through the dock.';

const SCHEMA_MARKER = 'matching this exact schema:';
// Arrays whose contents would cause writes or long pipelines if the mock
// invented an item. Empty is always the safe answer.
const NEVER_INVENT = new Set(['fileOperations', 'edits', 'toolCalls']);

// ── OPT-IN BUILD SCENARIO ───────────────────────────────────────────────────────────────────────────────────
//
// The default mock is non-writing ON PURPOSE ("a rig must never write project files by accident"), which is also
// why it cannot exercise the build pipeline: `needsCode` synthesises to `false` and `fileOperations` to `[]`, so
// every turn is conversation and the coder stage never runs.
//
// `MOCK_LLM_BUILD=1` turns on a scripted build — a planner answer with real `plannedFiles` and three genuinely
// independent `lanes`, and coder answers with real file content — so the fan-out can be driven end to end in a
// browser. It stays OFF unless asked for, and the writes land in the rig's own database (`morpheus_dock_rig`),
// which exists to be thrown away.
const BUILD = process.env.MOCK_LLM_BUILD === '1';
const BUILD_LANES = [
  { name: 'data layer', files: ['rigdata.js', 'rigschema.js'] },
  { name: 'list view', files: ['riglist.js', 'rigdetail.js'] },
  { name: 'shell', files: ['rigapp.jsx', 'rigstyle.css'] },
];
const BUILD_FILES = BUILD_LANES.flatMap((l) => l.files);

/**
 * The scripted answer for the two schemas a build actually needs, or null to fall through to `synthesise`.
 * Keyed on the schema's own properties, so it cannot fire for a caller that is not the planner or the coder.
 */
function buildScenario(schema, prompt) {
  if (!BUILD || !schema?.properties) return null;
  const props = schema.properties;

  if (props.needsCode && props.plannedFiles) {
    const out = synthesise(schema, 'root', true);
    out.needsCode = true;
    out.needsClarification = false;
    out.reply = MOCK_REPLY;
    out.plan = 'Rig build scenario: three independent pieces — a data layer, a list/detail view, and the shell.';
    out.plannedFiles = BUILD_FILES.slice();
    out.lanes = BUILD_LANES.map((l) => ({ name: l.name, files: l.files.slice() }));
    out.decisionSummary = 'Rig build scenario';
    return out;
  }

  if (props.fileOperations) {
    // Which files is THIS step asked for? Chunked steps say "these file(s)", the truncation retry says "this
    // file". Matching lazily up to ". Return fileOperations" survives the dot inside "db.js".
    const many = /implement ONLY these file\(s\): (.+?)\. Return fileOperations/s.exec(prompt);
    const one = /implement ONLY this file: (.+?)\. Return fileOperations/s.exec(prompt);
    const raw = many ? many[1] : one ? one[1] : '';
    const paths = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      fileOperations: paths.map((p) => ({
        path: p,
        action: 'create',
        content: p.endsWith('.css')
          ? `/* dock-rig build scenario */\n.rig { color: #0f0; }\n`
          : p.endsWith('.jsx')
            ? `// dock-rig build scenario\nexport default function Rig() { return null; }\n`
            : `// dock-rig build scenario\nexport const id = ${JSON.stringify(p)};\n`,
      })),
    };
  }

  return null;
}

/** The JSON object that follows `marker`, brace-matched so nested schemas work. */
function jsonAfter(text, marker) {
  const at = text.lastIndexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const emptyFor = (schema) => {
  const t = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (t === 'boolean') return false;
  if (t === 'number' || t === 'integer') return 0;
  if (t === 'array') return [];
  if (t === 'object') return {};
  if (t === 'null') return null;
  return '';
};

/** The smallest value that satisfies `schema`; safe (no writes) by construction. */
function synthesise(schema, key, required) {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return synthesise(schema.oneOf[0], key, required);
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (t === 'object') {
    const out = {};
    const req = new Set(schema.required || []);
    for (const [k, v] of Object.entries(schema.properties || {})) {
      if (k === 'reply') { out[k] = MOCK_REPLY; continue; }
      if (!req.has(k)) { out[k] = NEVER_INVENT.has(k) ? [] : emptyFor(v); continue; }
      out[k] = NEVER_INVENT.has(k) ? [] : synthesise(v, k, true);
    }
    return out;
  }
  if (t === 'array') {
    if (!required || NEVER_INVENT.has(key)) return [];
    const items = schema.items;
    if (items && (items.type === 'object' || items.properties)) return [synthesise(items, key, true)];
    if (items && Array.isArray(items.enum) && items.enum.length) return [items.enum[0]];
    return [];
  }
  if (key === 'reply') return MOCK_REPLY;
  if (t === 'string') return schema.description ? `mock ${key}` : 'mock';
  if (t === 'number' || t === 'integer') return 0;
  if (t === 'boolean') return false;
  return null;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  return '';
};

function completionFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const prompt = messages.map((m) => textOf(m?.content)).join('\n');
  const schema = jsonAfter(prompt, SCHEMA_MARKER);
  const wantsJson = body?.response_format?.type === 'json_object' || !!schema;
  // The scripted build answer, when it applies, wins over the safe synthesis — see MOCK_LLM_BUILD above.
  const scripted = buildScenario(schema, prompt);
  const content = scripted
    ? JSON.stringify(scripted)
    : schema
      ? JSON.stringify(synthesise(schema, 'root', true))
      : wantsJson
        ? JSON.stringify({ reply: MOCK_REPLY })
        : MOCK_REPLY;
  const promptTokens = Math.max(1, Math.round(prompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

let calls = 0;
createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'dock-rig' }] });
  }
  if (!path.endsWith('/chat/completions')) return json(res, 404, { error: { message: `mock-llm: no route for ${req.method} ${path}` } });

  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* fall through to an empty body */ }
    const payload = completionFor(body);
    const schema = jsonAfter(textOf(body?.messages?.[0]?.content), SCHEMA_MARKER);
    calls += 1;
    console.log(`[mock-llm] call #${calls} model=${body?.model || '(none)'} schema=${schema ? 'yes' : 'no'} stream=${!!body?.stream} -> ${payload.usage.total_tokens} tokens`);
    const send = () => json(res, 200, payload);
    if (DELAY_MS > 0) setTimeout(send, DELAY_MS);
    else send();
  });
}).listen(PORT, () => console.log(`[mock-llm] OpenAI-compatible mock on http://localhost:${PORT}/v1 (model ${MODEL}, delay ${DELAY_MS}ms)`));
