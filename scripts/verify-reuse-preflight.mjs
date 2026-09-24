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

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /const reuseSchema = \{/.test(src) && /let reuseBlock = '';/.test(src));
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
  /plannedNew\.length > 0 && files\.length > 0/.test(src));

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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nThe gates check whether new code works, never whether it should exist.');
  console.log('That is what this pre-flight is for — do not quietly remove it.\n');
  process.exit(1);
}
console.log('the plan is checked against the repo before the coder writes.\n');
