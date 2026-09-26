// "Does that column exist?" is decidable for the explicit case, and must not rest on a model.
//
// THE CASE THAT MOTIVATED IT (mutation test, 2026-09-26): a helper reading `row.tokens` on a
// model whose fields are `input_tokens` / `output_tokens` was approved by a narrowed reviewer
// that had no schema at all. The reviewer now carries a field index and catches it — but the
// reviewer is a model, and this class is a runtime failure that reaches a user. `esbuild`
// cannot see it, lint cannot, and the import guards check imports.
//
// SCOPE — deliberately the EXPLICIT case only:
//
//     prisma.usageEvent.create({ data: { tokens: 1 } })       // caught
//     prisma.project.findMany({ where: { ownder_id: id } })   // caught
//     export function f(row) { return row.tokens; }           // NOT caught, by design
//
// An untyped row gives a script nothing to resolve against; that genuinely needs the reviewer,
// which is why the review context carries a field index. Chasing it here would mean guessing.
//
// CONSERVATIVE BY CONSTRUCTION: anything unparseable is skipped. A missed check costs nothing;
// a false "that column does not exist" blocks good code, and a gate that cries wolf gets
// switched off. While writing this, two apparent false positives turned out to be my own
// fixtures — `Project` really has no `title`, and its relation is `owner`, not `user`.
//
// Dependency-free. Run:  node scripts/verify-prisma-fields.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unknownPrismaFields, describeUnknownPrismaFields, modelFields, isCodePath } from '../server/src/lib/prismaFields.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const code = (p) => readFileSync(join(REPO, p), 'utf8').replace(/^[ \t]*\/\/.*$/gm, ' ');

const schema = readFileSync(join(REPO, 'server/prisma/schema.prisma'), 'utf8');
const fields = (src) => unknownPrismaFields(schema, src);
const names = (src) => fields(src).map((f) => f.field);

check('the schema parses into models with fields',
  modelFields(schema).byModel.size > 40 && modelFields(schema).byModel.get('UsageEvent')?.has('input_tokens'));

// ── It must catch a column that does not exist ───────────────────────────────────────
check('a column the model does not have, in `data`, is caught',
  names('await prisma.usageEvent.create({ data: { tokens: 1 } })').includes('tokens'));
check('…and the message names the model, the field and the argument',
  /UsageEvent has no field `tokens` \(used in `data`\)/.test(describeUnknownPrismaFields(fields('await prisma.usageEvent.create({ data: { tokens: 1 } })'))[0] || ''));
check('a typo in `where` is caught',
  names('await prisma.project.findMany({ where: { ownder_id: id } })').includes('ownder_id'));
check('a typo alongside good fields is still caught',
  names('await prisma.usageEvent.create({ data: { created_by_id: u, input_tokens: 1, modle_id: m } })').includes('modle_id'));
check('the camelCase client property is mapped to the model',
  fields('await prisma.usageEvent.create({ data: { tokens: 1 } })')[0]?.model === 'UsageEvent');

// ── It must NOT flag a legitimate claim ──────────────────────────────────────────────
// These field names are taken from the real schema — an earlier version of this file used
// invented ones (`title`, `user`) and the two "false positives" were the fixtures' fault.
check('every real field passes', fields('await prisma.usageEvent.create({ data: { created_by_id: 1, input_tokens: 1, cost_usd: 2, project_id: null } })').length === 0);
check('a relation write passes', fields('await prisma.project.create({ data: { owner: { connect: { id } }, name: "x" } })').length === 0);
check('filter operators pass',
  fields('await prisma.project.findMany({ where: { name: { contains: "a", mode: "insensitive" } } })').length === 0);
check('logical combinators pass',
  fields('await prisma.project.findMany({ where: { OR: [{ name: "a" }], NOT: { status: "x" } } })').length === 0);
check('a nested relation write passes',
  fields('await prisma.project.update({ where: { id }, data: { owner: { update: { email: "x" } } } })').length === 0);
check('an update payload passes',
  fields('await prisma.project.update({ where: { id }, data: { polish_ui: true } })').length === 0);

// ── It must stay silent when it cannot be sure ───────────────────────────────────────
check('a generic row helper is not guessed at', fields('export function f(row) { return row.tokens; }').length === 0);
check('a spread is not treated as a column claim',
  fields('await prisma.project.create({ data: { ...row, name: "x" } })').length === 0);
check('a non-model client property is skipped',
  fields('await prisma.notAModel.findMany({ where: { nope: 1 } })').length === 0);
check('unbalanced parentheses are skipped rather than guessed',
  fields('await prisma.usageEvent.create({ data: { tokens: 1 }').length === 0);
check('a file with no prisma call is free', fields('const x = 1;\n').length === 0);
check('an empty schema yields nothing rather than throwing',
  unknownPrismaFields('', 'await prisma.usageEvent.create({ data: { tokens: 1 } })').length === 0);

// ── Prose is not a claim ─────────────────────────────────────────────────────────────
// Until 2026-09-26 the opener regex ran against the raw source, so a commented-out example or
// one quoted inside a string was read as live code. Measured on the real function: both shapes
// reported "UsageEvent has no field `tokens`" in red and froze the feature step. The 24 checks
// above all passed while that was true, because none of them contained prose — which is why
// these exist, and why the property "it must never flag a field the schema has" is asserted
// against the inputs that used to break it rather than only the ones that never did.
check('a commented-out prisma call is not a claim',
  fields('// await prisma.usageEvent.create({ data: { tokens: 1 } })').length === 0);
check('a prisma call inside a block comment is not a claim',
  fields('/*\n * await prisma.usageEvent.create({ data: { tokens: 1 } })\n */').length === 0);
check('a prisma call inside a string literal is not a claim',
  fields('const doc = "await prisma.usageEvent.create({ data: { tokens: 1 } })";').length === 0);
check('a prisma call inside a template literal is not a claim',
  fields('const doc = `await prisma.usageEvent.create({ data: { tokens: 1 } })`;').length === 0);
// The dangerous half of blanking prose: it must not swallow the REAL call that follows it.
// `callArgs` walks character indices, so a blanking that changed length would shift every match.
check('blanking prose does not shift the real call that follows it',
  names('// e.g. prisma.usageEvent.create({ data: { tokens: 1 } })\nawait prisma.project.create({ data: { nope: 1 } })').join(',') === 'nope');
check('…nor one that follows a string literal',
  names('const s = "prisma.usageEvent.create({ data: { tokens: 1 } })";\nawait prisma.project.create({ data: { nope: 1 } })').join(',') === 'nope');

// ── Only a file that could be executed is checked ────────────────────────────────────
// The path filter lives in the module so it can be tested here rather than asserted as a
// regex on the call site. A `.md`/`.sql`/`.json` file containing a Prisma example is not a
// defect, and an unrecognised extension is skipped — a missed check, never a false one.
check('a code path is checked',
  isCodePath('server/src/x.js') && isCodePath('a.jsx') && isCodePath('b.mjs') && isCodePath('c.cjs') && isCodePath('d.ts') && isCodePath('e.tsx') && isCodePath('UPPER.JS'));
check('a prose or data file is not',
  !isCodePath('README.md') && !isCodePath('migration.sql') && !isCodePath('package.json'));
check('an unknown or empty path is skipped rather than guessed',
  !isCodePath('Makefile') && !isCodePath('') && !isCodePath(undefined));

// ── One parser, two consumers ───────────────────────────────────────────────────────
check('the reviewer context uses this same field parser',
  code('server/src/lib/reviewContext.js').includes("from './prismaFields.js'"));
check('…and no longer keeps its own copy',
  !/export function modelFieldIndex/.test(code('server/src/lib/reviewContext.js')));

// ── Wiring: an exact check nobody calls is not a gate ───────────────────────────────
const chat = code('server/src/functions/chatWithMorpheus.js');
check('chatWithMorpheus runs the schema check', /unknownPrismaFields\(/.test(chat));
check('…and imports it', /from '\.\.\/lib\/prismaFields\.js'/.test(chat));
check('…and imports the path filter it applies',
  /import\s*\{[^}]*\bisCodePath\b[^}]*\}\s*from\s*'\.\.\/lib\/prismaFields\.js'/.test(chat));
check('…and applies it to every file the gate inspects', /isCodePath\(op\.path\)/.test(chat));
// The schema gate runs ONCE and reports — it has no fix loop. Folding its finding into
// `syntaxCritical` told the user an unknown column was "a syntax error after 2 fix attempts":
// the wrong error, and an attempt count that never happened.
check('the schema finding is reported as its own kind, not folded into syntax errors',
  /schemaCritical = \[\.\.\.schemaCritical/.test(chat));
check('…and the syntax-error sentence is built from syntaxCritical alone',
  /syntax error after \$\{MAX_GATE_ATTEMPTS - 1\} fix attempts — \$\{syntaxCritical\.join/.test(chat));
check('…from the real schema in the project, not a bundled copy',
  /schema\.prisma/.test(chat) && !/model UsageEvent/.test(chat));
// The whole point: this must not sit inside the self-dev-only deep-verify gate.
const deepGateAt = chat.indexOf('if (isSelfDev && fileOps.length > 0)');
const checkAt = chat.indexOf('unknownPrismaFields(');
check('the check runs for every build, not only self-dev',
  deepGateAt > -1 && checkAt > -1 && Math.abs(checkAt - deepGateAt) > 40,
  `deepGate@${deepGateAt} check@${checkAt}`);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA column that does not exist fails at runtime and no other gate can see it.');
  console.log('Keep this exact and conservative: it must never flag a field the schema has,');
  console.log('because a gate that cries wolf gets switched off.\n');
  process.exit(1);
}
console.log('a proposed change naming a column that does not exist is caught by a script.\n');
