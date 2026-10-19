// Runtime verification for the usage-event observability fields.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-usage-observability.mjs
//
// Why this exists: every audit this project has run hit the same wall — `usage_events` recorded how
// many tokens a call used and nothing else, so a call could not be attributed to a call site, could
// not be timed, and could not be told from a success when it failed. The columns were added on
// 2026-09-27 (`server/prisma/selfdev-usage-event-observability.sql`, applied to production); this
// file asserts that they are actually WRITTEN.
//
// Both halves are instrumented now: the success path records status 'ok' with the duration, and the
// provider round trip's own catch records status 'error' with the duration before rethrowing — so an
// AI call that fails is visible in the data instead of leaving no trace at all.
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// Comments masked: the comments explaining this quote the field names.
const raw = readFileSync(new URL('../server/src/ai.js', import.meta.url), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

console.log('\n1. the write carries the new fields');
check('the recorder accepts a task and a duration',
  /async function recordUsageEvent\(\{[^}]*\btask\b[^}]*\bdurationMs\b[^}]*\}\)/.test(code), true);
check('the row records the task', /task: task \|\| null,/.test(code), true);
// (the status assertion lives in section 3, with the failure path it has to agree with)
check('the row records the duration, guarded against a non-number',
  /duration_ms: Number\.isFinite\(durationMs\) \? durationMs : null,/.test(code), true);

console.log('\n2. the timing is real, and reaches the recorder');
check('the call is timed from its first line',
  /export async function invokeAI\(\{[^}]*\}\) \{\s*(?:\/\/[^\n]*\n\s*)*const startedAt = Date\.now\(\);/.test(code), true);
// The signature gained `salvagePartial` on 2026-09-28 (a truncated LIST is not a truncated answer);
// what this check is for is the `task` label, so it asserts the tail of the list rather than
// freezing it — a new optional argument is not the failure it exists to catch.
check('invokeAI accepts an optional task label',
  /export async function invokeAI\(\{ userId, prompt, schema, fileUrls, role, maxTokens, task(?:, \w+)* \}\)/.test(code), true);
check('the success path passes both, measured not estimated',
  /recordUsageEvent\(\{ userId, role, provider, model: resolvedModel, usage, isExempt, reservedCredits, task, durationMs: Date\.now\(\) - startedAt \}\)/.test(code), true);
check('the recorder is still fire-and-forget, so metering cannot break a call',
  /recordUsageEvent\(\{[\s\S]{0,200}\}\)\.catch\(\(\) => \{\}\);/.test(code), true);

console.log('\n3. a failed call leaves a record instead of no trace');
check('the recorder takes a status',
  /async function recordUsageEvent\(\{[^}]*\bstatus = 'ok'[^}]*\}\)/.test(code), true);
check('the row stores it, defaulting to ok',
  /status: status === 'error' \? 'error' : 'ok',/.test(code), true);
// `model`, NOT `resolvedModel`. This assertion pinned `model: resolvedModel` and therefore REQUIRED a
// temporal dead zone: `resolvedModel` is declared below, from the response, so in this catch it throws
// "Cannot access 'resolvedModel' before initialization" — and that error replaced the provider's, which is
// the exact opposite of what the next check claims. Found 2026-09-29 by forcing a provider failure in a
// harness: every provider error in the product reported a reference error instead of "AI endpoint error
// (500)". A check can be satisfied by the bug it is meant to prevent.
check('the provider round trip records a failure before rethrowing',
  code.includes('model, isExempt, reservedCredits: 0') && code.includes("status: 'error'"), true);
check('…and it is still fire-and-forget, so it cannot replace the real error',
  /status: 'error', durationMs: Date\.now\(\) - callStartedAt,\s*\}\)\.catch\(\(\) => \{\}\);/.test(code), true);
check('the refund path is untouched above it',
  /reconcileCredits\(userId, reservedCredits, 0\)\.catch\(\(\) => \{\}\);/.test(code), true);

// ── Every call site in the roles that dominate spend is attributable ────────────────────────────────────────
//
// ⚠️ THE COLUMNS EXISTING IS NOT THE SAME AS THEM BEING USED, and that gap was measured: on 2026-10-10, **4,956 of
// 4,983 `usage_events` rows carried no `task` at all** — $192.47 of $192.68, the whole of it. So every cost
// question this project asked had to be answered by inferring from `role` and timestamps, and that inference
// produced a WRONG answer the same day: the reviewer's input tokens looked like they had gone UP 44% after the
// change meant to cut them, because a first-pass review and its retry were one indistinguishable row. They are
// not one row any more, and the count below is what keeps it that way — a presence check would pass on a file
// where one of three call sites was still unlabelled, which is exactly the state being replaced.
// Comments are stripped before matching, the same as `code` above: a check that reads raw source can be satisfied
// by its own explanatory prose, which has caught this repo out more than once today.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const chatSrc = stripComments(readFileSync(new URL('../server/src/functions/chatWithMorpheus.js', import.meta.url), 'utf8'));
const reviewerSrc = stripComments(readFileSync(new URL('../server/src/lib/reviewer.js', import.meta.url), 'utf8'));

const plannerSites = (chatSrc.match(/role: 'planner',/g) || []).length;
const plannerLabelled = (chatSrc.match(/^\s+task: 'plan_(build|context)'/gm) || []).length
  + (chatSrc.match(/^\s+task: 'research_repo'/gm) || []).length;
check(`every planner call site carries a task label (${plannerLabelled}/${plannerSites})`, plannerLabelled, plannerSites);
// The three are genuinely different jobs with very different output sizes, so they must be told apart.
for (const label of ['plan_build', 'plan_context', 'research_repo']) {
  check(`…and ${label} is one of them`, new RegExp(`task: '${label}',`).test(chatSrc), true);
}
check('the build planner is not the context planner', /task: 'plan_build',/.test(chatSrc) && /task: 'plan_context',/.test(chatSrc), true);

const reviewerSites = (reviewerSrc.match(/role: 'reviewer',/g) || []).length;
check(`every reviewer call site carries a task label (${(reviewerSrc.match(/^\s+task: stageName,/gm) || []).length}/${reviewerSites})`,
  (reviewerSrc.match(/^\s+task: stageName,/gm) || []).length, reviewerSites);
// It must be the STAGE, not a constant: a first pass and a post-fix retry review are the two things the missing
// label made indistinguishable, and `stageName` is what varies between them.
check('…and it is the stage, so a retry review is a different row from a first pass', /task: stageName,/.test(reviewerSrc), true);
// Pinned to the CALL, not to the word: `/retry_reviewer/` alone is satisfied by the stage-label table in
// chatWithMorpheus.js, so the earlier version of this line would have passed even if the re-review never asked for
// its own stage name — the check-caught-by-its-own-prose shape, again.
check('…and the re-review passes its own stage', /stageName: 'retry_reviewer'/.test(reviewerSrc), true);
check('…while the first pass passes the plain one', /stageName: 'reviewer'/.test(reviewerSrc), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
