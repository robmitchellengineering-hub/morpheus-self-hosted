// Builds the single live snapshot of a user's whole Deck — brain dump,
// tasks, strategy/knowledge notes, business operational queues, energy log,
// life streams — that both chatWithJarvis.js's ordinary conversation and
// runJarvisSynthesis.js's one-shot "connect the dots" card ground themselves
// in. Pulled out of chatWithJarvis.js so the two never drift into building
// their own, slightly different pictures of the same data.
import { prisma } from '../db.js';
import { excerpt, INBOX_IN_PROMPT } from './promptBounds.js';

const REPAIR_STAGE_LABEL = { waiting: 'Waiting', in_progress: 'In progress', done: 'Done' };
const MURBAH_STAGE_LABEL = { idea: 'Idea', enquired: 'Enquired', booked: 'Booked', active: 'Active' };
const INBOX_STAGE_LABEL = { new: 'New', replied: 'Replied', done: 'Done' };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function buildDeckSnapshot(userId) {
  const where = { created_by_id: userId };
  const [
    dump, people, tasks, unsoldConsignCount, consignAgg, repairs, murbah, inbox, inboxOpenTotal,
    strategy, knowledge, lifeStreams, lifeStreamNotes, energyLog, focusEntries,
  ] = await Promise.all([
    prisma.deckDumpItem.findMany({ where, orderBy: { created_date: 'desc' }, take: 20 }),
    prisma.deckPerson.findMany({ where }),
    prisma.deckTask.findMany({ where }),
    // Two numbers are all the snapshot renders from this table — "N unsold items worth $X".
    // It used to findMany the whole (unbounded) table on every Jarvis message to compute a
    // count and a sum, and throw the rows away. Same two numbers, no rows: this fetch grew
    // with the floor stock for nothing, and the floor stock is what the CRM work will grow.
    prisma.deckConsignmentItem.count({ where: { ...where, sold: false } }),
    prisma.deckConsignmentItem.aggregate({ where: { ...where, sold: false }, _sum: { price: true } }),
    prisma.deckRepairJob.findMany({ where }),
    prisma.deckMurbahOpportunity.findMany({ where }),
    // Newest open items only, with the true count fetched separately below: the inbox bodies are
    // the largest free text in the prompt, and a capped list must never read as the whole picture.
    // Rob's rule for this surface is "the opportunity he has not seen" — so the items stay, the
    // count stays, and only the length of each body is bounded. See lib/promptBounds.js.
    prisma.deckInboxItem.findMany({ where: { ...where, stage: { not: 'done' } }, orderBy: { created_date: 'desc' }, take: INBOX_IN_PROMPT }),
    prisma.deckInboxItem.count({ where: { ...where, stage: { not: 'done' } } }),
    prisma.deckStrategyNote.findMany({ where, take: 20 }),
    prisma.deckKnowledgeNote.findMany({ where, take: 20 }),
    prisma.deckLifeStream.findMany({ where }),
    prisma.deckLifeStreamNote.findMany({ where, take: 40 }),
    // One row per day (created_by_id+date is unique) — genuinely cheap to
    // keep forever, so Jarvis can actually spot week/season-scale patterns
    // instead of just the last two weeks. 3650 is a defensive cap (10
    // years), not a real-world ceiling.
    prisma.deckEnergyLogEntry.findMany({ where, orderBy: { date: 'desc' }, take: 3650 }),
    prisma.deckFocusEntry.findMany({ where, orderBy: { date: 'desc' }, take: 1 }),
  ]);

  const personName = (id) => people.find((p) => p.id === id)?.name || 'unassigned';
  const openTasks = tasks.filter((t) => !t.done);
  const unsoldConsign = unsoldConsignCount;
  const consignValue = consignAgg._sum.price || 0;
  const openRepairs = repairs.filter((r) => r.stage !== 'done');
  const openInbox = inbox; // already filtered to open by the bounded query above
  const today = todayKey();
  const todayEnergy = energyLog.find((e) => (e.date?.toISOString?.() || '').slice(0, 10) === today);
  const focusToday = focusEntries.find((f) => (f.date?.toISOString?.() || '').slice(0, 10) === today);
  const recentEnergy = energyLog
    .map((e) => `${(e.date?.toISOString?.() || '').slice(0, 10)}:${e.level}`)
    .join(', ');

  const lifeStreamsText = lifeStreams.map((s) => {
    const notes = lifeStreamNotes.filter((n) => n.life_stream_id === s.id).slice(0, 3).map((n) => n.text).join(' / ') || 'no notes';
    return `${s.stream_key} [${s.status === 'needs_work' ? 'NEEDS WORK' : 'ON'}]: ${notes}`;
  }).join('; ') || 'none tracked yet';

  return `
TODAY'S ENERGY: ${todayEnergy?.level || 'not set'}
FULL ENERGY LOG, ${energyLog.length} DAYS LOGGED (most recent first): ${recentEnergy || 'no history yet'}
TODAY'S ONE THING: ${focusToday?.text || 'not set'}

OPEN TASKS (${openTasks.length}): ${openTasks.map((t) => `[${personName(t.owner_person_id)}${t.energy && t.energy !== 'any' ? `, fits ${t.energy}` : ''}] ${t.text}`).join('; ') || 'none'}

STRATEGY NOTES (${strategy.length}): ${strategy.map((s) => s.text).join('; ') || 'none'}

KNOWLEDGE / IDEAS (${knowledge.length}): ${knowledge.map((k) => k.text).join('; ') || 'none'}

CONSIGNMENT: ${unsoldConsign} unsold items worth $${consignValue} on the floor
REPAIRS QUEUE: ${openRepairs.length} open jobs (${openRepairs.map((r) => `${r.item} [${REPAIR_STAGE_LABEL[r.stage] || r.stage}]`).join(', ') || 'none'})
MURBAH OPPORTUNITIES: ${murbah.map((m) => `${m.title} — ${MURBAH_STAGE_LABEL[m.stage] || m.stage}`).join('; ') || 'none'}
INBOX (${inboxOpenTotal} not yet done${openInbox.length < inboxOpenTotal ? `, newest ${openInbox.length} shown` : ''}): ${openInbox.map((i) => `[${i.channel}] ${i.from_name}: ${excerpt(i.message)} (${INBOX_STAGE_LABEL[i.stage] || i.stage})`).join('; ') || 'none'}
UNSORTED BRAIN DUMP (${dump.length}): ${dump.map((d) => d.text).join('; ') || 'none'}

LIFE STREAMS (outside the shop): ${lifeStreamsText}
`.trim();
}
