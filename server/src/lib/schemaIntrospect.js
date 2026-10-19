// Reading the shape of this system out of this system.
//
// WHY THIS EXISTS
//
// generateRebuildDoc shipped two hand-maintained mirrors — an ENTITY_FIELDS map
// and a BACKEND_FUNCTIONS array — with a comment admitting the contract they came
// with: "kept in sync by hand — update both together." They were not. The same
// drift produced /ai-docs and /flow-diagram describing a Deno/Base44 stack with 35
// functions against 123 and 11 entities against 54, which is why those two pages
// have now been deleted rather than corrected.
//
// A mirror that has to be maintained by hand is a document that will lie. These
// two parsers read the actual sources — schema.prisma and the functions directory
// — so the generated document cannot disagree with the system it describes. That
// is the same principle as scripts/context.mjs and scripts/reality.mjs, which are
// the reason the drift was provable in the first place.
//
// Pure by design: text in, structure out. No filesystem, no Prisma, so the parsing
// that decides what the document claims is testable with no install.
// See scripts/verify-generated-docs.mjs.

/**
 * Models and their fields, parsed from a Prisma schema.
 *
 * Returns fields as `[name, type, required]` tuples — the shape the existing
 * markdown renderer already takes, so the generated section replaces the
 * hand-written one without a second renderer to drift.
 *
 * Deliberately tolerant: an unparseable line is skipped rather than thrown on,
 * because a document generator that crashes on a schema it half-understands is
 * worse than one that lists slightly fewer fields. Field attributes (`@id`,
 * `@default(...)`), block attributes (`@@index`, `@@map`) and comments are ignored.
 */
export function parseSchemaModels(schemaText) {
  const models = [];
  let current = null;
  for (const raw of String(schemaText ?? '').split('\n')) {
    const line = raw.trim();
    const opens = /^model\s+(\w+)\s*\{/.exec(line);
    if (opens) {
      current = { name: opens[1], fields: [] };
      models.push(current);
      continue;
    }
    if (!current) continue;
    if (line === '}' || line === '') { if (line === '}') current = null; continue; }
    if (line.startsWith('//') || line.startsWith('@@')) continue;
    // name  Type  (with ? or [] for optional/list)
    const field = /^(\w+)\s+([A-Za-z_]\w*(?:\[\])?)(\?)?/.exec(line);
    if (field) current.fields.push([field[1], field[2], !field[3]]);
  }
  return models;
}

/**
 * The function handlers this deployment actually has, from a directory listing.
 *
 * Sorted, `.js` only, extension stripped. The document then lists names that
 * exist; the interface of each is the file's own business rather than a sentence
 * somebody typed once — which is exactly what the hand-written Purpose/Input/Output
 * block used to assert and stop being true.
 */
export function listFunctionNames(fileNames = []) {
  return (Array.isArray(fileNames) ? fileNames : [])
    .filter((f) => typeof f === 'string' && f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** One line naming where the truth lives, for a generated section's header. */
export function generatedFromNote(sources) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  return `Generated from ${list.join(' and ')} at the time this document was built — not maintained by hand, so it cannot disagree with the system it describes.`;
}
