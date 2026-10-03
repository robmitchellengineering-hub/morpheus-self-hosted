// Jarvis's careers: the register, the briefs, the selection, and the grounding.
//
// Dependency-free apart from the three pure modules it guards, so it runs in CI's no-install guards
// job. Run:  node scripts/verify-jarvis-careers.mjs
//
// WHY THIS EXISTS. Four separate ways this feature can rot, none of which throws:
//
//   1. THE LIST DRIFTS. The 36 names used to be written in two places, and a card can name a career
//      the persona does not have. The register is now the only copy, and that is asserted rather
//      than intended.
//   2. A CARD STOPS BEING A SHORTHAND. The likeliest way this feature fails is by quietly becoming
//      36 essays, which costs tokens on every matching message and adds nothing the model did not
//      already know. The size budget and the section set are the guard, not the intent.
//   3. THE SELECTOR INVENTS A CAREER, or returns junk, or returns all 36. Anything unusable must
//      yield NOTHING, because the failure direction here is the opposite of the snapshot gate's:
//      there is no token headroom to fail open into, and an empty selection is simply the
//      pre-feature behaviour (the names are always in the persona).
//   4. THE GROUNDING GOES SILENT. Rob: "realestate advice on greenland os differnt to the gold
//      coast". If a turn without a stored region renders a prompt with no mention of that, Jarvis
//      answers for whichever country dominates its training data and nobody can tell.
import { readFileSync } from 'node:fs';

import {
  CAREER_KEYS, CARD_SECTIONS, CARD_MAX_CHARS, cardedCareers, careerListText, careerBlock, isKnownCareer,
} from '../server/src/lib/jarvisCareers.js';
import { buildJarvisSystemPrompt, buildRegionsClaim } from '../server/src/lib/jarvisPersona.js';
import { SNAPSHOT_NEED_SCHEMA, MAX_SELECTED_CAREERS, selectedCareerKeys, shouldIncludeSnapshot } from '../server/src/lib/deckSnapshotGate.js';

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

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n1. the register is the ONLY copy of the list');

// Rob gave 36 (2026-10-03). The count is here so that "one quietly disappeared" is a failure and
// not a judgement call — this is the list that decides who Jarvis is.
check('36 careers, as Rob gave them', CAREER_KEYS.length, 36);
check('…with no duplicates', new Set(CAREER_KEYS).size, CAREER_KEYS.length);
check('…and every entry is a real, trimmed string',
  CAREER_KEYS.every((k) => typeof k === 'string' && k.length > 0 && k.trim() === k), true);
check('careerListText renders exactly the register, in order', careerListText(), CAREER_KEYS.join(', '));

const personaSrc = read('server/src/lib/jarvisPersona.js');
// The anti-drift check that matters: the names must NOT be written out in the persona any more. If
// someone pastes the list back in, the two copies can disagree and this notices.
check('the persona does not carry a second copy of the names',
  CAREER_KEYS.some((k) => personaSrc.includes(k)), false);
check('…it renders them from the register instead', /careerListText\(\)/.test(personaSrc), true);

console.log('\n2. every brief is a shorthand, not an essay');

const carded = cardedCareers();
check('every carded career is one of the 36', carded.every((k) => isKnownCareer(k)), true);
check('…and the coverage has not silently shrunk below the first slice', carded.length >= 3, true);
check('…and it is not claiming more cards than careers', carded.length <= CAREER_KEYS.length, true);

// Read the cards through the public block so the guard sees exactly what the model sees.
const allCardsBlock = careerBlock(CAREER_KEYS);
const cardTexts = allCardsBlock.split('\n\n').filter((chunk) => chunk.includes('\n'));
check('every card is within the size budget',
  cardTexts.every((card) => card.length <= CARD_MAX_CHARS), true);
check('…and the budget is the thing stopping 36 essays', CARD_MAX_CHARS <= 900, true);

// A section is a line that starts with `key:` — the shorthand's whole point is that the shape is the
// same every time, so the model reads it the same way every time.
for (const career of carded) {
  const block = careerBlock([career]);
  const missing = CARD_SECTIONS.filter((section) => !new RegExp(`^${section}:`, 'm').test(block));
  check(`"${career}" carries every section`, missing, []);
}
// `check:` and `region:` are the two that keep this honest — see the module header.
check('every card says what must be LOOKED UP rather than asserted',
  carded.every((c) => /^check:/m.test(careerBlock([c]))), true);
check('…and every card scopes itself by region, explicitly',
  carded.every((c) => /^region:/m.test(careerBlock([c]))), true);

console.log('\n3. the selector cannot invent a career, or overrun');

check('known keys pass through, in order', selectedCareerKeys({ careers: ['lawyer', 'doctor'] }), ['lawyer', 'doctor']);
check('an unknown name is DROPPED, not trusted', selectedCareerKeys({ careers: ['doctor', 'astronaut badge'] }), ['doctor']);
check('duplicates collapse', selectedCareerKeys({ careers: ['doctor', 'doctor'] }), ['doctor']);
check('more than the cap is capped', selectedCareerKeys({ careers: CAREER_KEYS }).length, MAX_SELECTED_CAREERS);
check('…and the cap is the one the schema advertises', MAX_SELECTED_CAREERS, 3);
check('a missing field is EMPTY — the opposite direction from the snapshot',
  selectedCareerKeys({ needsSnapshot: true }), []);
check('a string is EMPTY', selectedCareerKeys({ careers: 'doctor' }), []);
check('null is EMPTY', selectedCareerKeys({ careers: null }), []);
check('a number is EMPTY', selectedCareerKeys({ careers: 7 }), []);
check('nothing at all is EMPTY', selectedCareerKeys(undefined), []);
check('whitespace is trimmed rather than trusted', selectedCareerKeys({ careers: ['  doctor  '] }), ['doctor']);

// The two directions, side by side, in one place — they are the whole reason this call has two
// decisions in it and one of them is not the other's shape.
check('the SAME garbage answer keeps the snapshot and attaches no briefs',
  [shouldIncludeSnapshot({}), selectedCareerKeys({})], [true, []]);

console.log('\n4. it is provably NOT always-on');

check('no selection renders no card block at all', careerBlock([]), '');
check('…and the block is empty for junk too', careerBlock(['not a career']), '');
const promptNoCareers = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'a shop', hasSnapshot: false, regions: [], careers: [] });
const promptDefaulted = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'a shop', hasSnapshot: false });
check('…so a turn with no briefs composes the untouched prompt', promptNoCareers === promptDefaulted, true);
check('…and carries no card text', /DOCTOR \(general practice\)/.test(promptNoCareers), false);
const promptWithCard = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'a shop', hasSnapshot: false, regions: [], careers: ['doctor'] });
check('…while a selected brief is attached', /DOCTOR \(general practice\)/.test(promptWithCard), true);
check('…and only that one', /LAWYER/.test(promptWithCard), false);

console.log('\n5. the grounding is never silent');

const noRegion = buildRegionsClaim([]);
check('no stored region says so OUT LOUD', /NOT been told where they operate/.test(noRegion), true);
check('…names no country of its own', /Australia|Gold Coast|Queensland|United States|America/.test(noRegion), false);
check('…and asks rather than assuming', /which are you in/.test(noRegion), true);
const withRegion = buildRegionsClaim(['Gold Coast, QLD, Australia', '  ', 'Auckland, New Zealand']);
check('a stored region is named', /Gold Coast, QLD, Australia · Auckland, New Zealand/.test(withRegion), true);
check('…blank entries are dropped, not interpolated as emptiness', /·\s*·/.test(withRegion), false);
check('…and he must name which one he is answering for', /you say which one you are answering for/.test(withRegion), true);
check('…and must never state a jurisdiction-bound rule as universal',
  /never state a rule that varies by jurisdiction as though it were universal/i.test(withRegion), true);
check('…and must not average two places into an answer true in neither',
  /never average two jurisdictions/.test(withRegion), true);
check('junk is treated as "not told", never as a place', buildRegionsClaim('Gold Coast'), buildRegionsClaim([]));

const promptNoRegion = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'a shop', hasSnapshot: false });
check('…so a turn with no stored regions still carries the honest claim',
  /NOT been told where they operate/.test(promptNoRegion), true);
const promptWithRegion = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'a shop', hasSnapshot: false, regions: ['Gold Coast, QLD, Australia'] });
check('…and a stored region reaches the prompt', /Gold Coast, QLD, Australia/.test(promptWithRegion), true);

// The client parses the field and the server caps it. Two constants for one rule, so they are
// asserted equal — a client that keeps 20 and a server that keeps 8 would mean the operator sees a
// value that is not what Jarvis gets.
const clientSrc = read('src/pages/CommandDeck/operatingRegions.js');
const serverSrc = read('server/src/lib/deckBusinessProfile.js');
const constOf = (src) => (src.match(/MAX_OPERATING_REGIONS\s*=\s*(\d+)/) || [, null])[1];
check('the client and the server agree on the regions cap', constOf(clientSrc), constOf(serverSrc));
check('…and it is a real bound', Number(constOf(serverSrc)) > 0, true);

console.log('\n6. the wiring exists on both sides');

const chatSrc = read('server/src/functions/chatWithJarvis.js');
check('the handler reads the regions', /getDeckOperatingRegions\(user\.id\)/.test(chatSrc), true);
check('…and passes them, with the careers, to the persona',
  /buildJarvisSystemPrompt\(\{ firstName, businessContext, hasSnapshot: includeSnapshot, regions, careers \}\)/.test(chatSrc), true);
check('…and uses the same selector this guard tests', /selectedCareerKeys\(result\)/.test(chatSrc), true);
check('the schema asks for both fields', SNAPSHOT_NEED_SCHEMA.required.join(','), 'needsSnapshot,careers');

// H8: the migration and the bootstrap are two files, and a fresh self-host reads only the bootstrap.
const migration = read('server/prisma/selfdev-deck-operating-regions.sql');
check('the migration adds the column additively', /add column if not exists operating_regions/.test(migration), true);
check('…and the bootstrap gets it too, or a fresh self-host silently does not',
  /add column if not exists operating_regions/.test(read('server/prisma/manual-supabase-init.sql')), true);
check('…and the model declares it', /operating_regions\s+String\[\]/.test(read('server/prisma/schema.prisma')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
