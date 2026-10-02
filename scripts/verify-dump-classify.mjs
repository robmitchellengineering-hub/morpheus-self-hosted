// Runtime verification for the brain-dump classifier's pure logic.
//
// Exercises normalizeClassifyResult() / buildClassifyPrompt() against real
// value shapes rather than asserting a syntax check. Dependency-free, so it
// runs in CI's no-install guards job alongside verify-drift.mjs.
// Run:  node scripts/verify-dump-classify.mjs
//
// The load-bearing case is 3: a dictated dump containing several thoughts must
// file each one separately. Before this, the classifier returned a single
// destination and the rest of the sentence was silently entombed in it.
import { readFileSync } from 'node:fs';
import {
  CLASSIFY_SCHEMA, DESTINATIONS, LIFE_STREAM_KEYS, MAX_ITEMS,
  FALLBACK_INCOMPLETE, FALLBACK_NOTHING_CLASSIFIED,
  buildClassifyPrompt, normalizeClassifyResult, patternClassify,
} from '../server/src/lib/deckDumpClassify.js';

// The last section reads two sources rather than only exercising the pure module: the claim it makes
// is about the WIRING around it (a failed call must not reach the pile), and that wiring is where the
// bug actually was.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const DESTINATIONS_OF = (items) => items.map((i) => i.destination);

console.log('\nBrain-dump classifier — runtime verification\n');

console.log('1. a single thought stays a single item');
check('one item, task destination',
  normalizeClassifyResult({ items: [{ text: 'Get milk', destination: 'task' }] }, 'Get milk'),
  [{ text: 'Get milk', destination: 'task', life_stream_key: null, owner_name: null }]);

console.log('\n2. whitespace is collapsed, not carried through');
check('newlines/tabs collapse to single spaces',
  normalizeClassifyResult({ items: [{ text: '  Get\n\tmilk  ', destination: 'task' }] }, 'Get milk'),
  [{ text: 'Get milk', destination: 'task', life_stream_key: null, owner_name: null }]);

console.log('\n3. THE FIX — a dictated dump splits into separately-filed items');
const DUMP = "get milk, chase the Henderson quote, and I'm a bit stressed about money";
check('three thoughts -> three destinations, in the order spoken',
  DESTINATIONS_OF(normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: 'chase the Henderson quote', destination: 'task' },
      { text: "I'm a bit stressed about money", destination: 'life_stream', life_stream_key: 'money' },
    ],
  }, DUMP)),
  ['task', 'task', 'life_stream']);
check('and the life-stream item keeps its stream key',
  normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: "I'm a bit stressed about money", destination: 'life_stream', life_stream_key: 'money' },
    ],
  }, "get milk and I'm a bit stressed about money")[1].life_stream_key,
  'money');

console.log('\n4. the model dropping an item cannot lose what was said');
const dropped = normalizeClassifyResult({
  items: [
    { text: 'get milk', destination: 'task' },
    { text: 'chase the Henderson quote', destination: 'task' },
  ],
}, DUMP);
check('falls back to ONE item holding the whole original text', dropped.length, 1);
check('the whole dump survives verbatim', dropped[0].text, DUMP);
check('and keeps the destination it was most confident about', dropped[0].destination, 'task');
check('a faithful split is NOT tripped by the same guard',
  normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: 'chase the Henderson quote', destination: 'task' },
      { text: "I'm a bit stressed about money", destination: 'life_stream', life_stream_key: 'money' },
    ],
  }, DUMP).length,
  3);

console.log('\n5. a summarised (shortened) single item is caught too');
const summarised = normalizeClassifyResult(
  { items: [{ text: 'milk', destination: 'task' }] },
  'Remember to get milk on the way home this afternoon');
check('single short item keeps its destination but not its abbreviated text',
  [summarised.length, summarised[0].text, summarised[0].destination],
  [1, 'Remember to get milk on the way home this afternoon', 'task']);
check('a faithful single item is left alone',
  normalizeClassifyResult({ items: [{ text: 'Get milk', destination: 'task' }] }, 'Get milk')[0].text,
  'Get milk');

console.log('\n6. the legacy single-destination shape still files correctly');
check('old { destination } response -> one item',
  normalizeClassifyResult({ destination: 'strategy' }, 'We should focus on repeat customers'),
  [{ text: 'We should focus on repeat customers', destination: 'strategy', life_stream_key: null, owner_name: null }]);
check('backend can keep serving a stale frontend',
  normalizeClassifyResult({ destination: 'task' }, 'Call the supplier').length, 1);

console.log('\n7. junk in, whole text out — never a dropped dump');
for (const [label, result] of [
  ['null result', null],
  ['empty object', {}],
  ['empty items array', { items: [] }],
  ['items not an array', { items: 'task' }],
  ['unknown destination only', { destination: 'nonsense' }],
  ['entries with no text', { items: [{ destination: 'task' }, null, 'nope', { text: '   ' }] }],
]) {
  const out = normalizeClassifyResult(result, 'Something Rob actually said');
  check(`${label} -> one knowledge item holding the original`,
    [out.length, out[0].text, out[0].destination],
    [1, 'Something Rob actually said', 'knowledge']);
}

console.log('\n8. an unknown destination loses the bucket, not the words');
check('text kept, destination defaulted',
  normalizeClassifyResult({ items: [{ text: 'Ring the bank', destination: 'urgent' }] }, 'Ring the bank'),
  [{ text: 'Ring the bank', destination: 'knowledge', life_stream_key: null, owner_name: null }]);

console.log('\n9. life_stream_key is only honoured where it means something');
check('a stream key on a task is discarded',
  normalizeClassifyResult({ items: [{ text: 'Pay the rego', destination: 'task', life_stream_key: 'money' }] }, 'Pay the rego')[0].life_stream_key,
  null);
check('an invented stream key is discarded',
  normalizeClassifyResult({ items: [{ text: 'Feeling flat', destination: 'life_stream', life_stream_key: 'vibes' }] }, 'Feeling flat')[0].life_stream_key,
  null);
check('a valid stream key is kept',
  normalizeClassifyResult({ items: [{ text: 'Feeling flat', destination: 'life_stream', life_stream_key: 'health' }] }, 'Feeling flat')[0].life_stream_key,
  'health');

console.log('\n10. owners — per item, by name, case-insensitively');
const PEOPLE = ['Sarah', 'Dave Thompson'];
check('assigns the named person to the item that names them',
  normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: 'ask Dave Thompson about the trailer', destination: 'task', owner_name: 'dave thompson' },
    ],
  }, 'get milk and ask Dave Thompson about the trailer', PEOPLE).map((i) => i.owner_name),
  [null, 'Dave Thompson']);
check('canonical name casing comes from the database, not the model',
  normalizeClassifyResult({ items: [{ text: 'x', destination: 'task', owner_name: 'SARAH' }] }, 'x', PEOPLE)[0].owner_name,
  'Sarah');
check('a name not in the account is not invented as an owner',
  normalizeClassifyResult({ items: [{ text: 'x', destination: 'task', owner_name: 'Someone Else' }] }, 'x', PEOPLE)[0].owner_name,
  null);

console.log('\n11. duplicates and runaway splitting are bounded');
check('an exactly repeated item is dropped',
  normalizeClassifyResult({
    items: [
      { text: 'call the plumber', destination: 'task' },
      { text: 'Call the plumber', destination: 'task' },
    ],
  }, 'call the plumber, call the plumber').length,
  1);
const many = Array.from({ length: 12 }, (_, i) => ({ text: `this is item number ${i} and it has some length`, destination: 'task' }));
check(`items are capped at MAX_ITEMS (${MAX_ITEMS})`,
  normalizeClassifyResult({ items: many }, many.slice(0, MAX_ITEMS).map((m) => m.text).join(' ')).length, MAX_ITEMS);

console.log('\n12. the prompt carries the rules the guards depend on');
// A marker that cannot collide with the prompt's own example phrases ("get
// milk" appears there as a task example).
const MARKER = 'zzqcall the supplier about Hendersonzzq';
const prompt = buildClassifyPrompt({ text: MARKER, businessContext: 'a business', peopleNames: PEOPLE });
check('states the dump may be dictated and multi-thought', /DICTATED/.test(prompt) && /several unrelated thoughts/.test(prompt), true);
check('forbids summarising, which is what the loss guard detects', /OWN WORDS, not a summary/.test(prompt), true);
check('forbids over-splitting a single thought', /call mum and dad" is ONE task/.test(prompt), true);
check('names the assignable people', /"Sarah", "Dave Thompson"/.test(prompt), true);
check('carries the actionable-vs-not rule, not business-vs-personal', /ACTIONABLE vs NOT/.test(prompt), true);
check('embeds the text exactly once', (prompt.match(/zzq/g) || []).length, 2); // open + close marker
const noPeople = buildClassifyPrompt({ text: 'get milk', businessContext: 'a business', peopleNames: [] });
check('no people block when the account has no other people', /People who can be assigned/.test(noPeople), false);
check('blank names are not offered as owners',
  /People who can be assigned/.test(buildClassifyPrompt({ text: 'x', businessContext: 'b', peopleNames: ['  ', ''] })), false);

console.log('\n13. the schema asks for a list, and stays within the codebase convention');
check('root is an object, not a bare array', CLASSIFY_SCHEMA.type, 'object');
check('items is the required array', [CLASSIFY_SCHEMA.required, CLASSIFY_SCHEMA.properties.items.type], [['items'], 'array']);
check('each item requires text + destination', CLASSIFY_SCHEMA.properties.items.items.required, ['text', 'destination']);
check('the destination enum matches the module constant',
  CLASSIFY_SCHEMA.properties.items.items.properties.destination.enum, DESTINATIONS);
check('the stream-key enum matches the module constant',
  CLASSIFY_SCHEMA.properties.items.items.properties.life_stream_key.enum, LIFE_STREAM_KEYS);
check('the schema caps items at MAX_ITEMS', CLASSIFY_SCHEMA.properties.items.maxItems, MAX_ITEMS);

console.log('\n6. a SHORT dropped thought is caught, not just a large loss');
// Character coverage cannot see this: dropping the last three words of a 51-character
// dump leaves 0.76, while a faithful three-item split of the same dump only reaches
// ~0.86 (the connectives go with the split). The old 0.6 floor sat below both, so the
// guard written to stop a thought being lost passed the case it existed for. Reproduced
// by execution before the rule changed; the clause test catches it now.
const SHORT_DROP_DUMP = 'Book the kids into swimming, pay the rego, get milk';
const shortDrop = normalizeClassifyResult({
  items: [
    { text: 'Book the kids into swimming', destination: 'task' },
    { text: 'pay the rego', destination: 'task' },
  ],
}, SHORT_DROP_DUMP);
check('a dropped short thought files the whole dump instead', shortDrop.length, 1);
check('…verbatim, so nothing is lost', shortDrop[0].text, SHORT_DROP_DUMP);

console.log('\n7. …without tripping on a faithful split or a light rewrite');
check('a faithful three-item split of the same dump still splits',
  normalizeClassifyResult({
    items: [
      { text: 'Book the kids into swimming', destination: 'task' },
      { text: 'pay the rego', destination: 'task' },
      { text: 'get milk', destination: 'task' },
    ],
  }, SHORT_DROP_DUMP).length, 3);
check('a split that drops only the connective still splits',
  normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: 'chase the Henderson quote', destination: 'task' },
    ],
  }, 'get milk and chase the Henderson quote').length, 2);
check('a lightly rewritten item is not treated as a loss',
  normalizeClassifyResult({
    items: [
      { text: 'book kids swimming', destination: 'task' },
      { text: 'pay rego', destination: 'task' },
    ],
  }, 'Book the kids into swimming, pay the rego').length, 2);

console.log('\n8. a fallback says which kind it is, so the card cannot read as sorted');
check('nothing usable at all is marked nothing-classified',
  normalizeClassifyResult(null, 'get milk and chase the quote')[0].fallback_reason, FALLBACK_NOTHING_CLASSIFIED);
check('a dropped thought is marked incomplete',
  normalizeClassifyResult({ items: [{ text: 'get milk', destination: 'task' }] }, 'Book the kids into swimming, pay the rego, get milk')[0].fallback_reason,
  FALLBACK_INCOMPLETE);
check('a faithful split carries no marker at all',
  normalizeClassifyResult({
    items: [
      { text: 'get milk', destination: 'task' },
      { text: 'chase the Henderson quote', destination: 'task' },
    ],
  }, 'get milk and chase the Henderson quote').every((i) => i.fallback_reason === undefined), true);

console.log('\n9. a failed classification can never hand the dump back as a manual chore');
// 2026-10-01, Rob: "the brain dump keeps filing files to unfiled ... that's a just in case so you
// can file it manually". The unsorted pile has exactly ONE creator in the whole codebase — the
// catch around classifyDeckDumpItem in CommandDeckContext — so every dump that landed there was a
// classification that THREW. Measured: the last four brain-dump classify calls all ended at exactly
// out=4000 from a ~961-token prompt after ~18s, and three logged OUTPUT_TRUNCATED after #390's
// salvage was supposed to have made that survivable. `salvageJson` recovers a complete PREFIX; when
// the model spends the whole budget thinking there is no prefix to recover and it rethrows.
//
// So the claim the guard makes is the one Rob asked for: whatever the model does, the dump is filed.
const handler = read('../server/src/functions/classifyDeckDumpItem.js');
check('the fallback is total — no result still files the whole dump',
  normalizeClassifyResult(null, 'get milk and chase the Henderson quote at 4', ['Dave']), [{
    text: 'get milk and chase the Henderson quote at 4',
    destination: 'knowledge',
    life_stream_key: null,
    owner_name: null,
    fallback_reason: FALLBACK_NOTHING_CLASSIFIED,
  }]);
check('…and it names the destination the frontend will actually file it to',
  normalizeClassifyResult(undefined, 'anything')[0].destination, 'knowledge');
check('the handler asks the model from inside a try', /try \{\s*\n\s*\(\(?\{ result, truncated \}\)? = await invokeAI\(\{/.test(handler), true);
// ONE attempt. #467 shipped a retry; the very next dump ("I need to get fruit") made two calls 19s
// apart and saturated at exactly the same output both times, so the failure belongs to the prompt and
// a retry only costs the operator another ~19 seconds.
check('…with exactly one attempt', (handler.match(/await invokeAI\(\{/g) || []).length, 1);
check('a failed attempt files the dump instead of throwing',
  /catch \(aiErr\) \{[\s\S]{0,600}?result = null;/.test(handler), true);
check('…and nothing in the AI path rethrows at the caller',
  /throw/.test(handler.slice(handler.indexOf('let result = null;'))), false);
// The budget is a DECISION with a measurement behind it, not a default: every brain-dump call measured
// from 2026-09-27 to 2026-10-01 ended at exactly the old cap with nothing salvageable. Pinned so it
// cannot drift back silently — and so the next session sees it was chosen.
check('the call is given a budget that outlives the measured truncation point',
  /maxTokens: (\d+)/.exec(handler) && Number(/maxTokens: (\d+)/.exec(handler)[1]) >= 8000, true);
check('…and it is the only budget in the call', (handler.match(/maxTokens: /g) || []).length, 1);
// Prose is wrapped at 100 columns and every line carries a comment marker, so the comment is unwrapped
// before matching — the same reason the repo strips comments when it matches CODE, in reverse.
const handlerProse = handler.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
check('…and the reason it is not "just another cap raise" is written down next to it',
  /reasoning tax was the cause[\s\S]{0,900}?decision rule declared in advance/.test(handlerProse), true);
check('the items are normalised once, after the attempt, from whatever we got',
  /const items = normalizeClassifyResult\(result, text, peopleNames\);\n\n  \/\/ The truncation/.test(handler), true);

const deckContext = read('../src/contexts/CommandDeckContext.jsx');
check('the pile still has exactly one creator — a classification that threw',
  (deckContext.match(/DeckDumpItem\.create\(/g) || []).length, 1);
check('…and it is the catch around the classify call',
  /catch \{[\s\S]{0,700}?DeckDumpItem\.create\(\{ text \}\)/.test(deckContext), true);

console.log('\n10. an unambiguous errand is a task, decided in code, without asking the model');
// 2026-10-01. Rob: "i need to get cheese", "Rob needs to get bread", "I need to get fruit" — "clearly
// and unambiguously tasks for me" — were NOT filed as tasks. Eight measured classify calls each ended
// at exactly the output cap (4000, then 8000) after 18-34s, one of them using 7905 tokens of reasoning
// to answer a six-word note. The prompt already states the rule this encodes; deciding it in code is
// instant, identical every time, and free.
const FAST_PEOPLE = ['Dave', 'Alice'];
const FAST_SELF = ['Rob'];
const fast = (t) => patternClassify(t, { people: FAST_PEOPLE, selfNames: FAST_SELF });
const asTask = (t, owner = null) => [{ text: t, destination: 'task', life_stream_key: null, owner_name: owner }];

check("Rob's own words file as his task", fast('I need to get cheese'), asTask('I need to get cheese'));
check('…lowercase too, because dictation', fast('i need to get fruit'), asTask('i need to get fruit'));
check('…and his own name said by him is still his task, not a stranger',
  fast('Rob needs to get bread'), asTask('Rob needs to get bread'));
check('a named person gets their own task', fast('Dave needs to pick up the trailer'), asTask('Dave needs to pick up the trailer', 'Dave'));
check("'remember to' and 'don't forget to' are the same rule",
  fast("Don't forget to pay the rego"), asTask("Don't forget to pay the rego"));
check('and so is an explicit todo line', fast('TODO: chase the Henderson quote'), asTask('TODO: chase the Henderson quote'));
check('…with any surrounding case', fast('remember to book the dentist'), asTask('remember to book the dentist'));

// The negative half is the important half: this must stay narrow. Anything with a second thought in it
// belongs to the model, because a fast path that guesses at SPLITTING is the failure this feature keeps
// having — a split is what put "get milk and ask Dave about the trailer" on Dave's list.
check('two thoughts is not one task — the model splits it',
  fast('I need to get cheese and Rob needs to get bread'), null);
check('a comma is a second thought', fast('Book the kids into swimming, pay the rego'), null);
check('a second sentence is a second thought', fast('I need to get milk. Also call Dave'), null);
check('a status note is not an action', fast('spending feels out of control'), null);
check('a fact is not an action', fast('the Traynor amp is worth about $2k'), null);
check('a reflection beginning "I built" is not an action', fast('I built morpheus and command deck to help me'), null);
check('an unknown name is left to the model, never guessed at', fast('Brian needs to call me'), null);
check('an empty dump decides nothing', fast('   '), null);

// Documented, deliberate consequence: the prompt's own rule is "If it reads as 'I need to X' … it is a
// task even if X is a two-second errand", and "think about X" is an X. Pinned so it cannot change
// silently and so the next session can see it was chosen rather than missed.
check('"I need to think about X" is a task, by the rule the prompt itself states — deliberate',
  fast('I need to think about whether the shop is working')?.[0]?.destination, 'task');

const handlerSrc = read('../server/src/functions/classifyDeckDumpItem.js');
check('the handler decides in code BEFORE it builds a prompt',
  handlerSrc.indexOf('patternClassify(text') < handlerSrc.indexOf('buildClassifyPrompt({'), true);
check('…and returns without calling the model at all',
  /if \(decided\) \{[\s\S]{0,300}?return \{ items: decided/.test(handlerSrc), true);
check('…against the speaker\'s own name as well as other people\'s',
  /selfNames/.test(handlerSrc) && /selfNames: selfNames|selfNames \}/.test(handlerSrc), true);
check('…while the PROMPT still gets only other people',
  /peopleNames = people\.filter\(\(p\) => !p\.is_self\)/.test(handlerSrc), true);

console.log('\n11. thinking about something is not doing it — the prompt states the rule it was deciding against');
// Rob, 2026-10-02: "i also just said im thinking about buying murbah music 2 shops maybe and it filled
// that to tasks too, thats clearly strategy type stuff". Measured in usage_events: the classify call
// ran (in=976, out=4201, 20s) and returned task, against the prompt's own rule that a task reads as
// "I need to X" / an instruction to do something. The prompt named no test for a possibility being
// turned over, so the model had only the ACTIONABLE-vs-NOT question to go on and "buying two shops"
// answered it.
//
// This can only assert the RULE IS IN THE PROMPT — the model's obedience is not reachable from here
// (this Mac's server/.env is the dock-rig mock). What it prevents is the rule silently falling out
// again, which is how the gap appeared in the first place.
const considerationPrompt = buildClassifyPrompt({ text: 'i think I might look at buying murbah music its upforsale 2 shops maybe', businessContext: 'a music shop' });
check('the prompt says a consideration is not an action',
  /THINKING ABOUT something is not DOING it/.test(considerationPrompt), true);
check('…and names the hedging language that makes it one',
  ['thinking about', 'might', 'maybe', 'considering', 'what if we'].every((w) => considerationPrompt.includes(w)), true);
check('…and routes it to strategy, not task',
  /is STRATEGY when it concerns the business/.test(considerationPrompt), true);
check('…with a worked example of the business case',
  /buying two more shops, maybe" is strategy/.test(considerationPrompt), true);
check('…while still keeping the everyday action case as a task',
  /"I need to get milk" is a task/.test(considerationPrompt) && /If it reads as "I need to X"/.test(considerationPrompt), true);
check('the strategy bucket now covers an opportunity or direction, not only a plan',
  /strategy, plan, approach, opportunity or direction worth tracking/.test(considerationPrompt), true);

console.log('\n11b. a statement about how the speaker IS is a reflection, not a task about the tasks');
// Rob, 2026-10-02. The dump — "I have AuHD and excecutive disfunction issue, i have a hard time keeping
// track of things and actioning tasks" — made flash burn 6277 and then 8000 output tokens across two
// attempts (28s, 35s), and the words ended up in the unsorted pile. The life_stream bullet described an
// area of life going badly but said nothing about the speaker describing THEMSELVES, and the trailing
// "actioning tasks" is the trap: it reads as work not getting done, which invites the task bucket and a
// long argument with itself.
const selfDescription = buildClassifyPrompt({ text: 'I have AuHD and excecutive disfunction issue, i have a hard time keeping track of things and actioning tasks', businessContext: 'a music shop' });
check('the prompt covers the speaker describing themselves',
  /statement about how the SPEAKER IS/.test(selfDescription), true);
check('…and says it is life_stream even when it mentions tasks',
  /always life_stream, even when it mentions tasks or things not getting done/.test(selfDescription), true);
check('…with the real case as its worked example',
  /I have ADHD and executive dysfunction/.test(selfDescription), true);
check('…and tells the model not to deliberate on it, which is the cost being fixed',
  /Do not deliberate over this one/.test(selfDescription), true);

console.log('\n12. an open-ended intention about a life area is not an errand');
// Rob, 2026-10-02: "i need to do more exercise, that just went to tasks too". Confirmed in production:
// no usage_events row at all, so this was NEVER the model — the code fast path owns every "I need to
// X" and claimed this one as a task. The prompt\'s rule has two halves ("a STATUS UPDATE or REFLECTION
// about health... If it names a specific thing to go do, it\'s a task instead") and the fast path had
// only encoded the first. The negatives below matter as much as the positives: the whole risk of a
// fast path is claiming an errand it should have left alone.
const lifeIntent = (t) => {
  const r = patternClassify(t, { people: [], selfNames: ['Rob'] });
  return r && r.length ? `${r[0].destination}${r[0].life_stream_key ? '/' + r[0].life_stream_key : ''}` : null;
};
check('more exercise is the health stream', lifeIntent('I need to do more exercise'), 'life_stream/health');
check('eating better likewise', lifeIntent('I need to eat better'), 'life_stream/health');
check('saving more is the money stream', lifeIntent('I need to save more money'), 'life_stream/money');
check('seeing the kids more is the people stream', lifeIntent('I need to see the kids more'), 'life_stream/people');
check('reading more is growth', lifeIntent('I need to read more'), 'life_stream/growth');

console.log('\n13. …and the errands it already handled are untouched');
// Each of these contains the same words the new rule keys on, and each is still something to go and
// do. If a future tweak to OPEN_ENDED/LIFE_AREA starts claiming these, that is the regression.
check('"get milk" is still a task — the case #469 was built for', lifeIntent('I need to get milk'), 'task');
check('"get MORE milk" is a quantity of an errand, not an intention', lifeIntent('I need to get more milk'), 'task');
check('paying the gym is a payment, not a health intention', lifeIntent('I need to pay the gym membership'), 'task');
check('booking the dentist is a specific thing to do', lifeIntent('I need to book a dentist appointment'), 'task');
check('"call the bank" is still a task', lifeIntent('I need to call the bank'), 'task');
check('the other #469 cases still hold',
  lifeIntent('I need to get cheese') === 'task' && lifeIntent('Rob needs to get bread') === 'task', true);
check('two thoughts are still the model\'s job, whatever the words',
  lifeIntent('I need to do more exercise and eat better'), null);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
