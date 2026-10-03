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
import { buildJarvisSystemPrompt } from '../server/src/lib/jarvisPersona.js';
import { CAREER_KEYS } from '../server/src/lib/jarvisCareers.js';

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
// The prompt as the model actually receives it, with the register interpolated and no snapshot and
// no regions — so a check can assert what a REAL turn is composed of, not just what the source says.
const builtPrompt = buildJarvisSystemPrompt({
  firstName: 'Rob',
  businessContext: 'a vintage guitar shop',
  hasSnapshot: false,
  regions: [],
  careers: [],
});

console.log('\n1. the persona survives');
check('Jarvis is the butler', /You are Jarvis/.test(prompt) && /butler/.test(prompt), true);
check('…with the dry wit, not goofy', /devilish and genuinely funny/.test(prompt) && /understated rather than goofy/.test(prompt), true);
check('…and the balance worldview, not hustle unto burnout', /all in balance/.test(prompt), true);
check('…and no preamble', /No preamble, no sign-off/.test(prompt), true);

// Rob, 2026-10-03: *"I remeber javis having more of a dry wit, he was legitimately funny and could be
// cutting but you know in that caring older brother kind of way he loves you hes like family"*, and on the
// fix: *"the bite is good when its with love"*.
//
// WHY THESE ARE SEPARATE CHECKS. The old base44 prompt had all of it — dry, witheringly bitchy, and the
// ribbing "because it comes from love". #148 restored only the wit, and its guard pinned the wit but NOT
// the affection: an edit could keep every asserted phrase and silently drop the love, leaving a Jarvis who
// is cutting without being kind. (This file used to say so out loud, in a comment claiming "it lands
// because they know you mean it" carried the old line's meaning. It did not — that is the softening this
// change reverses.) So the bite and the love are asserted independently, and neither can be traded for
// the other.
check('he loves them like family, not just backs them', /you love them like family/.test(prompt), true);
check('…the wit has real bite, not softened away', /with real bite/.test(prompt), true);
check('…and he can be withering about a bad idea', /withering about a bad idea/.test(prompt), true);
check('…but the ribbing is explicitly dry, never cruel', /Sarcasm and gentle ribbing are encouraged — dry, never cruel — because it comes from love/.test(prompt), true);

// Rob, 2026-10-03: *"Fixed set of carrers"* — and then the list, 36 of them, given verbatim.
//
// WHY THE WHOLE LIST AND NOT A SAMPLE. This repo's recurring failure is a constraint that silently
// disappears: a prompt is prose, prose does not throw, and a list is exactly the thing an edit trims
// without anyone noticing. Asserting three of thirty-six would let the other thirty-three go in a
// refactor with every check still green. So the persona's list is PARSED and compared to the full set,
// in order — which also makes dropping or renaming a single entry a failure, not a judgement call.
//
// 2026-10-04: the names are no longer written in the persona. They are rendered from the register in
// `server/src/lib/jarvisCareers.js`, so this check reads the BUILT prompt rather than the source file
// — which is the stronger assertion anyway, because it also proves the interpolation still happens.
// The full set is imported from the register, and the register's own integrity (every key carded or
// deliberately not, one copy of the list) is scripts/verify-jarvis-careers.mjs.
const listed = (builtPrompt.match(/every one of them — ([^.]+)\./) || [, ''])[1].split(', ').map((s) => s.trim());
check(`all ${CAREER_KEYS.length} careers are present, in order, none quietly trimmed`, listed, CAREER_KEYS);
check('…and he is told to name the hat he is wearing', /name the hat you're wearing/.test(prompt), true);
check('…and to wear the odd ones as straight as the sensible ones', /wear the odd ones as straight as the sensible ones/.test(prompt), true);
check('…and NOT to bluff past the list', /rather than bluffing/.test(prompt), true);

console.log('\n2. the two constraints the rewrite dropped are back');
// Load-bearing: reply LENGTH is the biggest lever on how fast the whole thing feels, and the old prompt
// tied it to being spoken aloud — which is the thing the new one had stopped doing.
check('replies stay short enough to speak aloud', /short enough to speak aloud/.test(prompt), true);
check('…and the old rule of thumb is named', /one to four sentences/.test(prompt), true);
check('a clarifying question is a last resort', /clarifying question only when it genuinely changes your answer/.test(prompt), true);

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
