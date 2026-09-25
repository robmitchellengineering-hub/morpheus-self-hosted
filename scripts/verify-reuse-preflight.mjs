// The build turn must check the plan against what already exists before writing.
//
// WHY THIS EXISTS
//
// A plan can name a file to CREATE for a job this repo already does, and nothing in
// the pipeline notices: every gate asks whether the new code works, never whether it
// should exist.
//
// Self-dev did exactly that on 2026-09-24. Asked for a status strip, it wrote a
// backend that bridged to lib/containerMemory.js by GUESSING export names
// (`getContainerMemoryMiB || getContainerMemory || getMemory || default`) and, when
// the guesses missed, reimplemented cgroup parsing itself. The module it wanted was
// right there. Lint, build, all 35 guards and the render check passed — the cost is
// not the wasted file, it is a second copy of a rule that will drift from the first.
//
// The fix mirrors the external-API pre-flight that already sits in the same place:
// verify the plan's claims before the coder writes against them. That one checks
// outward (is this URL real); this one checks inward (does this already exist).
//
// Asserted against COMMENT-MASKED source. The first version of a similar assertion
// earlier today matched its own explanatory comment and proved nothing, so the same
// trap is closed here deliberately.
//
// Dependency-free — it runs in CI's no-install guards job (hazard H4).
//
// Run:  node scripts/verify-reuse-preflight.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reuseMisses } from '../server/src/lib/reuseCheck.js';
import { reuseCandidates } from '../server/src/lib/reusePreflight.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (detail) console.log(`          ${detail}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

const raw = readFileSync(join(REPO, 'server/src/functions/chatWithMorpheus.js'), 'utf8');
// Whole-line `//` comments and /* */ blocks only. A trailing-comment strip would
// corrupt any line containing a URL, and it is the code being asserted, not prose.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

console.log('\nThe plan is checked against what already exists, before the coder writes\n');

// ── the check exists at all ─────────────────────────────────────────────────
// Asserted on the CODE, not on the section comment: comments are masked above, and
// a check that matches its own explanatory prose proves the prose exists.
check('the turn runs an existing-implementation pre-flight',
  /reuseCandidates\(plannedNew, files/.test(src) && /let reuseBlock = '';/.test(src));
check('…and builds a block telling the coder not to reinvent it', /DO NOT REINVENT/.test(src));
check('…and only for files that do NOT exist yet',
  /!files\.some\(\(f\) => f\.path === p\)/.test(src));
check('…and only when the plan actually creates something',
  /const plannedNew = \(Array\.isArray\(plannerResult\.plannedFiles\)/.test(src) && /plannedNew\.length > 0/.test(src));
// This pre-flight runs for every build, not only self-dev, so an empty project must
// short-circuit. With no files at all, every planned path counts as new, and the
// check would spend a model call on the first build of every project to answer
// "nothing exists" — which is true by definition and was already known.
check('…and not at all on an empty project, where there is nothing to reuse',
  /plannedNew\.length > 0 && reuseShortlist\.length > 0/.test(src));
// The shortlist is what fixed the recall failure. Asserted on the code so it cannot
// quietly go back to handing the model the whole tree.
check('…and shows the model a shortlist, not every path in the repo',
  /reuseShortlist = reuseCandidates\(/.test(src) && /buildReusePreflightPrompt\(/.test(src)
  && !/files\.map\(\(f\) => f\.path\)\.join/.test(src));

// ── and it reaches the code that writes ─────────────────────────────────────
// A pre-flight whose answer never reaches the coder is worse than none: it costs a
// model call and changes nothing.
const fullPlanAt = src.indexOf('const coderPrompt = ');
const chunkAt = src.indexOf('const chunkPrompt = ');
check('both coder prompts were found', fullPlanAt > -1 && chunkAt > -1);
check('the full-plan coder prompt carries the finding',
  /\$\{apiCheckBlock\}\$\{reuseBlock\}/.test(src.slice(Math.max(0, fullPlanAt - 200), fullPlanAt + 400)));
check('the chunked coder prompt carries it too',
  /\$\{apiCheckBlock\}\$\{reuseBlock\}/.test(src.slice(Math.max(0, chunkAt - 200), chunkAt + 600)));

// ── ordering: after the outward check, before anything is written ───────────
const preflightAt = src.indexOf('let reuseBlock = ');
const coderInvokeAt = src.indexOf('role: \'coder\'');
check('the pre-flight was found to order', preflightAt > -1 && coderInvokeAt > -1);
check('…it runs before the first coder call', preflightAt < coderInvokeAt);
const apiAt = src.indexOf('api_check');
check('…and after the external-API pre-flight, which is the same idea aimed outward',
  apiAt > -1 && apiAt < preflightAt);

// ── it is best-effort, like the check it sits beside ────────────────────────
// A failed pre-flight must not abort a build; that would turn a hint into a gate
// that can fail for reasons that have nothing to do with the change.
const catchAt = src.indexOf('existing-implementation check failed');
check('a failed pre-flight is logged, not thrown', catchAt > -1);

// ── the advice is checkable, not just given ─────────────────────────────────
// The pre-flight appends "DO NOT REINVENT" and, until 2026-09-25, nothing recorded
// whether it was obeyed: on one identical task the pro and flash coders both
// reported `rework: 0/0/0/0` and both passed every gate, while only one of them
// used the module it had been told to use. lib/reuseCheck.js answers the question
// from the written files, with no model call. Exercised here against the case that
// actually happened — including the detail that makes it hard: the duplicated
// module was named in a COMMENT, so only an import counts as use.

console.log('\nDid the coder import the module the pre-flight named?\n');

const MATCH = [{
  planned: 'server/src/functions/getSelfDevDrift.js',
  existing: 'server/src/lib/selfDevSyncState.js',
  why: 'reads provenance and marks the workspace synced',
}];
const created = (content) => [{ path: MATCH[0].planned, content }];
const hits = (files) => reuseMisses(files, MATCH).length;

check('flags a created file that reimplements the module and only names it in a comment',
  hits(created([
    '// the same job lib/selfDevSyncState.js does, done here instead',
    "import crypto from 'node:crypto';",
    "export const drift = (s) => crypto.createHash('sha1').update(s).digest('hex');",
  ].join('\n'))) === 1);
check('does not flag a created file that imports it',
  hits(created("import { readProvenance } from '../lib/selfDevSyncState.js';\nexport const p = readProvenance;")) === 0);
check('counts an aliased import as use',
  hits(created("import { readProvenance } from '@/lib/selfDevSyncState';")) === 0);
check('counts a require() as use',
  hits(created("const { readProvenance } = require('../lib/selfDevSyncState.js');")) === 0);
check('counts a side-effect import as use',
  hits(created("import '../lib/selfDevSyncState.js';")) === 0);
check('does not flag a plan whose new file was never created',
  reuseMisses([{ path: 'server/src/lib/somethingElse.js', content: 'export const x = 1;' }], MATCH).length === 0);
check('nothing to check when the pre-flight named nothing',
  reuseMisses(created('export const x = 1;'), []).length === 0);

// ── and the turn records the answer ─────────────────────────────────────────
// A detector nobody reports is a detector nobody reads. `reuse` rides in the
// `rework` object, which is already on the run record's allow-list.
check('the turn keeps the pre-flight matches', /reuseMatches = matches;/.test(src));
check('…counts the matches the coder ignored', /reuseMissCount = reuseMisses\(/.test(src));
check('…and reports it in the run record', /reuse: reuseMissCount/.test(src));

// ── and the pre-flight itself is not silently broken ────────────────────────
// The role resolves to a reasoning model, so thinking is billed against maxTokens
// too. At 4000 this truncated in production (2026-09-24T23:30:35Z, 2ms before the
// coder started on getSelfDevDrift.js) — and because the catch is best-effort, the
// build carried on with an empty block. That run was then recorded, by a human, as
// "the pre-flight fired and the coder ignored it". It never fired.
check('the pre-flight gives a reasoning model room to finish',
  /role: 'planner',[\s\S]{0,1500}?maxTokens: 8000/.test(src));
check('…and its own outcome is recorded, not just its effect on the coder',
  /reusePreflight = \{ ran: true, failed: false, named: matches\.length, candidates: reuseShortlist\.length \}/.test(src)
  && /reusePreflight = \{ ran: false, failed: true, named: 0, candidates: reuseShortlist\.length \}/.test(src));
check('…and that outcome survives summariseResult into the run record',
  /'reusePreflight'/.test(readFileSync(join(REPO, 'server/src/lib/selfDevRunRules.js'), 'utf8')));

// ── the shortlist actually contains the answer ──────────────────────────────
// This is the check that would have caught the recall failure. The measured case
// (2026-09-25, n=2 per arm, both models): a plan to create
// `server/src/functions/getContainerMemory.js` when `server/src/lib/containerMemory.js`
// already does that job — and the pre-flight, shown 907 bare paths, named nothing 4/4.
// The retriever must put that file in front of the model, with the export that gives
// it away.
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
};
const repoFiles = walk(join(REPO, 'server/src')).map((abs) => ({
  path: abs.slice(REPO.length + 1),
  content: readFileSync(abs, 'utf8'),
}));
const shortlist = reuseCandidates(['server/src/functions/getContainerMemory.js'], repoFiles, { limit: 60 });
const paths = shortlist.map((c) => c.path);
const hit = shortlist.find((c) => c.path === 'server/src/lib/containerMemory.js');

check('the shortlist is a shortlist, not the whole tree',
  shortlist.length > 0 && shortlist.length < repoFiles.length / 4,
  `${shortlist.length} of ${repoFiles.length} file(s)`);
check('…it contains the module that already does the job',
  Boolean(hit), paths.slice(0, 6).join(', '));
check('…and shows the export that gives it away',
  Boolean(hit && hit.symbols.includes('containerMemory')));
check('…and it is short enough to be worth the tokens',
  JSON.stringify(shortlist).length < JSON.stringify(repoFiles.map((f) => f.path)).length,
  `shortlist ${JSON.stringify(shortlist).length} vs paths-only ${JSON.stringify(repoFiles.map((f) => f.path)).length}`);
// A planned file with nothing like it in the repo must not drag in half the tree —
// precision of the retriever is what keeps the prompt honest. The tokens below are
// deliberately absent from this repo (the first version of this check used "widget",
// which is a real repo concept — widgetToken.js, blockWidget — and matched plenty).
check('an unrelated planned file does not match everything',
  reuseCandidates(['src/lib/quuxflux_capybara_thing.jsx'], repoFiles, { limit: 60 }).length <= 5);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nThe gates check whether new code works, never whether it should exist.');
  console.log('That is what this pre-flight is for — do not quietly remove it.\n');
  process.exit(1);
}
console.log('the plan is checked against the repo before the coder writes.\n');
