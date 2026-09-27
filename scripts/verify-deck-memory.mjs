// Runtime verification for the Deck's long-term memory fold.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-deck-memory.mjs
//
// The load-bearing case is the second one. `MEMORY_SCHEMA` does not mark `memory` as
// required, so a valid `{}` is reachable — and the fold used to keep the old content
// while still advancing `folded_message_count`, marking a batch of turns as folded when
// they had never been folded. The caller skips `alreadyFolded`, so those turns were
// never offered again: a silent, permanent hole in the memory the whole Deck reasons
// over, and one no log line mentioned.
import { usableMemoryText } from '../server/src/lib/deckMemoryText.js';
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

console.log('\n1. a usable memory is taken as written');
check('a normal answer', usableMemoryText({ memory: 'Prefers mornings; trailer rego due in March.' }),
  'Prefers mornings; trailer rego due in March.');
check('surrounding whitespace is trimmed', usableMemoryText({ memory: '  notes  ' }), 'notes');

console.log('\n2. an answer with no memory is empty, not the old content');
check('an empty object — the reachable case', usableMemoryText({}), '');
check('an explicit empty string', usableMemoryText({ memory: '' }), '');
check('whitespace only', usableMemoryText({ memory: '   ' }), '');
check('null', usableMemoryText(null), '');
check('a non-string memory', usableMemoryText({ memory: { text: 'x' } }), '');

console.log('\n3. the fold advances the counter only when there is something to store');
const src = readFileSync(new URL('../server/src/lib/deckMemory.js', import.meta.url), 'utf8');
// Comments are masked: the explanatory comment beside the check quotes this code, and a
// regex that matches its own explanation proves only that the explanation exists.
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('the empty answer is refused before the upsert',
  /if \(!returned\) \{[\s\S]{0,400}return existingContent;/.test(code), true);
check('…and nothing advances folded_message_count on that path',
  /no memory text; leaving folded_message_count at \$\{alreadyFolded\}/.test(src), true);
check('the upsert stores the model’s text, not a fallback to the old content',
  /content: returned, folded_message_count: alreadyFolded \+ batch\.length/.test(code), true);
check('…for both the create and the update branch',
  (code.match(/folded_message_count: alreadyFolded \+ batch\.length/g) || []).length, 2);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
