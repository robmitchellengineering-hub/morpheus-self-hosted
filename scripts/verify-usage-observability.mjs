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
// KNOWN GAP, stated rather than pretended: only the success path is instrumented. A call that throws
// before the provider answers still writes no row, so `status: 'error'` never appears yet — that is
// the next change to `invokeAI`'s throw paths, and it is deliberately not faked here.
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
check('the row records success', /status: 'ok',/.test(code), true);
check('the row records the duration, guarded against a non-number',
  /duration_ms: Number\.isFinite\(durationMs\) \? durationMs : null,/.test(code), true);

console.log('\n2. the timing is real, and reaches the recorder');
check('the call is timed from its first line',
  /export async function invokeAI\(\{[^}]*\}\) \{\s*(?:\/\/[^\n]*\n\s*)*const startedAt = Date\.now\(\);/.test(code), true);
check('invokeAI accepts an optional task label', /export async function invokeAI\(\{ userId, prompt, schema, fileUrls, role, maxTokens, task \}\)/.test(code), true);
check('the success path passes both, measured not estimated',
  /recordUsageEvent\(\{ userId, role, provider, model: resolvedModel, usage, isExempt, reservedCredits, task, durationMs: Date\.now\(\) - startedAt \}\)/.test(code), true);
check('the recorder is still fire-and-forget, so metering cannot break a call',
  /recordUsageEvent\(\{[\s\S]{0,200}\}\)\.catch\(\(\) => \{\}\);/.test(code), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
