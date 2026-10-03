// Runtime verification for the Deck's long-term memory fold.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-deck-memory.mjs
//
// TWO INCIDENTS ARE PINNED HERE, and they pull in opposite directions.
//
// (1) The silent hole. `MEMORY_SCHEMA` did not mark its field as required, so a valid `{}` was
//     reachable — and the fold kept the old content while still advancing `folded_message_count`,
//     marking a batch of turns as folded when they had never been folded. The caller skips
//     `alreadyFolded`, so those turns were never offered again: a permanent hole in the memory the
//     whole Deck reasons over, and no log line mentioned it.
//
// (2) The stall (2026-10-04, measured). The fold asked the model to WRITE OUT THE WHOLE MEMORY, so
//     its output grew with the memory while a reasoning model's hidden thinking was billed against
//     the same cap: 131 of the last 200 `diagnosis` rows sat at exactly 4000 tokens, threw on
//     truncation, and stored nothing. The model now SELECTS — lines to add, lines to drop — and the
//     splice happens in code. That moves the whole decision here, where it is testable with no model.
//
// The two failure directions of `applyMemoryEdit` are deliberate and are asserted: a removal that
// does not match deletes NOTHING (a paraphrase must not cost a real memory), and the ceiling drops
// the OLDEST line, which is a real loss and therefore the last resort.
import { memoryLines, memoryWordCount, memoryEdit, applyMemoryEdit } from '../server/src/lib/deckMemoryText.js';
import { readFileSync } from 'node:fs';

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

console.log('\n1. stored memory reads as lines');
check('split, trimmed, blanks dropped',
  memoryLines('  a fact  \n\n another fact \n   \n'), ['a fact', 'another fact']);
check('order is preserved — oldest first, which is what the ceiling trims', memoryLines('first\nsecond'), ['first', 'second']);
check('empty and junk are no lines', [memoryLines(''), memoryLines(null), memoryLines(undefined)], [[], [], []]);
check('word counting is the ceiling\u2019s unit', memoryWordCount('one two  three\nfour'), 4);

console.log('\n2. the model\u2019s edit is read defensively');
check('both lists pass through', memoryEdit({ additions: ['a'], removals: ['b'] }), { additions: ['a'], removals: ['b'] });
check('junk is empty lists, never a throw',
  [memoryEdit({}), memoryEdit(null), memoryEdit({ additions: 'x', removals: 7 })],
  [{ additions: [], removals: [] }, { additions: [], removals: [] }, { additions: [], removals: [] }]);
check('entries are trimmed and blanks dropped', memoryEdit({ additions: ['  keep  ', '', '   '] }).additions, ['keep']);

console.log('\n3. applying an edit — additions');
const base = 'Likes mornings\nTrailer rego due in March';
check('a new line is appended', applyMemoryEdit(base, { additions: ['Sister is Amanda'] }),
  'Likes mornings\nTrailer rego due in March\nSister is Amanda');
check('an empty edit changes nothing', applyMemoryEdit(base, {}), base);
check('a line already known is NOT duplicated', applyMemoryEdit(base, { additions: ['likes MORNINGS'] }), base);
check('the same line twice in one edit lands once',
  applyMemoryEdit(base, { additions: ['New fact', 'New fact'] }), `${base}\nNew fact`);

console.log('\n4. applying an edit — removals, and the SAFE direction');
check('a line the model names is removed', applyMemoryEdit(base, { removals: ['Trailer rego due in March'] }), 'Likes mornings');
check('removal is not case-sensitive', applyMemoryEdit(base, { removals: ['trailer rego due in march'] }), 'Likes mornings');
// The paraphrase case: a near-miss must cost nothing, because losing a true memory is far worse than
// keeping a stale one. This is the assertion that makes the direction real rather than intended.
check('a removal that does not match deletes NOTHING',
  applyMemoryEdit(base, { removals: ['Trailer rego is due in March'] }), base);
check('…and blank removals delete nothing', applyMemoryEdit(base, { removals: ['', '   '] }), base);

console.log('\n5. the ceiling, and it is the last resort');
const many = Array.from({ length: 40 }, (_, i) => `fact number ${i} with a few words in it`);
const capped = applyMemoryEdit(many.join('\n'), {}, { maxWords: 30 });
check('an oversized memory is brought under the ceiling', memoryWordCount(capped) <= 30, true);
check('…by dropping the OLDEST lines first', /^fact number 3[0-9]/.test(capped.split('\n')[0]), true);
check('…and the newest line survives whatever happens', capped.split('\n').slice(-1)[0], many[39]);
check('the last line is never dropped to satisfy the ceiling',
  applyMemoryEdit('a very long line indeed with many many many many words in it', {}, { maxWords: 1 }),
  'a very long line indeed with many many many many words in it');

console.log('\n6. an answer that would empty the memory is refused by the caller');
const foldSrc = readFileSync(new URL('../server/src/lib/deckMemory.js', import.meta.url), 'utf8');
// Comments masked: the comment beside this code quotes it, and a regex that matches its own
// explanation proves only that the explanation exists.
const code = foldSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('the fold applies the edit in code rather than storing model prose',
  /const returned = applyMemoryEdit\(existingContent, result, \{ maxWords: MAX_MEMORY_WORDS \}\);/.test(code), true);
check('an edit that empties an existing memory is refused', /if \(!returned && existingContent\)/.test(code), true);
check('…and nothing advances on that path', /would have emptied the memory[\s\S]{0,200}return existingContent;/.test(code), true);

console.log('\n7. the schema can no longer produce the empty answer that caused incident 1');
check('the model is asked to SELECT, not to compose the memory',
  /additions: { type: 'array'/.test(code) && /removals: { type: 'array'/.test(code), true);
check('…so the old free-text `memory:` field is gone from the schema',
  /properties: \{ memory: \{ type: 'string'/.test(code), false);
check('…and both fields are REQUIRED, so `{}` is a schema failure rather than a silent no-op',
  /required: \['additions', 'removals'\]/.test(code), true);
check('the prompt still asks only for the two lists',
  /Return JSON with:\n- additions:/.test(foldSrc), true);

console.log('\n8. the fold ADVANCES when the batch genuinely added nothing');
// The opposite error to incident 1 and just as permanent: an empty edit is a successful fold that
// decided nothing was worth keeping. Refusing to advance would replay the same batch forever.
check('an empty edit is not treated as a failure — only a throw or an emptied memory is',
  /if \(!returned && existingContent\)/.test(code) && !/if \(!returned\) \{/.test(code), true);
check('the upsert stores the applied edit and advances the counter',
  /content: returned, folded_message_count: alreadyFolded \+ batch\.length/.test(code), true);
check('…for both the create and the update branch',
  (code.match(/folded_message_count: alreadyFolded \+ batch\.length/g) || []).length, 2);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
