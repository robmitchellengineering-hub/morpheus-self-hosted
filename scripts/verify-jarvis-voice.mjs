// Runtime verification for Jarvis's voice: the prompt that shapes the reply, and the speed it is spoken at.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-jarvis-voice.mjs
//
// WHY THIS EXISTS. Rob, 2026-10-02: *"i remeber javis on the base 44 app being a better experiance ... the
// chat was super fast"*. Tracing it against the old base44 deck found two real causes, neither of them the
// model:
//
//   - the old prompt said "Keep replies short enough to speak aloud — usually 1 to 4 sentences"; the
//     rewrite dropped it, so a reply is now long enough to be slow to READ and to HEAR. Three constraints
//     were lost that way and nothing failed — a prompt is prose, and prose does not throw.
//   - the old client played the butler voice at `playbackRate = 1.3`; the new pipeline played it at 1.0×,
//     i.e. ~23% slower to listen to, with the same voice.
//
// Both are the "silently disappears" shape this repo keeps paying for, so both are asserted here.
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

const prompt = [
  readFileSync(new URL('../server/src/functions/chatWithJarvis.js', import.meta.url), 'utf8'),
  // 2026-10-03: the persona text moved to its own import-free module (so the snapshot
  // gate's guard can build both variants with no Prisma). The voice checks follow it.
  readFileSync(new URL('../server/src/lib/jarvisPersona.js', import.meta.url), 'utf8'),
].join('\n');
const voice = readFileSync(new URL('../src/hooks/useMorpheusVoice.js', import.meta.url), 'utf8');

console.log('\n1. the persona survives');
check('Jarvis is the butler', /You are Jarvis/.test(prompt) && /butler/.test(prompt), true);
check('…with the dry wit, not goofy', /devilish wit, understated rather than goofy/.test(prompt), true);
check('…and the balance worldview, not hustle unto burnout', /all in balance/.test(prompt), true);
check('…and no preamble', /No preamble, no sign-off/.test(prompt), true);

console.log('\n2. the two constraints the rewrite dropped are back');
// Load-bearing: reply LENGTH is the biggest lever on how fast the whole thing feels, and the old prompt
// tied it to being spoken aloud — which is the thing the new one had stopped doing.
check('replies stay short enough to speak aloud', /short enough to speak aloud/.test(prompt), true);
check('…and the old rule of thumb is named', /one to four sentences/.test(prompt), true);
check('a clarifying question is a last resort', /clarifying question only when it genuinely changes your answer/.test(prompt), true);
// The old prompt's "Sarcasm and gentle ribbing are encouraged — dry, never cruel — because it comes from
// love" is already carried by the new one as "it lands because they know you mean it" — asserted so the
// equivalence cannot be lost from both sides at once.
check('the ribbing still reads as affection', /it lands because they know you mean it/.test(prompt), true);

console.log('\n3. the voice plays at the speed the old deck used');
check('one named constant for the rate', /const PLAYBACK_RATE = 1\.3;/.test(voice), true);
check('…and it is actually applied to the server audio', /audio\.playbackRate = PLAYBACK_RATE;/.test(voice), true);
check('the browser fallback still exists, so the button is never silent',
  /speechSynthesis\.speak/.test(voice), true);
// The butler voice is the primary path; the fallback deliberately keeps its own gentler rate.
check('…and the fallback is not left at the default either', /utter\.rate = 0\.\d+/.test(voice), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
