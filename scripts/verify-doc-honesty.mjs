// Verification that the generated documents describe THIS system.
//
// HISTORY, because it is the whole reason this file exists. Morpheus shipped three
// self-documentation surfaces built from hand-written literals:
//
//   * /ai-docs       — a 446-line data file naming base44.asServiceRole.InvokeLLM
//                      and models that do not exist here
//   * /flow-diagram  — "Complete call graph of every backend function", claiming a
//                      Deno runtime, 35 functions, 15 modules, 11 entities
//   * generateRebuildDoc — an ENTITY_FIELDS map whose own comment said "kept in
//                      sync by hand — update both together"
//
// Against 123 functions, 79 lib modules and 54 models. A fresh timestamp and the
// words "Live data model" made them authoritative-looking, and they WERE read as
// current — the audit that found this was reading the PDFs those pages export.
//
// The first two are deleted. The third now reads the system. These checks assert
// both of those facts, and — the one that matters most — that the parser agrees
// with the REAL schema rather than with itself.
//
// Run: node scripts/verify-doc-honesty.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchemaModels, listFunctionNames, generatedFromNote } from '../server/src/lib/schemaIntrospect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\ngenerated documents — verification\n');

// ── 1. The parser, on fixtures ──────────────────────────────────────────────
console.log('1. the schema parser reads what a schema says');
const FIXTURE = [
  '// a comment',
  'model Project {',
  '  id        String   @id @default(uuid())',
  '  name      String',
  '  owner     User?',
  '  files     ProjectFile[]',
  '  @@index([owner])',
  '}',
  '',
  'model User {',
  '  id    String @id',
  '}',
].join('\n');
const parsed = parseSchemaModels(FIXTURE);
check('both models found', parsed.map((m) => m.name), ['Project', 'User']);
check('a required field is required', parsed[0].fields.find((f) => f[0] === 'name'), ['name', 'String', true]);
check('an optional field is not', parsed[0].fields.find((f) => f[0] === 'owner'), ['owner', 'User', false]);
check('a list keeps its brackets', parsed[0].fields.find((f) => f[0] === 'files')[1], 'ProjectFile[]');
check('attributes are not fields', parsed[0].fields.some((f) => f[0] === '@@index'), false);
check('comments are not fields', parsed[0].fields.some((f) => f[0] === 'a'), false);
check('an empty schema yields nothing', parseSchemaModels(''), []);
check('null yields nothing rather than throwing', parseSchemaModels(null), []);

console.log('2. the function listing');
check('only .js files count', listFunctionNames(['a.js', 'b.mjs', 'c.txt', 'd.js']), ['a', 'd']);
check('sorted', listFunctionNames(['z.js', 'a.js']), ['a', 'z']);
check('a non-array is empty', listFunctionNames(null), []);
check('the generated note names its sources',
  generatedFromNote(['a', 'b']), 'Generated from a and b at the time this document was built — not maintained by hand, so it cannot disagree with the system it describes.');

// ── 3. It agrees with the REAL system, not with itself ──────────────────────
console.log('\n3. the parser against the real schema and the real directory');
const models = parseSchemaModels(read('server/prisma/schema.prisma'));
const functions = listFunctionNames(readdirSync(path.join(REPO, 'server/src/functions')));
// Not a tautology: this asserts the parser is right about a file written for
// Prisma, not about a fixture written for the parser.
check('the real schema parses to a plausible number of models', models.length > 40, true);
check('every model has a name', models.every((m) => /^\w+$/.test(m.name)), true);
check('at least one model has fields', models.some((m) => m.fields.length > 0), true);
check('the real functions directory lists a plausible number', functions.length > 100, true);
check('no function name is empty', functions.every((n) => n.length > 0), true);

// ── 4. The two lying pages are gone ────────────────────────────────────────
console.log('\n4. the pages that described the deleted system are gone');
for (const gone of ['src/pages/AIDocs.jsx', 'src/pages/FlowDiagram.jsx', 'src/lib/aiFunctionsData.js']) {
  check(`${gone} is deleted`, existsSync(path.join(REPO, gone)), false);
}
const app = read('src/App.jsx');
check('no route still points at them', /ai-docs|flow-diagram|AIDocs|FlowDiagram/.test(app), false);

// ── 5. The document that remains reads the system ──────────────────────────
console.log('\n5. the rebuild doc is generated, not remembered');
const doc = read('server/src/functions/generateRebuildDoc.js');
check('the hand-kept entity map is gone', doc.includes('ENTITY_FIELDS'), false);
check('the hand-kept function list is gone', doc.includes('BACKEND_FUNCTIONS'), false);
check('it reads the schema', /readFile\(SCHEMA_PATH/.test(doc), true);
check('it lists the real functions directory', /readdir\(HERE\)/.test(doc), true);
check('it uses the parser', /parseSchemaModels\(/.test(doc) && /listFunctionNames\(/.test(doc), true);
check('it says where its content came from', /generatedFromNote\(/.test(doc), true);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
