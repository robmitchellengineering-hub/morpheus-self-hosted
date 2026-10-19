// Behavioural verification for salvageJson, plus the wiring that makes a truncated classifier
// survivable (2026-09-28).
//
// Dependency-free (imports only the pure module), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-salvage-json.mjs
//
// The failure this exists for, measured: the brain-dump classifier's call on 2026-09-27 ended at
// exactly its 4000-token cap from a 962-token prompt (usage_events: `out=4000`, status ok, 18.98s),
// so `invokeAI` threw OUTPUT_TRUNCATED and the whole dump was filed unsorted instead of being split.
// Recovering the items already written turns that into a partial split the caller can be honest
// about. The tests below are the cases that actually matter: strings containing braces, escapes, and
// a cut that leaves nothing usable.
import { readFileSync } from 'node:fs';
import { salvageJson } from '../server/src/lib/salvageJson.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. it recovers the complete items and nothing invented');
check('a cut mid-object keeps the objects that closed',
  salvageJson('{"items":[{"text":"get milk","destination":"task"},{"text":"call the sup'),
  { value: { items: [{ text: 'get milk', destination: 'task' }] }, truncated: true });
check('a cut inside a string keeps the objects before it',
  salvageJson('{"items":[{"text":"a","destination":"task"},{"text":"b","desti'),
  { value: { items: [{ text: 'a', destination: 'task' }] }, truncated: true });
check('it closes nested containers in the right order',
  salvageJson('{"items":[{"tags":[1,2'), null);
check('…and a deeper nesting that did close is repaired',
  salvageJson('{"items":[{"tags":[1,2]}'),
  { value: { items: [{ tags: [1, 2] }] }, truncated: true });

console.log('\n2. braces and escapes inside strings are data, not structure');
check('a brace inside a string does not end the object early',
  salvageJson('{"items":[{"text":"a } b","destination":"task"},{"text":"tail'),
  { value: { items: [{ text: 'a } b', destination: 'task' }] }, truncated: true });
check('an escaped quote inside a string does not end it',
  salvageJson('{"items":[{"text":"say \\"hi\\"","destination":"task"},{"x'),
  { value: { items: [{ text: 'say "hi"', destination: 'task' }] }, truncated: true });
check('a trailing backslash cannot fake a closed string',
  salvageJson('{"items":[{"text":"abc\\'), null);

console.log('\n3. it refuses rather than guesses');
check('nothing complete to keep', salvageJson('{"items":[{"text":"get mi'), null);
check('not JSON at all', salvageJson('the model said no'), null);
check('mismatched containers', salvageJson('{"items":[}'), null);
check('empty input', salvageJson(''), null);
check('a bare complete object is not "truncated" — callers only use this after a failed parse',
  salvageJson('{"items":[]}'), { value: { items: [] }, truncated: true });

console.log('\n4. the classifier opts in, and only the classifier');
const ai = readFileSync(new URL('../server/src/ai.js', import.meta.url), 'utf8');
const fn = readFileSync(new URL('../server/src/functions/classifyDeckDumpItem.js', import.meta.url), 'utf8');
check('invokeAI takes the opt-in flag',
  /export async function invokeAI\(\{ userId, prompt, schema, fileUrls, role, maxTokens, task, salvagePartial \}\)/.test(ai), true);
// The invariant is order: salvage is attempted, and the throw that protects every OTHER schema
// call is still there after it — so a caller that did not opt in fails exactly as it did before.
check('a truncated schema call is salvaged when asked, and still throws when not',
  /if \(finishReason === 'length' && schema\) \{[\s\S]*?if \(salvagePartial\) \{[\s\S]*?truncated: true \};[\s\S]*?throw new Error\(`OUTPUT_TRUNCATED/.test(ai), true);
check('…and it says the result is partial, so no caller can mistake it for complete',
  /return \{ result: salvaged\.value, provider, model: resolvedModel, usage, truncated: true \};/.test(ai), true);
check('the mid-JSON parse failure gets the same treatment',
  /catch \(parseErr\) \{[\s\S]{0,600}?salvagePartial[\s\S]{0,400}?truncated: true/.test(ai), true);
check('a failed salvage keeps the original error rather than returning junk',
  /if \(salvagePartial\) \{\s*const salvaged = salvageJson\(content\);\s*if \(salvaged\) return \{[^}]*truncated: true \};\s*\}\s*throw new Error\('OUTPUT_TRUNCATED/.test(ai), true);
check('the dump classifier is the call site that opts in',
  /salvagePartial: true/.test(fn), true);
check('…and no other call site does, so a coder still hard-fails on half a file list',
  (ai.match(/salvagePartial: true/g) || []).length, 0);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
