// The reviewer gets a reviewer's context, not the Coder's — and the reviewer can be run
// directly, so "it still catches things" is testable instead of assumed.
//
// WHY THIS EXISTS
//
// 30-day production usage (`usage_events`): the reviewer is 1,254 calls averaging **26,138
// input tokens**, all deepseek-v4-pro, **30.6% of all AI spend** — the largest single line
// item in the product. Almost none of it was the change under review. `REVIEW_CHUNK_SIZE`
// caps the files under review at 3; the shared block it was handed instead carried the whole
// repo tree (984 paths in self-dev, ~8.7k tokens — and `buildScopedFilesContext` never counts
// the tree against its byte budget, it charges `f.content.length` only) plus every
// orientation file: schema.prisma ~15.1k tokens, README ~2.8k, App.jsx ~3.1k.
//
// The Coder needs that breadth; it has to decide what to write and what to reuse. The
// reviewer does not. It has the operations in front of it and four questions — house rules,
// known hazards, caller impact (appended at the call site), and does this import resolve.
//
// This guard asserts the composition of the new block directly (it is pure, so it can be),
// and asserts the wiring, because a context change that silently stops being applied is
// exactly the class of failure this whole file is about.
//
// Dependency-free and offline — runs in CI's no-install guards job.
//
// Run:  node scripts/verify-review-context.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewerContext, referencedModels } from '../server/src/lib/reviewContext.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Whole-line `//` comments only (see verify-ai-roles.mjs for why block comments are not
// stripped: a `/*` inside a string earlier in a large file can swallow the code under test).
const code = (p) => readFileSync(join(REPO, p), 'utf8').replace(/^[ \t]*\/\/.*$/gm, ' ');

// ── A small project: the full tree still fits, so nothing changes for it ──────────────
// Every fixture file carries a unique sentinel in its CONTENT. Assertions match the
// sentinel, never the filename: a path may legitimately appear in the tree listing while
// its content is correctly withheld, and asserting on the name alone conflates the two
// (the first draft of this guard failed on exactly that, for README.md and App.jsx).
const small = [
  { path: 'KNOWN-HAZARDS.md', content: '# Known hazards\n\nSENTINEL_HAZARDS\n' },
  { path: 'AGENTS.md', content: '# House rules\n\nSENTINEL_AGENTS\n' },
  { path: 'README.md', content: 'SENTINEL_README\n' },
  { path: 'src/App.jsx', content: 'SENTINEL_APP\n' },
  { path: 'src/widget.js', content: 'SENTINEL_WIDGET\n' },
];

const opSmall = [{ path: 'src/widget.js', content: 'SENTINEL_WIDGET_V2\n', action: 'update' }];
const smallBlock = buildReviewerContext({ files: small, fileOps: opSmall });

check('includes KNOWN-HAZARDS.md (the reviewer prompt names it)',
  smallBlock.includes('SENTINEL_HAZARDS'), smallBlock.slice(0, 200));
check('includes AGENTS.md (the reviewer prompt names it)',
  smallBlock.includes('SENTINEL_AGENTS'));
check('excludes README content (coder orientation, not review evidence)',
  !smallBlock.includes('SENTINEL_README'));
check('excludes src/App.jsx content (coder orientation, not review evidence)',
  !smallBlock.includes('SENTINEL_APP'));
check('a project whose tree fits still gets the whole tree',
  smallBlock.includes('FULL REPO FILE TREE'));

// ── A self-dev-sized project: the tree must be bounded, not dumped ────────────────────
// Shaped like the real thing: ~907 paths, a 15k-token schema, a real hazards file.
const big = [
  { path: 'KNOWN-HAZARDS.md', content: 'SENTINEL_HAZARDS\n' + 'H. a hazard line that has burned us before.\n'.repeat(120) },
  { path: 'AGENTS.md', content: 'SENTINEL_AGENTS\n' + 'A house convention stated once, for all sessions.\n'.repeat(70) },
  { path: 'README.md', content: 'SENTINEL_README\n' + 'R'.repeat(11000) },
  { path: 'src/App.jsx', content: 'SENTINEL_APP\n' + 'x'.repeat(12000) },
  { path: 'server/prisma/schema.prisma', content: 'SENTINEL_SCHEMA\n' + 'model Thing {\n  id String @id\n}\n'.repeat(430) },
  { path: 'server/src/lib/target.js', content: 'SENTINEL_TARGET\n' },
  { path: 'server/src/lib/neighbour.js', content: 'SENTINEL_NEIGHBOUR\n' },
];
// 900 filler paths in unrelated directories, each long enough to matter.
for (let i = 0; i < 900; i++) {
  const dir = `src/features/feature-${String(i % 60).padStart(2, '0')}`;
  big.push({ path: `${dir}/component-${String(i).padStart(3, '0')}.jsx`, content: '// x\n' });
}
const opBig = [{ path: 'server/src/lib/target.js', content: 'SENTINEL_TARGET_V2\n', action: 'update' }];

const bigBlock = buildReviewerContext({ files: big, fileOps: opBig });

check('a large tree is bounded rather than dumped',
  bigBlock.includes('too large to include in full'), bigBlock.slice(0, 300));
check('the bounded block says the list is incomplete (so a missing path is not read as proof)',
  bigBlock.includes('may still exist'));
check('the touched directory is still listed in full (that is what answers "does this import resolve")',
  bigBlock.includes('server/src/lib/neighbour.js') && bigBlock.includes('server/src/lib/target.js'));
check('unrelated directories are not dumped',
  !bigBlock.includes('src/features/feature-00/component-000.jsx'));
check('the schema content is withheld for a change that does not touch it',
  !bigBlock.includes('SENTINEL_SCHEMA'));

// The number that matters: the same fixture through the block the reviewer USED to get.
// The orientation list is read from chatWithMorpheus rather than retyped, so this cannot
// quietly compare against a stale copy of the thing that was replaced.
const { buildScopedFilesContext } = await import('../server/src/lib/scopedContext.js');
const orientation = (() => {
  const m = code('server/src/functions/chatWithMorpheus.js').match(/SELF_DEV_ORIENTATION_FILES\s*=\s*(\[[^\]]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/'/g, '"')); } catch { return null; }
})();
check('read the old orientation list from chatWithMorpheus (a check that cannot run is not a pass)',
  Array.isArray(orientation) && orientation.length > 0);

const oldBlock = buildScopedFilesContext(big, ['server/src/lib/target.js'], orientation || [], 150000).text;
const est = (s) => Math.round(s.length / 3.6);
console.log(`       reviewer block ${bigBlock.length} chars (~${est(bigBlock)} tok)`
  + ` vs coder block ${oldBlock.length} chars (~${est(oldBlock)} tok)`);
check('the reviewer block is a fraction of the block it replaced',
  bigBlock.length < oldBlock.length / 2,
  `${bigBlock.length} vs ${oldBlock.length} chars`);
check('the reviewer block stays small in absolute terms',
  bigBlock.length < 24000, `${bigBlock.length} chars`);

const opSchema = [{ path: 'server/prisma/schema.prisma', content: 'SENTINEL_SCHEMA_V2\n', action: 'update' }];
const schemaBlock = buildReviewerContext({ files: big, fileOps: opSchema });
check('the schema IS included when the change touches server/prisma/',
  schemaBlock.includes('SENTINEL_SCHEMA') && schemaBlock.includes('because this change touches'));

// ── IMPORT TARGETS: what a directory index cannot answer ─────────────────────────────
// The mutation test caught this the hard way. With only a directory index the reviewer
// could not tell that a proposed file imported a module that does not exist at all —
// `server/src/lib` was listed as a directory, nothing said what was in it — and it
// approved the broken import, where the full tree had caught it. So the directories a
// change imports FROM are listed in full.
const opImports = [{
  path: 'server/src/functions/spendSummary.js',
  action: 'create',
  content: "import { spendOver } from '../lib/providerSpendState.js';\nimport { nope } from '../lib/doesNotExist.js';\nexport const x = [spendOver, nope];\n",
}];
const importBlock = buildReviewerContext({ files: big, fileOps: opImports });
check('the directory a change imports FROM is listed, not just the one it writes into',
  importBlock.includes('IMPORT TARGETS')
  && importBlock.includes('->  server/src/lib/')
  && importBlock.includes('neighbour.js'),
  importBlock.slice(-400));
// Every import into a directory must survive, not just the first: keying by directory with a
// single specifier dropped the rest — including the missing one this section exists for.
check('EVERY import into a directory is listed, not just the first',
  importBlock.includes("'../lib/providerSpendState.js'")
  && importBlock.includes("'../lib/doesNotExist.js'"), importBlock.slice(-400));
check('an import that resolves to a directory with no such file says so',
  importBlock.includes('doesNotExist.js')
  && importBlock.includes('server/src/lib') , importBlock.slice(-400));
check('a resolving import names its directory',
  importBlock.includes("'../lib/providerSpendState.js'"));

// The prompt tells the reviewer what to do with the section, so it is not just a path dump.
check('the IMPORT TARGETS section tells the reviewer how to use it',
  importBlock.includes('is a CRITICAL issue'));

// ── Do the imported modules' EXPORTS actually get listed? ─────────────────────────────
// The mutation test's `bad-name` fixture was approved by BOTH the old full context and the
// new narrow one: a file importing `ledgerTotals` from a module that exports only
// `spendOver`. Resolving the path is not enough — this is the same bug class that shipped a
// 30-minute production outage on 2026-09-25, and the reviewer is the only check that runs
// BEFORE the code is committed.
const exportsFixture = [
  { path: 'KNOWN-HAZARDS.md', content: 'Sentinel hazards.\n' },
  { path: 'AGENTS.md', content: 'Sentinel agents.\n' },
  { path: 'server/src/lib/state.js', content: "export const DEEPSEEK = 'deepseek';\nexport async function spendOver() {}\nexport function recordBalanceReading() {}\n" },
  { path: 'server/src/lib/legacyThing.cjs', content: 'module.exports = { a: 1 };\n' },
];
const exportsBlock = buildReviewerContext({
  files: exportsFixture,
  fileOps: [{
    path: 'server/src/functions/report.js',
    action: 'create',
    content: "import { spendOver, ledgerTotals } from '../lib/state.js';\nimport { a } from '../lib/legacyThing.cjs';\n",
  }],
});
check('the resolved module path is named',
  exportsBlock.includes('->  server/src/lib/state.js'));
check('the module\'s ACTUAL exports are listed',
  /exports: DEEPSEEK, recordBalanceReading, spendOver/.test(exportsBlock), exportsBlock.slice(-500));
check('a name the module does NOT export is absent from that list (so the reviewer can see it)',
  !/exports: [^\n]*ledgerTotals/.test(exportsBlock));
check('a re-exporting / CommonJS module is marked uncheckable rather than guessed at',
  /CommonJS/.test(exportsBlock), exportsBlock.slice(-300));
check('the section states the link-time consequence, not just "an issue"',
  /LINK time/.test(exportsBlock));

// One parser, two consumers: a pinned copy here would drift from the guard's copy, and the
// two disagreeing about what a module exports is worse than either being wrong alone.
check('the CI import guard uses the same export parser (one definition, two consumers)',
  code('scripts/verify-server-imports.mjs').includes("from '../server/src/lib/moduleExports.js'"));
check('reviewContext uses the shared parser too',
  code('server/src/lib/reviewContext.js').includes("from './moduleExports.js'"));

// ── The Prisma models a change USES, not just the ones it edits ───────────────────────
// This is the regression the mutation test found: the schema was included only when a change
// touched server/prisma/, so a change that merely READ a model got no schema — and the
// reviewer approved a read of `row.tokens` on a model that has input_tokens/output_tokens.
// I had recorded that as a false positive in the arm being retired; it was a true positive.
// No other gate can see it: esbuild, lint and the import guard do not know the schema.
const realSchema = readFileSync(join(REPO, 'server/prisma/schema.prisma'), 'utf8');
const schemaFiles = [
  { path: 'KNOWN-HAZARDS.md', content: 'Sentinel hazards.\n' },
  { path: 'AGENTS.md', content: 'Sentinel agents.\n' },
  { path: 'server/prisma/schema.prisma', content: realSchema },
];
const opReadsModel = [{
  path: 'server/src/lib/recordSpend.js',
  action: 'create',
  content: 'export function recordSpend(userId, cost) {\n  return prisma.usageEvent.create({ data: { created_by_id: userId, cost_usd: cost } });\n}\n',
}];
const modelBlock = buildReviewerContext({ files: schemaFiles, fileOps: opReadsModel });
check('a change that READS a model gets that model\'s definition',
  modelBlock.includes('PRISMA MODELS THIS CHANGE USES') && /model UsageEvent \{/.test(modelBlock),
  modelBlock.slice(0, 200));
check('…including the field the reviewer needs to refute a wrong column',
  /input_tokens/.test(modelBlock) && /created_by_id/.test(modelBlock));
check('…and NOT the other 53 models (the whole schema is ~16.5k tokens)',
  !/model Project \{/.test(modelBlock) && !/model DeviceToken \{/.test(modelBlock));
check('…kept small: the slice is a fraction of the schema, not the whole file',
  modelBlock.length < realSchema.length / 4,
  `${modelBlock.length} vs schema ${realSchema.length}`);
check('the section tells the reviewer a missing column is CRITICAL',
  /does not exist, and using it is a CRITICAL issue/.test(modelBlock));
check('a change that touches nothing schema-shaped gets no model section',
  !buildReviewerContext({ files: schemaFiles, fileOps: [{ path: 'src/thing.js', content: 'export const x = 1;\n' }] })
    .includes('PRISMA MODELS'));
check('the schema is still fully included when the change edits server/prisma/',
  buildReviewerContext({ files: schemaFiles, fileOps: [{ path: 'server/prisma/schema.prisma', content: 'model X {}\n' }] })
    .includes('because this change touches server/prisma/'));

// The guard caught a `.size` on an array here (arrays have .length), which silently skipped
// the whole section and made the check above fail for the right reason.
check('referencedModels returns an array that a caller can count',
  Array.isArray(referencedModels(realSchema, opReadsModel)));

// Small projects still get the whole tree AND the import section.
const smallImports = buildReviewerContext({
  files: small,
  fileOps: [{ path: 'src/new.js', content: "import { widget } from './widget.js';\n", action: 'create' }],
});
check('a small project gets the import targets too (not only the degraded path)',
  smallImports.includes('IMPORT TARGETS') && smallImports.includes('widget.js'));

// ── Wiring: the block must actually be the one the reviewer receives ─────────────────
const chat = code('server/src/functions/chatWithMorpheus.js');
check('chatWithMorpheus builds the reviewer context',
  /let reviewContext = buildReviewerContext\(\{/.test(chat));
check('chatWithMorpheus no longer hands the reviewer the coder context block',
  !/reviewAndRetry\([^)]*contextBlock/.test(chat));
check('the caller-impact block is still appended for the reviewer',
  chat.includes('CALLER IMPACT'));

// ── The probe: one definition of the reviewer prompt, and it is reachable ────────────
const reviewer = code('server/src/lib/reviewer.js');
check('reviewer.js exports the prompt builder', /export function buildReviewPrompt\(/.test(reviewer));
check('reviewFileOperations uses the exported builder (so a probe cannot drift from the pipeline)',
  /prompt: buildReviewPrompt\(\{/.test(reviewer));

const runAi = code('server/src/functions/runAiAction.js');
check('runAiAction exposes review_probe', /review_probe:\s*reviewProbe/.test(runAi));
check('review_probe runs the real reviewer prompt, schema, role and budget',
  /buildReviewPrompt\(\{/.test(runAi)
  && /schema: REVIEW_SCHEMA/.test(runAi)
  && /role: 'reviewer'/.test(runAi)
  && /maxTokens: REVIEW_STEP_MAX_TOKENS/.test(runAi));
// A probe exists to compare contexts. A context longer than the cap must fail loudly, not be
// sliced — a truncated context measures a different prompt than the one being asked about.
check('the probe refuses an over-long context instead of silently truncating it',
  /throw Object\.assign\(new Error\(`context is \$\{raw\.length\} chars/.test(runAi)
  && !/body\.context\.slice\(0, PROBE_MAX_CONTEXT\)/.test(runAi));
check('the probe cap can reproduce any context the pipeline actually sends',
  Number((runAi.match(/PROBE_MAX_CONTEXT = (\d+)/) || [])[1] || 0) > 150000);
check('the review schema is exported so the probe reuses it',
  /export const REVIEW_SCHEMA/.test(reviewer));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nThe reviewer was being handed the Coder\'s whole context: ~26k input tokens a');
  console.log('call, 30.6% of AI spend, for a review of at most 3 files. Keep the rules, the');
  console.log('touched directory and (only when relevant) the schema — and keep the probe,');
  console.log('because a smaller context is a safety change unless something proves it is not.\n');
  process.exit(1);
}
console.log('the reviewer gets a bounded, reviewer-specific context — and stays directly runnable.\n');
