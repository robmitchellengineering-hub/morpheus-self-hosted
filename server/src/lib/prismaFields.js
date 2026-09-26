// Reading `schema.prisma`, and checking proposed code against it.
//
// WHY THIS EXISTS
//
// "Does that column exist?" is decidable for the common case, and until now only a model
// answered it. The mutation test made the cost concrete: a helper reading `row.tokens` — on a
// model whose fields are `input_tokens` / `output_tokens` — was approved by a narrowed
// reviewer that had no schema at all. The reviewer now carries a field index, which is why it
// catches that; this module is the other half of the answer, for the case where the code
// names the model and the field explicitly:
//
//     prisma.usageEvent.create({ data: { tokens: 1 } })      // no such column
//     prisma.project.findMany({ where: { ownder_id: id } })  // typo, fails at runtime
//
// `esbuild` cannot see this, lint cannot, and the import guards check imports. It is a runtime
// failure that reaches a user.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// Only the EXPLICIT case. `tokensPerDollar(row)` takes an untyped row, so a script cannot know
// which model it came from — that genuinely needs the reviewer, and it is why the review
// context carries a field index. Chasing it here would mean guessing.
//
// It is also CONSERVATIVE BY CONSTRUCTION: anything it cannot parse confidently is skipped.
// A missed check costs nothing; a false "that column does not exist" blocks good code, and a
// gate that cries wolf gets switched off.
//
// Pure by design: no imports, no I/O.

/** Field names per model, in schema order. `Model: a, b, c`. */
export function modelFieldIndex(schemaText) {
  const lines = [];
  for (const m of String(schemaText).matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = m[2]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean);
    lines.push(`${m[1]}: ${fields.join(', ')}`);
  }
  return lines;
}

/** modelName -> Set(fieldName), plus the Prisma client property each model is reached by. */
export function modelFields(schemaText) {
  const byModel = new Map();
  const byClientProp = new Map();
  for (const line of modelFieldIndex(schemaText)) {
    const at = line.indexOf(': ');
    const name = line.slice(0, at);
    byModel.set(name, new Set(line.slice(at + 2).split(', ')));
    byClientProp.set(name.charAt(0).toLowerCase() + name.slice(1), name);
  }
  return { byModel, byClientProp };
}

// Keys that are Prisma syntax rather than columns. Only the filter operators and logical
// combinators that appear INSIDE a where/data object are listed; a relation field is already
// a field of the model and needs no special case.
const PRISMA_KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte',
  'contains', 'startsWith', 'endsWith', 'mode', 'search', 'set', 'push',
  'connect', 'connectOrCreate', 'create', 'createMany', 'disconnect', 'delete',
  'deleteMany', 'update', 'updateMany', 'upsert', 'set', 'some', 'every', 'none',
  'is', 'isNot', 'has', 'hasEvery', 'hasSome', 'isEmpty',
]);

const OPENERS = /prisma\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/** The text inside the call's parentheses, or null if the parens do not balance. */
function callArgs(content, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return content.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/** Top-level keys of the object that follows `data:` or `where:` — [] if it cannot be read. */
function keysOfArgument(args, argName) {
  const at = args.search(new RegExp(`\\b${argName}\\s*:\\s*\\{`));
  if (at === -1) return [];
  const braceAt = args.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = braceAt; i < args.length; i++) {
    if (args[i] === '{') depth++;
    else if (args[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [];
  const body = args.slice(braceAt + 1, end);

  // Split on commas that sit at depth 0 relative to this object.
  const keys = [];
  let d = 0;
  let start = 0;
  const push = (chunk) => {
    const m = chunk.match(/^\s*(?:\.\.\.)?["']?([A-Za-z_$][\w$]*)["']?\s*:/);
    if (!m) return;                       // a spread, a computed key, or not a key at all
    if (/^\s*\.\.\./.test(chunk)) return; // an explicit spread is never a column claim
    keys.push(m[1]);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') d++;
    else if (ch === '}' || ch === ']' || ch === ')') d--;
    else if (ch === ',' && d === 0) { push(body.slice(start, i)); start = i + 1; }
  }
  push(body.slice(start));
  return keys;
}

/**
 * Fields a proposed file uses that the model does not have.
 *
 * @param {string} schemaText        schema.prisma
 * @param {string} content           one proposed file's source
 * @returns {{model: string, field: string, arg: string}[]}
 */
export function unknownPrismaFields(schemaText, content) {
  if (typeof content !== 'string' || !content.includes('prisma.')) return [];
  const { byModel, byClientProp } = modelFields(schemaText);
  if (byModel.size === 0) return [];

  const out = [];
  for (const m of content.matchAll(OPENERS)) {
    const model = byClientProp.get(m[1]);
    if (!model) continue;                 // prisma.$transaction, a client extension, etc.
    const fields = byModel.get(model);
    const args = callArgs(content, m.index + m[0].length - 1);
    if (args === null) continue;          // unbalanced — do not guess
    for (const argName of ['data', 'where']) {
      for (const key of keysOfArgument(args, argName)) {
        if (fields.has(key) || PRISMA_KEYWORDS.has(key)) continue;
        out.push({ model, field: key, arg: argName });
      }
    }
  }
  return out;
}

/** One line per unknown field, in the shape the chat's critical list renders. */
export function describeUnknownPrismaFields(findings) {
  return (findings || []).map((f) =>
    `${f.model} has no field \`${f.field}\` (used in \`${f.arg}\`) — it would fail at runtime`);
}
