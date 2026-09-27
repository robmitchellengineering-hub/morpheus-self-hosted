// Small AI calls must name a role, and reasoning-role budgets must be able to finish.
//
// WHY THIS EXISTS
//
// `invokeAI` resolves BOTH the model and the temperature from the `role` argument, so a
// call that names no role is not neutral — it silently takes `default_model` at
// `default_temperature`. On 2026-09-25 that turned out to mean v4-pro (a REASONING model)
// @ 0.7, and three separate problems followed from it:
//
//   1. The Command Deck's widget-build boolean — asked on EVERY message before the reply —
//      was being answered by the expensive model. That is the deck's latency.
//   2. Several small classifiers had each had their `maxTokens` raised, one by one, to
//      outrun `OUTPUT_TRUNCATED`. The caps were treating a symptom: the cause was a
//      reasoning model's thinking being billed against the same budget as the answer.
//   3. `researchWeb` (maxTokens 500) and `researchRepo` (4000) truncated on most build
//      turns, and the pipeline still showed `✓ web` because each call catches and falls
//      back — so builds silently researched less and nothing looked broken.
//
// A reasoning model's thinking is billed against `max_tokens` (see AGENTS.md). A budget too
// small for one is a silent failure, not a tight budget. Naming the role is the fix; raising
// the cap is only ever a symptom.
//
// Assertions are scoped to the function they are about, and whole-line comments are
// stripped first, so a check cannot be satisfied by the comment that explains it.
//
// Dependency-free — runs in CI's no-install guards job.
//
// Run:  node scripts/verify-ai-roles.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Whole-line `//` comments only. Block comments are NOT stripped: a `/*` inside a string
// earlier in a 1900-line file can swallow the code under test when matched non-greedily,
// which is exactly how the first version of this guard failed.
const code = (p) => readFileSync(join(REPO, p), 'utf8').replace(/^[ \t]*\/\/.*$/gm, ' ');

/** One function's source, from its declaration to the next top-level function. */
function fn(src, name) {
  const start = src.indexOf(name);
  if (start < 0) return '';
  const stops = ['\nasync function ', '\nfunction ', '\nconst ']
    .map((s) => src.indexOf(s, start + name.length))
    .filter((i) => i > 0);
  return src.slice(start, stops.length ? Math.min(...stops) : start + 4000);
}

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { if (detail) console.log(`          ${detail}`); problems.push(name); }
  ok ? pass++ : fail++;
}

console.log('\nSmall AI calls name a role, and reasoning budgets can finish\n');

const cwm = code('server/src/functions/chatWithMorpheus.js');

// ── the build pipeline's two small calls ────────────────────────────────────
const select = fn(cwm, 'async function autoSelectRelevantPaths');
check('the file-shortlist pick names the classify role',
  /role:\s*'classify'/.test(select));
check('…and no longer borrows the coder role for a list of filenames',
  !/role:\s*'coder'/.test(select));

const web = fn(cwm, 'async function researchWeb');
check('the web-search decide call names the classify role',
  /role:\s*'classify'/.test(web));
check('…and no longer asks a reasoning model for a 0-3 item list at 500 tokens',
  !/maxTokens:\s*500\b/.test(web));

const repo = fn(cwm, 'async function researchRepo');
const repoBudget = Number((repo.match(/maxTokens:\s*(\d+)/) || [])[1] || 0);
check('researchRepo — real investigation, deliberately still on planner — has a budget a reasoning model can finish in',
  repoBudget >= 8000, `found maxTokens: ${repoBudget || '(none)'}`);

// ── the three hot-path classifiers outside the pipeline ─────────────────────
const OUTSIDE = [
  ['server/src/functions/chatWithJarvis.js', 'WIDGET_BUILD_INTENT_SCHEMA', "the deck's widget-build intent (asked on EVERY message)"],
  ['server/src/functions/classifyDeckDumpItem.js', 'CLASSIFY_SCHEMA', 'the brain-dump classifier'],
  ['server/src/functions/syncDeckGmailInbox.js', 'CLASSIFY_SCHEMA', 'the Gmail inquiry check'],
];
for (const [file, schema, what] of OUTSIDE) {
  const src = code(file);
  const call = src.slice(src.indexOf(`schema: ${schema}`), src.indexOf(`schema: ${schema}`) + 300);
  check(`${file.split('/').pop()} names the classify role — ${what}`,
    /role:\s*'classify'/.test(call));
}

// ── naming the role is necessary, and it was not sufficient ─────────────────
// The three calls above all name `classify` and still truncated. Measured 2026-09-27:
// of the four `classify` calls in the preceding 14 days, THREE ended at exactly 1200
// output tokens, with `OUTPUT_TRUNCATED (role=classify, maxTokens=1200)` in the
// container log — after the role was named. The role decides WHICH model reasons; it
// does not decide how much room that model gets. So the deck's two truncating calls
// carry a floor here, and the reason is recorded with the number.
const dump = code('server/src/functions/classifyDeckDumpItem.js');
const dumpBudget = Number((dump.match(/maxTokens:\s*(\d+)/) || [])[1] || 0);
check('the brain-dump classifier has a budget above the 1200 it truncated at on 3 of its 4 calls',
  dumpBudget >= 4000, `found maxTokens: ${dumpBudget || '(none)'}`);

const synth = code('server/src/functions/runJarvisSynthesis.js');
const schedBudget = Number((synth.match(/MAX_SCHEDULED_TOKENS\s*=\s*(\d+)/) || [])[1] || 0);
check('the scheduled deck insight has a budget above the 6000 it failed at four times in a week',
  schedBudget >= 12000 && /maxTokens:\s*MAX_SCHEDULED_TOKENS/.test(synth), `found ${schedBudget || '(none)'}`);
check('…and the conversational reply keeps its own, so the two cannot silently share a ceiling again',
  /MAX_REPLY_TOKENS\s*=\s*6000/.test(synth) && /maxTokens:\s*MAX_REPLY_TOKENS/.test(synth));

// ── a small AI call must not be able to take its caller down ─────────────────
// The widget-build intent classifier runs on EVERY Jarvis message, before the reply,
// and it is an optimisation — it recognises "build me a widget" and answers with a
// canned acknowledgement. `invokeAI` throws on a timeout, a truncation or a bad
// response; unguarded, that throw left the handler as a 500 and took a perfectly good
// chat turn with it, on top of the user row already persisted.
const chatSrc = code('server/src/functions/chatWithJarvis.js');
check('the widget-build intent call is guarded, so a classifier failure cannot kill the reply',
  /try\s*\{[^}]*wantsWidgetBuild = await classifyWidgetBuildIntent/s.test(chatSrc));
check('…and the fallback is ordinary chat, not a build',
  /let wantsWidgetBuild = false;/.test(chatSrc) && /if \(wantsWidgetBuild\)/.test(chatSrc));

// An empty 200 used to be stored verbatim: a blank Jarvis bubble with no error, and a
// blank "Suggestions" card — both indistinguishable from "Jarvis had nothing to say".
// This file's own history records the same silent-empty reply once before.
const synthFail = code('server/src/functions/runJarvisSynthesis.js');
check('the chat reply refuses to store an empty reply',
  /if \(!String\(reply \|\| ''\)\.trim\(\)\)/.test(chatSrc));
check('…and so does the manual synthesis',
  /if \(!String\(reply \|\| ''\)\.trim\(\)\)/.test(synthFail));

// NOTE: the `classify` role's settings row (`default_classify_model` / `_temperature`) is
// deliberately NOT asserted here. It lives in the workspace harness, not this repo, and a
// repo guard that reaches outside the checkout would either be skipped in CI — a check that
// cannot run is not a pass — or duplicate the assertion. `check-settings.mjs` already fails
// loudly if any role in `expected-settings.json` has no matching row.

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA call that names no role is not neutral: it takes default_model @');
  console.log('default_temperature, which is a reasoning model, whose thinking is billed');
  console.log('against max_tokens. Name the role — and then give it a budget measured');
  console.log('against what it actually consumes. Naming the role decides which model');
  console.log('reasons, never how much room that model gets: the deck s classify call was');
  console.log('cut off at its cap on 3 of 4 calls AFTER it had been given the role.\n');
  process.exit(1);
}
console.log('small AI calls are role-scoped, and no reasoning-role budget is too small to finish.\n');
