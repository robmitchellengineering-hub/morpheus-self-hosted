// Runtime verification for the Jarvis snapshot gate, the honest persona variants, the
// capped-list labels, and the manual synthesis's schema-bounded output.
//
// Dependency-free (pure modules, plus source assertions on the two handlers that need
// Prisma), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-jarvis-snapshot-gate.mjs
//
// WHY THIS EXISTS (2026-10-03, measured — Rob: "i just chatted with javis and it
// definitely wasnt fast"). Every Deck/Jarvis AI call named no role, so it took
// `default_model` (v4-pro) at the platform default temperature; in a 6-hour window five
// role-less calls averaged 41s and the worst was 61s. The prompt was 78% deck snapshot
// (≈2,400 tokens) and 22% persona (≈690), and the snapshot was built for EVERY message
// including "say hello to my sister". The manual "Get suggestions" path passed no schema,
// so it rambled to its 6000-token cap — 61s / 53s / 59s on three presses, all saturated,
// none stored.
//
// Four claims, each with a way to fail:
//
//   1. THE GATE'S FAILURE DIRECTION — only an explicit, usable `false` drops the
//      snapshot; a timeout, truncation, junk, a string or a missing field INCLUDES it.
//      A false "no deck needed" answers a real question blind; a false "deck needed"
//      costs tokens.
//   2. BOTH PERSONA VARIANTS ARE HONEST — the with-snapshot one may claim the snapshot,
//      the without-snapshot one must not, must say plainly it was not given one, and
//      must not carry the energy-log guidance that assumes it was.
//   3. EVERY CAPPED LIST SAYS SO, AND A COMPLETE LIST DOES NOT — asserted both ways,
//      including the energy log, whose persona used to promise "FULL … every day
//      they've ever logged" while the query capped it at 3650.
//   4. THE MANUAL SYNTHESIS IS BOUNDED BY ITS SHAPE AND STORES NOTHING ON A
//      TRUNCATION — it passes SCHEDULED_SCHEMA (the scheduled shape, not a second one)
//      and an explicit role, and `synthesisMessageToStore` refuses a truncated or
//      declined answer before anything reaches `deckJarvisMessage.create`.
//
// THE ROLE CHOSEN FOR MANUAL SYNTHESIS: `planner`. It is the one role whose resolved
// settings are exactly what the path already ran on — `default_planner_model` is
// deepseek-v4-pro, `default_planner_temperature` is 0.7 (the persona's decided config:
// persona and judgement stay on pro, Rob's call) — so naming it changes the model by
// nothing and makes the choice visible rather than accidental. Moving the persona to
// flash is explicitly NOT this change.
import { readFileSync } from 'node:fs';

import { formatDeckSnapshot, truncationNote, listCount } from '../server/src/lib/deckSnapshotText.js';
import { SNAPSHOT_NEED_SCHEMA, buildSnapshotNeedPrompt, shouldIncludeSnapshot } from '../server/src/lib/deckSnapshotGate.js';
import { buildJarvisSystemPrompt } from '../server/src/lib/jarvisPersona.js';
import { synthesisMessageToStore } from '../server/src/lib/deckInsightPayload.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Whole-line comments masked before any source assertion, so a regex cannot be satisfied
// by the comment that explains the fix.
const maskComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

// ── fixtures ─────────────────────────────────────────────────────────────────
const dt = (d) => new Date(`${d}T00:00:00.000Z`);
const fixture = () => ({
  todayEnergyLevel: 'high',
  focusTodayText: 'Ship the gate',
  energyLog: { rows: [{ date: dt('2026-10-03'), level: 'high' }], total: 1 },
  openTasks: [{ text: 'Call the sister', ownerName: 'Rob', energy: 'any' }],
  strategy: { rows: [{ text: 'strategy one' }], total: 1 },
  knowledge: { rows: [{ text: 'idea one' }], total: 1 },
  consignment: { unsoldCount: 0, value: 0, owedToConsignors: 0, owedCount: 0, owedIncomplete: 0 },
  repairs: { rows: [{ item: 'amp', stage: 'waiting' }], total: 1 },
  murbah: [],
  inbox: { rows: [{ channel: 'email', from_name: 'Sam', message: 'hello', stage: 'new' }], total: 1 },
  dump: { rows: [{ text: 'a thought' }], total: 1 },
  lifeStreams: [{ id: 's1', stream_key: 'health', status: 'on' }],
  lifeStreamNotes: { rows: [{ life_stream_id: 's1', text: 'slept badly' }], total: 1 },
});
// Every list capped: more rows exist than were fetched.
const capped = () => {
  const f = fixture();
  f.energyLog.rows = [f.energyLog.rows[0], { date: dt('2026-10-02'), level: 'low' }];
  f.energyLog.total = 4000;
  f.strategy.total = 37;
  f.knowledge.total = 22;
  f.dump.total = 100;
  f.lifeStreamNotes.total = 120;
  f.repairs.total = 8;
  f.inbox.total = 5;
  return f;
};

console.log('\n1. the gate FAILS OPEN — only an explicit, usable false drops the snapshot');
check('an explicit false drops it', shouldIncludeSnapshot({ needsSnapshot: false }), false);
check('an explicit true keeps it', shouldIncludeSnapshot({ needsSnapshot: true }), true);
check('undefined (a timeout or a throw that lost the result) keeps it', shouldIncludeSnapshot(undefined), true);
check('null keeps it', shouldIncludeSnapshot(null), true);
check('an empty object (the field is not required-shaped) keeps it', shouldIncludeSnapshot({}), true);
check('a string answer the parser could not use keeps it', shouldIncludeSnapshot('{"needsSnapshot":false}'), true);
check('the string "false" keeps it', shouldIncludeSnapshot({ needsSnapshot: 'false' }), true);
check('0 keeps it', shouldIncludeSnapshot({ needsSnapshot: 0 }), true);
check('an array keeps it', shouldIncludeSnapshot([{ needsSnapshot: false }]), true);
check('the schema requires the boolean field',
  SNAPSHOT_NEED_SCHEMA.required, ['needsSnapshot']);
check('…and says plainly that a wrong false is the dangerous direction',
  /wrong "false" leaves you answering blind/.test(buildSnapshotNeedPrompt('hey')), true);
check('the prompt carries the message it is judging',
  buildSnapshotNeedPrompt('say hello to my sister').includes('say hello to my sister'), true);

console.log('\n2. both persona variants are honest about what they contain');
const withSnapshot = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'Valiant Music', hasSnapshot: true });
const withoutSnapshot = buildJarvisSystemPrompt({ firstName: 'Rob', businessContext: 'Valiant Music', hasSnapshot: false });
check('the with-snapshot persona claims the snapshot', /You're looking at a live snapshot/.test(withSnapshot), true);
check('…including the energy log', /energy log \(every day they've logged/.test(withSnapshot), true);
check('…and the guidance that assumes it was given one', /sharpest tools/.test(withSnapshot), true);
check('the without-snapshot persona does NOT claim the snapshot',
  /You're looking at a live snapshot/.test(withoutSnapshot), false);
check('…says plainly it was not given one', /You have NOT been given a snapshot/.test(withoutSnapshot), true);
check('…and carries NO energy-log guidance that assumes one', /sharpest tools/.test(withoutSnapshot), false);
check('the two variants really differ', withSnapshot !== withoutSnapshot, true);
// The voice constraints the whole reply rests on must survive in BOTH variants.
for (const [label, text] of [['with', withSnapshot], ['without', withoutSnapshot]]) {
  check(`the ${label}-snapshot variant keeps the speakable-length rule`, /short enough to speak aloud/.test(text), true);
  check(`…and no preamble/sign-off`, /No preamble, no sign-off/.test(text), true);
  check(`…and is still Jarvis`, /You are Jarvis/.test(text), true);
}

console.log('\n3. every capped list says it is capped, and a complete list does not');
check('a complete list gets no truncation note', truncationNote(8, 8), '');
check('a capped list gets one, in the repairs/inbox voice', truncationNote(8, 12), ', newest 8 shown');
check('a complete heading is just its count', listCount(20, 20), '20');
check('a capped heading states the true total and the cap', listCount(20, 37), '37, newest 20 shown');

const cappedText = formatDeckSnapshot(capped());
const completeText = formatDeckSnapshot(fixture());
check('strategy notes are labelled', /STRATEGY NOTES \(37, newest 1 shown\)/.test(cappedText), true);
check('knowledge notes are labelled', /KNOWLEDGE \/ IDEAS \(22, newest 1 shown\)/.test(cappedText), true);
check('dump items are labelled', /UNSORTED BRAIN DUMP \(100, newest 1 shown\)/.test(cappedText), true);
check('life-stream notes are labelled', /LIFE STREAMS \(outside the shop — 120 notes, newest 1 shown\)/.test(cappedText), true);
check('repairs keep their label', /REPAIRS QUEUE: 8 open, newest 1 shown/.test(cappedText), true);
check('the inbox keeps its label', /INBOX \(5 not yet done, newest 1 shown\)/.test(cappedText), true);
check('the energy log says how many of how many', /ENERGY LOG, 2 DAYS LOGGED of 4000 \(newest 2 shown\)/.test(cappedText), true);
check('…and does NOT claim to be every day logged when it is not',
  /every day logged/.test(cappedText), false);
check('a complete energy log says it is the whole log',
  /ENERGY LOG, 1 DAY LOGGED \(every day logged, most recent first\)/.test(completeText), true);
check('a complete snapshot carries NO truncation note anywhere', /newest \d+ shown/.test(completeText), false);
check('…and a complete list heading is just its count', /STRATEGY NOTES \(1\)/.test(completeText), true);
check('a stream with more notes than it shows says how many it is holding back',
  formatDeckSnapshot({
    ...fixture(),
    lifeStreamNotes: {
      rows: [1, 2, 3, 4, 5].map((i) => ({ life_stream_id: 's1', text: `note ${i}` })),
      total: 5,
    },
  }).includes('(+2 more)'), true);

console.log('\n4. the manual synthesis is shape-bounded and stores nothing on a truncation');
check('a raised insight is stored as its interpreted text',
  synthesisMessageToStore({ result: { worthRaising: true, insight: 'Link A to B.' } }),
  { ok: true, content: 'Link A to B.' });
// The load-bearing one: a cut-off JSON object can still parse, so truncation must win
// over a valid-looking result rather than being inferred from how the payload reads.
check('a TRUNCATED completion stores nothing, even when the payload looks complete',
  synthesisMessageToStore({ result: { worthRaising: true, insight: 'Link A to B.' }, truncated: true }),
  { ok: false, reason: 'truncated' });
check('…and carries no content field at all',
  Object.prototype.hasOwnProperty.call(
    synthesisMessageToStore({ result: { worthRaising: true, insight: 'Link A to B.' }, truncated: true }), 'content'),
  false);
check('a decline stores nothing',
  synthesisMessageToStore({ result: { worthRaising: false, insight: 'anything' } }),
  { ok: false, reason: 'nothing-to-raise' });
check('an empty insight stores nothing',
  synthesisMessageToStore({ result: { worthRaising: true, insight: '   ' } }),
  { ok: false, reason: 'nothing-to-raise' });
check('an unusable payload stores nothing',
  synthesisMessageToStore({ result: 'not json at all' }),
  { ok: false, reason: 'unparseable' });
check('an absent payload stores nothing',
  [synthesisMessageToStore({}).ok, synthesisMessageToStore({}).content], [false, undefined]);

const synthSrc = maskComments(read('server/src/functions/runJarvisSynthesis.js'));
const manualAt = synthSrc.indexOf('const prompt = `${buildManualPrompt');
check('the manual branch was found (parser sanity)', manualAt > 0, true);
const manual = synthSrc.slice(manualAt);
check('the manual path passes the SCHEDULED schema, not a second shape',
  /schema: SCHEDULED_SCHEMA/.test(manual), true);
check('…and an explicit role, not the platform default', /role: 'planner'/.test(manual), true);
check('…and it is not the draft role, which is for inbox/doc text generation',
  /role: 'draft'/.test(manual), false);
check('the manual path decides through synthesisMessageToStore', /synthesisMessageToStore\(/.test(manual), true);
check('…and stores the DECISION, never the raw result', /content: decision\.content/.test(manual), true);
check('…so a truncated reply cannot be stored', /content: reply/.test(synthSrc), false);
check('a truncation is caught and named for the operator', /OUTPUT_TRUNCATED/.test(manual), true);

console.log('\n5. the handler actually wires the gate, both ways');
const chatSrc = maskComments(read('server/src/functions/chatWithJarvis.js'));
check('it asks the snapshot-need gate', /classifySnapshotNeed\(user\.id, message\)/.test(chatSrc), true);
check('…with the classify role on the hot path', /schema: SNAPSHOT_NEED_SCHEMA, role: 'classify'/.test(chatSrc), true);
check('…and a failed gate INCLUDES the snapshot', /snapshot-need check failed — including the snapshot/.test(chatSrc) && /return true;/.test(chatSrc), true);
check('the snapshot is fetched only when the gate says so',
  /const snapshot = includeSnapshot \? await buildDeckSnapshot\(user\.id\) : '';/.test(chatSrc), true);
check('…and the persona is built from the SAME decision',
  /buildJarvisSystemPrompt\(\{ firstName, businessContext, hasSnapshot: includeSnapshot \}\)/.test(chatSrc), true);
check('…so the data and the words about the data cannot disagree',
  /includeSnapshot \? `DATA SNAPSHOT:\\n\$\{snapshot\}\\n` : ''/.test(chatSrc), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
