// Builds the single live snapshot of a user's whole Deck — brain dump,
// tasks, strategy/knowledge notes, business operational queues, energy log,
// life streams — that both chatWithJarvis.js's ordinary conversation and
// runJarvisSynthesis.js's one-shot "connect the dots" card ground themselves
// in. Pulled out of chatWithJarvis.js so the two never drift into building
// their own, slightly different pictures of the same data.
//
// 2026-10-03: the RENDERING moved to lib/deckSnapshotText.js, which is import-free so
// scripts/verify-jarvis-snapshot-gate.mjs can assert the capped-list labels with fixture
// rows and no database. This file keeps the queries and passes the rows through. Every
// capped list now fetches its true total alongside the rows, so the heading can say how
// much of it is being shown — a capped list that reads as complete is a lie to the model.
import { prisma } from '../db.js';
import { INBOX_IN_PROMPT, REPAIRS_IN_PROMPT } from './promptBounds.js';
import { formatDeckSnapshot } from './deckSnapshotText.js';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function buildDeckSnapshot(userId) {
  const where = { created_by_id: userId };
  const [
    dump, dumpTotal, people, tasks, unsoldConsignCount, consignAgg, repairs, repairsOpenTotal, owedCount, owedAgg, owedIncomplete, murbah,
    inbox, inboxOpenTotal, strategy, strategyTotal, knowledge, knowledgeTotal, lifeStreams, lifeStreamNotes, lifeStreamNotesTotal,
    energyLog, energyLogTotal, focusEntries,
  ] = await Promise.all([
    prisma.deckDumpItem.findMany({ where, orderBy: { created_date: 'desc' }, take: 20 }),
    prisma.deckDumpItem.count({ where }),
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
    // The three note lists are capped with the same voice as repairs/inbox: newest N, and the
    // true total fetched so the heading says how many are not shown. Ordering is explicit
    // because "newest N shown" has to be true of the N that were fetched.
    prisma.deckStrategyNote.findMany({ where, orderBy: { created_date: 'desc' }, take: 20 }),
    prisma.deckStrategyNote.count({ where }),
    prisma.deckKnowledgeNote.findMany({ where, orderBy: { created_date: 'desc' }, take: 20 }),
    prisma.deckKnowledgeNote.count({ where }),
    prisma.deckLifeStream.findMany({ where }),
    prisma.deckLifeStreamNote.findMany({ where, orderBy: { created_date: 'desc' }, take: 40 }),
    prisma.deckLifeStreamNote.count({ where }),
    // One row per day (created_by_id+date is unique) — cheap, so the log goes back a long way and
    // Jarvis can spot week/season-scale patterns. 3650 is a defensive cap (10 years), not a
    // real-world ceiling, and the line now says so when it bites instead of claiming "FULL".
    prisma.deckEnergyLogEntry.findMany({ where, orderBy: { date: 'desc' }, take: 3650 }),
    prisma.deckEnergyLogEntry.count({ where }),
    prisma.deckFocusEntry.findMany({ where, orderBy: { date: 'desc' }, take: 1 }),
  ]);

  const ownerName = (id) => people.find((p) => p.id === id)?.name || 'unassigned';
  const today = todayKey();
  const todayEnergy = energyLog.find((e) => (e.date?.toISOString?.() || '').slice(0, 10) === today);
  const focusToday = focusEntries.find((f) => (f.date?.toISOString?.() || '').slice(0, 10) === today);

  return formatDeckSnapshot({
    todayEnergyLevel: todayEnergy?.level || null,
    focusTodayText: focusToday?.text || null,
    energyLog: { rows: energyLog, total: energyLogTotal },
    openTasks: tasks.filter((t) => !t.done).map((t) => ({ text: t.text, ownerName: ownerName(t.owner_person_id), energy: t.energy })),
    strategy: { rows: strategy, total: strategyTotal },
    knowledge: { rows: knowledge, total: knowledgeTotal },
    consignment: {
      unsoldCount: unsoldConsignCount,
      value: consignAgg._sum.price || 0,
      owedToConsignors: (owedAgg._sum.sold_price || 0) - (owedAgg._sum.fee || 0),
      owedCount,
      owedIncomplete,
    },
    repairs: { rows: repairs, total: repairsOpenTotal },
    murbah,
    inbox: { rows: inbox, total: inboxOpenTotal },
    dump: { rows: dump, total: dumpTotal },
    lifeStreams,
    lifeStreamNotes: { rows: lifeStreamNotes, total: lifeStreamNotesTotal },
  });
}
