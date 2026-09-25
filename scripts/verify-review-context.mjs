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
import { buildReviewerContext } from '../server/src/lib/reviewContext.js';

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
