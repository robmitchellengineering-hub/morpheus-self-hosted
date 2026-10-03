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
  ['server/src/functions/chatWithJarvis.js', 'SNAPSHOT_NEED_SCHEMA', "the deck's snapshot-need gate (asked on EVERY message, 2026-10-03)"],
  ['server/src/functions/classifyDeckDumpItem.js', 'CLASSIFY_SCHEMA', 'the brain-dump classifier'],
  ['server/src/functions/syncDeckGmailInbox.js', 'CLASSIFY_SCHEMA', 'the Gmail inquiry check'],
  ['server/src/functions/classifyAppKind.js', 'APP_KIND_SCHEMA', 'the website/web-app on-ramp decision'],
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

// Same reason, same floor. This one runs on the website on-ramp, where a truncated schema call THROWS
// — so a tight budget would not shorten the answer, it would fail the page on a sentence.
// The app-facing AI capability: a generated app spending its OPERATOR's credits. It is the only AI
// call site a third party can trigger, so the role and the budget matter more here than anywhere else.
const aiRoute = code('server/src/routes/appCapability.routes.js');
check('the app AI capability names a role rather than taking the default',
  /role: 'draft'/.test(aiRoute));
const aiCapBudget = Number((aiRoute.match(/AI_MAX_TOKENS = (\d+)/) || [])[1] || 0);
check('…with a budget above the 1200 the classify role truncated at',
  aiCapBudget >= 1200, `found AI_MAX_TOKENS = ${aiCapBudget || '(none)'}`);
check('…and the prompt is bounded before it reaches a model',
  /AI_PROMPT_MAX_CHARS = \d+/.test(aiRoute));

const appKindBudget = Number((code('server/src/functions/classifyAppKind.js').match(/maxTokens:\s*(\d+)/) || [])[1] || 0);
check('the on-ramp decision has a budget above the 1200 the classify role truncated at',
  appKindBudget >= 2000, `found maxTokens: ${appKindBudget || '(none)'}`);

const synth = code('server/src/functions/runJarvisSynthesis.js');
const schedBudget = Number((synth.match(/MAX_SCHEDULED_TOKENS\s*=\s*(\d+)/) || [])[1] || 0);
check('the scheduled deck insight has a budget above the 6000 it failed at four times in a week',
  schedBudget >= 12000 && /maxTokens:\s*MAX_SCHEDULED_TOKENS/.test(synth), `found ${schedBudget || '(none)'}`);
check('…and the conversational reply keeps its own, so the two cannot silently share a ceiling again',
  /MAX_REPLY_TOKENS\s*=\s*6000/.test(synth) && /maxTokens:\s*MAX_REPLY_TOKENS/.test(synth));

// ── the reply prompt must stay attributable ─────────────────────────────────
// The cost audit found two replies at ~15.6k input tokens — 45% of all audited reply input —
// that no code path or table explains, and they are unattributable after the fact. The line
// below is what will explain the next one; its contract is that it logs LENGTHS, never the
// operator's own words.
const chatSized = code('server/src/functions/chatWithJarvis.js');
const compositionLog = (chatSized.match(/`\[chatWithJarvis\] reply prompt chars[\s\S]*?`/) || [''])[0];
check('the reply prompt logs its composition', compositionLog.length > 0);
const logged = [...compositionLog.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
check('…and every value it logs is a length, never prompt content',
  logged.length >= 5 && logged.every((e) => /\.length\b/.test(e)));

// ── the two prose calls that inherited the default by accident ───────────────
// Both generate text rather than classify it, and both named no role — so they took
// default_model (v4-pro) @ 0.7 and nothing recorded the choice. The `draft` role makes
// that a decision: flash @ 0.4, set in platform_settings and asserted in the workspace's
// expected-settings.json.
const replyDraft = code('server/src/functions/suggestDeckReply.js');
check('the inbox reply draft names the draft role', /role:\s*'draft'/.test(replyDraft));
check('…and keeps a budget a short reply can finish in',
  Number((replyDraft.match(/MAX_REPLY_TOKENS = (\d+)/) || [])[1] || 0) >= 2000);
const docDraft = code('server/src/functions/createDeckDocument.js');
check('the document draft names the draft role', /role:\s*'draft'/.test(docDraft));

// The counterpart, pinned so nobody "finishes the job" by moving them: Jarvis's own voice
// stays on the platform default on purpose — persona and judgement, Rob's call. The manual
// synthesis now names `planner`, which resolves to the SAME pro @ 0.7 the default already
// gave it (runJarvisSynthesis.js explains why), so the persona's model is unchanged and the
// choice is explicit rather than accidental; the scheduled synthesis is still role-less.
//
// 2026-10-03: the reply file now ALSO carries a bounded SHORTENING pass for an over-long reply,
// which is a mechanical prose rewrite and correctly runs on the cheap `draft` role (flash @ 0.4).
// The claim here is about the REPLY, so it is asserted on the reply call itself: the persona
// stays on `planner`, and it is the shortening pass — not the reply — that is drafted.
// scripts/verify-jarvis-reply-length.mjs owns the repair, its budget and its fallback.
check('Jarvis\u2019s reply is deliberately NOT drafted by the draft role — it stays on planner',
  /schema: REPLY_SCHEMA, role: 'planner'/.test(chatSized));
check('…and the reply call never takes the draft role',
  !/schema: REPLY_SCHEMA, role: 'draft'/.test(chatSized));
check('…while the bounded shortening pass is the cheap prose role',
  /schema: REPAIR_SCHEMA,\s*role: 'draft'/.test(chatSized));
check('…and neither is the scheduled synthesis',
  !/role:\s*'draft'/.test(code('server/src/functions/runJarvisSynthesis.js')));

// ── a small AI call must not be able to take its caller down ─────────────────
// The widget-build intent classifier runs on EVERY Jarvis message, before the reply,
// and it is an optimisation — it recognises "build me a widget" and answers with a
// canned acknowledgement. `invokeAI` throws on a timeout, a truncation or a bad
// response; unguarded, that throw left the handler as a 500 and took a perfectly good
// chat turn with it, on top of the user row already persisted. 2026-10-03: it is now
// one of two booleans in a single Promise.all, so the guard is the `.catch()` on the
// call rather than a `try` block — the claim is the same one.
const chatSrc = code('server/src/functions/chatWithJarvis.js');
check('the widget-build intent call is guarded, so a classifier failure cannot kill the reply',
  /classifyWidgetBuildIntent\(user\.id, message\)\.catch\(\(err\) => \{[\s\S]*?return false;/.test(chatSrc));
check('…and the fallback is ordinary chat, not a build',
  /if \(wantsWidgetBuild\)/.test(chatSrc));
// The snapshot gate is the second boolean on that path, and its failure direction is the
// opposite one on purpose: a failed check INCLUDES the snapshot (answer blind vs. spend
// tokens) while attaching NO career briefs (no headroom, and the names are always in the
// persona). scripts/verify-jarvis-snapshot-gate.mjs owns that rule; this only asserts the
// guard is wired here too, so a failure cannot take the turn down.
check('the snapshot-need gate is guarded too, and fails toward INCLUDING the snapshot',
  /classifyTurnContext\(user\.id, message\)\.catch\(\(err\) => \{[\s\S]*?includeSnapshot: true, careers: \[\]/.test(chatSrc));

// An empty 200 used to be stored verbatim: a blank Jarvis bubble with no error, and a
// blank "Suggestions" card — both indistinguishable from "Jarvis had nothing to say".
// This file's own history records the same silent-empty reply once before. 2026-10-03:
// the manual synthesis is now schema-bounded, so the refusal covers a DECLINE as well as
// an empty answer, and it is made by the pure `synthesisMessageToStore` before anything
// reaches the database.
const synthFail = code('server/src/functions/runJarvisSynthesis.js');
check('the chat reply refuses to store an empty reply',
  /if \(!String\(reply \|\| ''\)\.trim\(\)\)/.test(chatSrc));
check('…and the manual synthesis refuses a declined, empty or unusable answer',
  /const decision = synthesisMessageToStore\(\{ result, truncated \}\)/.test(synthFail) && /if \(!decision\.ok\)/.test(synthFail));

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
