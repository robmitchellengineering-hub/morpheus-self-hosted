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
import {
  CLASSIFY_SCHEMA, DESTINATIONS, LIFE_STREAM_KEYS, MAX_ITEMS,
  buildClassifyPrompt, normalizeClassifyResult,
} from '../server/src/lib/deckDumpClassify.js';

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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
