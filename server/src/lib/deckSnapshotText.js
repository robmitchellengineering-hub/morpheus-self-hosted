// The rendering half of the Deck snapshot: already-fetched rows in, the ground-truth
// text Jarvis reads out. `deckSnapshot.js` keeps the queries and calls this.
//
// WHY THIS IS ITS OWN MODULE
//
// `scripts/verify-jarvis-snapshot-gate.mjs` has to assert the one rule that matters
// about a capped list — that it SAYS it is capped — with fixture rows and no database.
// Importing `deckSnapshot.js` would drag in Prisma, so the guard could not run in CI's
// no-install guards job at all. Same reason `deckMemoryText.js` / `deckInsightPayload.js`
// exist as separate import-free modules: a guard that cannot run is not a pass.
//
// WHY THE CAPS ARE LABELLED (2026-10-03)
//
// `REPAIRS QUEUE` and `INBOX` already stated their true count and said "newest N shown"
// when the list was cut. The other capped lists — brain dump (20), strategy notes (20),
// knowledge notes (20), life-stream notes (40) and the energy log (3650) — did NOT, so a
// capped list read to the model as the whole picture. That is a lie told to the model,
// and for the energy log the persona stated the false promise in words ("their FULL
// energy log (every day they've ever logged)"). Every capped list now carries the same
// note, and a complete list carries none — both directions are asserted.
//
// THE ENERGY-LOG DECISION: label it honestly, do not uncap it. One row per day is cheap,
// but the take is what bounds the prompt at a history-proportional size, and
// `verify-deck-snapshot.mjs` exists precisely to make a new unbounded fetch in this path
// a deliberate act. So the true total is fetched, the line says which of how many it is
// showing, and the persona no longer claims completeness in the first place.

import { excerpt } from './promptBounds.js';

const REPAIR_STAGE_LABEL = { waiting: 'Waiting', in_progress: 'In progress', done: 'Done' };
const MURBAH_STAGE_LABEL = { idea: 'Idea', enquired: 'Enquired', booked: 'Booked', active: 'Active' };
const INBOX_STAGE_LABEL = { new: 'New', replied: 'Replied', done: 'Done' };

/**
 * ", newest N shown" when a list was capped, and NOTHING when it was not.
 *
 * The negative direction is as load-bearing as the positive one: a complete list must
 * not carry a truncation note, or the note stops meaning anything.
 */
export function truncationNote(shown, total) {
  return total > shown ? `, newest ${shown} shown` : '';
}

/** A list heading's count: "37, newest 20 shown" when capped, "7" when complete. */
export function listCount(shown, total) {
  return `${total}${truncationNote(shown, total)}`;
}

const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const notes = (n) => `${n} note${n === 1 ? '' : 's'}`;

/**
 * The snapshot text. Every list is `{ rows, total }` so the heading can say how much of
 * it is being shown; an unbounded collection (`tasks`, `murbah`) is a bare array.
 *
 * @param {{
 *   todayEnergyLevel?: string|null,
 *   focusTodayText?: string|null,
 *   energyLog: {rows: Array<{date: Date|string, level: string}>, total: number},
 *   openTasks: Array<{text: string, ownerName: string, energy?: string|null}>,
 *   strategy: {rows: Array<{text: string}>, total: number},
 *   knowledge: {rows: Array<{text: string}>, total: number},
 *   consignment: {unsoldCount: number, value: number, owedToConsignors: number, owedCount: number, owedIncomplete: number},
 *   repairs: {rows: Array<{item: string, stage: string, quote?: number|null, promised_date?: Date|string|null}>, total: number},
 *   murbah: Array<{title: string, stage: string}>,
 *   inbox: {rows: Array<{channel: string, from_name: string, message: string, stage: string}>, total: number},
 *   dump: {rows: Array<{text: string}>, total: number},
 *   lifeStreams: Array<{id: string, stream_key: string, status: string}>,
 *   lifeStreamNotes: {rows: Array<{life_stream_id: string, text: string}>, total: number},
 * }} input
 * @returns {string}
 */
export function formatDeckSnapshot({
  todayEnergyLevel,
  focusTodayText,
  energyLog,
  openTasks,
  strategy,
  knowledge,
  consignment,
  repairs,
  murbah,
  inbox,
  dump,
  lifeStreams,
  lifeStreamNotes,
}) {
  const energyShown = energyLog.rows.length;
  const energyCapped = energyLog.total > energyShown;
  const recentEnergy = energyLog.rows
    .map((e) => `${day(e.date)}:${e.level}`)
    .join(', ');
  const energyLine = `ENERGY LOG, ${energyShown} DAY${energyShown === 1 ? '' : 'S'} LOGGED${
    energyCapped ? ` of ${energyLog.total} (newest ${energyShown} shown)` : ' (every day logged, most recent first)'
  }`;

  // Each stream shows at most three of the notes we were given; when a stream has more
  // than that in hand, the line says how many it is holding back.
  const NOTES_PER_STREAM = 3;
  const lifeStreamsText = lifeStreams.map((s) => {
    const all = lifeStreamNotes.rows.filter((n) => n.life_stream_id === s.id);
    const shown = all.slice(0, NOTES_PER_STREAM).map((n) => n.text).join(' / ') || 'no notes';
    const more = all.length > NOTES_PER_STREAM ? ` (+${all.length - NOTES_PER_STREAM} more)` : '';
    return `${s.stream_key} [${s.status === 'needs_work' ? 'NEEDS WORK' : 'ON'}]: ${shown}${more}`;
  }).join('; ') || 'none tracked yet';

  return `
TODAY'S ENERGY: ${todayEnergyLevel || 'not set'}
${energyLine}: ${recentEnergy || 'no history yet'}
TODAY'S ONE THING: ${focusTodayText || 'not set'}

OPEN TASKS (${openTasks.length}): ${openTasks.map((t) => `[${t.ownerName}${t.energy && t.energy !== 'any' ? `, fits ${t.energy}` : ''}] ${t.text}`).join('; ') || 'none'}

STRATEGY NOTES (${listCount(strategy.rows.length, strategy.total)}): ${strategy.rows.map((s) => s.text).join('; ') || 'none'}

KNOWLEDGE / IDEAS (${listCount(knowledge.rows.length, knowledge.total)}): ${knowledge.rows.map((k) => k.text).join('; ') || 'none'}

CONSIGNMENT: ${consignment.unsoldCount} unsold items worth $${consignment.value} on the floor${consignment.owedCount ? `; $${consignment.owedToConsignors} owed to consignors on ${consignment.owedCount} sold item${consignment.owedCount === 1 ? '' : 's'}${consignment.owedIncomplete ? ` (${consignment.owedIncomplete} with no sale price or fee recorded, so that amount is short)` : ''}` : ''}
REPAIRS QUEUE: ${repairs.total} open${truncationNote(repairs.rows.length, repairs.total)}: ${repairs.rows.map((r) => `${r.item} [${REPAIR_STAGE_LABEL[r.stage] || r.stage}]${r.quote ? ` quote $${r.quote}` : ''}${r.promised_date ? ` promised ${day(r.promised_date)}` : ''}`).join('; ') || 'none'}
MURBAH OPPORTUNITIES: ${murbah.map((m) => `${m.title} — ${MURBAH_STAGE_LABEL[m.stage] || m.stage}`).join('; ') || 'none'}
INBOX (${inbox.total} not yet done${truncationNote(inbox.rows.length, inbox.total)}): ${inbox.rows.map((i) => `[${i.channel}] ${i.from_name}: ${excerpt(i.message)} (${INBOX_STAGE_LABEL[i.stage] || i.stage})`).join('; ') || 'none'}
UNSORTED BRAIN DUMP (${listCount(dump.rows.length, dump.total)}): ${dump.rows.map((d) => d.text).join('; ') || 'none'}

LIFE STREAMS (outside the shop — ${notes(lifeStreamNotes.total)}${truncationNote(lifeStreamNotes.rows.length, lifeStreamNotes.total)}): ${lifeStreamsText}
`.trim();
}
