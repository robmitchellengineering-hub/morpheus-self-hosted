// Builds the single live snapshot of a user's whole Deck — brain dump,
// tasks, strategy/knowledge notes, business operational queues, energy log,
// life streams — that both chatWithJarvis.js's ordinary conversation and
// runJarvisSynthesis.js's one-shot "connect the dots" card ground themselves
// in. Pulled out of chatWithJarvis.js so the two never drift into building
// their own, slightly different pictures of the same data.
import { prisma } from '../db.js';
import { excerpt, INBOX_IN_PROMPT, REPAIRS_IN_PROMPT } from './promptBounds.js';

const REPAIR_STAGE_LABEL = { waiting: 'Waiting', in_progress: 'In progress', done: 'Done' };
const MURBAH_STAGE_LABEL = { idea: 'Idea', enquired: 'Enquired', booked: 'Booked', active: 'Active' };
const INBOX_STAGE_LABEL = { new: 'New', replied: 'Replied', done: 'Done' };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function buildDeckSnapshot(userId) {
  const where = { created_by_id: userId };
  const [
    dump, people, tasks, unsoldConsignCount, consignAgg, repairs, repairsOpenTotal, owedCount, owedAgg, owedIncomplete, murbah, inbox, inboxOpenTotal,
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
    // Bounded like the inbox: the newest open jobs, with the true open count fetched separately.
    // The queue is the work, so it stays in the prompt; only its length is bounded.
    prisma.deckRepairJob.findMany({ where: { ...where, stage: { not: 'done' } }, orderBy: { created_date: 'desc' }, take: REPAIRS_IN_PROMPT }),
    prisma.deckRepairJob.count({ where: { ...where, stage: { not: 'done' } } }),
    // What is owed to consignors: sold, not yet paid out. The fee is stored per item (see
    // schema.prisma), so this is a sum rather than a re-derivation of the tiered rule.
    prisma.deckConsignmentItem.count({ where: { ...where, sold: true, paid_out: false } }),
    // What is actually owed to a consignor is the sale price MINUS our commission, not the
    // commission itself: `fee` is the shop's cut, derived once when the sale was recorded from the
    // account's own fee structure (src/pages/CommandDeck/feeTiers.js — settings-driven since
    // 2026-09-28, 30% to $2000/20% above by default). It is READ BACK here, never re-derived: the
    // rule can change, the money agreed with a consignor cannot. Summing `fee` here would have
    // reported our own earnings as money owed to someone else — wrong by the full sale value, and
    // Jarvis quotes this line to Rob as fact.
    //
    // Rows missing either half cannot contribute an amount, so they are excluded from the sum and
    // counted separately: "$0 owed" and "nothing recorded yet" must never look the same (H13).
    prisma.deckConsignmentItem.aggregate({
      where: { ...where, sold: true, paid_out: false, sold_price: { not: null }, fee: { not: null } },
      _sum: { sold_price: true, fee: true },
    }),
    prisma.deckConsignmentItem.count({
      where: {
        ...where,
        sold: true,
        paid_out: false,
        OR: [{ sold_price: null }, { fee: null }],
      },
    }),
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
  const openRepairs = repairs; // already filtered to open by the bounded query above
  const owedToConsignors = (owedAgg._sum.sold_price || 0) - (owedAgg._sum.fee || 0);
  const shortDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
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

CONSIGNMENT: ${unsoldConsign} unsold items worth $${consignValue} on the floor${owedCount ? `; $${owedToConsignors} owed to consignors on ${owedCount} sold item${owedCount === 1 ? '' : 's'}${owedIncomplete ? ` (${owedIncomplete} with no sale price or fee recorded, so that amount is short)` : ''}` : ''}
REPAIRS QUEUE: ${repairsOpenTotal} open${openRepairs.length < repairsOpenTotal ? ` (newest ${openRepairs.length} shown)` : ''}: ${openRepairs.map((r) => `${r.item} [${REPAIR_STAGE_LABEL[r.stage] || r.stage}]${r.quote ? ` quote $${r.quote}` : ''}${r.promised_date ? ` promised ${shortDate(r.promised_date)}` : ''}`).join('; ') || 'none'}
MURBAH OPPORTUNITIES: ${murbah.map((m) => `${m.title} — ${MURBAH_STAGE_LABEL[m.stage] || m.stage}`).join('; ') || 'none'}
INBOX (${inboxOpenTotal} not yet done${openInbox.length < inboxOpenTotal ? `, newest ${openInbox.length} shown` : ''}): ${openInbox.map((i) => `[${i.channel}] ${i.from_name}: ${excerpt(i.message)} (${INBOX_STAGE_LABEL[i.stage] || i.stage})`).join('; ') || 'none'}
UNSORTED BRAIN DUMP (${dump.length}): ${dump.map((d) => d.text).join('; ') || 'none'}

LIFE STREAMS (outside the shop): ${lifeStreamsText}
`.trim();
}
