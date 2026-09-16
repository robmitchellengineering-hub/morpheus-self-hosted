// Jarvis — Command Deck's AI persona (later phase). A plain conversation
// grounded in a live snapshot of the caller's Deck* data, NOT a fork of
// chatWithMorpheus.js: no plannedFiles/fileOperations, no reviewer/coder
// stages, no NDJSON stage streaming — those all exist to build app code,
// which has nothing to do with a life/business chat. This reuses only the
// low-level plumbing (invokeAI) and returns a plain JSON { reply }, same as
// any other simple function (see functions.routes.js — a handler that just
// returns a value gets `res.json(result)` for free).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';

const HISTORY_TURNS = 12; // recent turns folded into the prompt as conversation context
const MAX_REPLY_TOKENS = 900;

const REPAIR_STAGE_LABEL = { waiting: 'Waiting', in_progress: 'In progress', done: 'Done' };
const MURBAH_STAGE_LABEL = { idea: 'Idea', enquired: 'Enquired', booked: 'Booked', active: 'Active' };
const INBOX_STAGE_LABEL = { new: 'New', replied: 'Replied', done: 'Done' };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function buildSnapshot(userId) {
  const where = { created_by_id: userId };
  const [
    dump, people, tasks, consignment, repairs, murbah, inbox,
    strategy, knowledge, lifeStreams, lifeStreamNotes, energyLog, focusEntries,
  ] = await Promise.all([
    prisma.deckDumpItem.findMany({ where, orderBy: { created_date: 'desc' }, take: 20 }),
    prisma.deckPerson.findMany({ where }),
    prisma.deckTask.findMany({ where }),
    prisma.deckConsignmentItem.findMany({ where }),
    prisma.deckRepairJob.findMany({ where }),
    prisma.deckMurbahOpportunity.findMany({ where }),
    prisma.deckInboxItem.findMany({ where }),
    prisma.deckStrategyNote.findMany({ where, take: 20 }),
    prisma.deckKnowledgeNote.findMany({ where, take: 20 }),
    prisma.deckLifeStream.findMany({ where }),
    prisma.deckLifeStreamNote.findMany({ where, take: 40 }),
    prisma.deckEnergyLogEntry.findMany({ where, orderBy: { date: 'desc' }, take: 14 }),
    prisma.deckFocusEntry.findMany({ where, orderBy: { date: 'desc' }, take: 1 }),
  ]);

  const personName = (id) => people.find((p) => p.id === id)?.name || 'unassigned';
  const openTasks = tasks.filter((t) => !t.done);
  const unsoldConsign = consignment.filter((c) => !c.sold);
  const consignValue = unsoldConsign.reduce((s, c) => s + c.price, 0);
  const openRepairs = repairs.filter((r) => r.stage !== 'done');
  const openInbox = inbox.filter((i) => i.stage !== 'done');
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
ENERGY LOG, LAST 14 DAYS (most recent first): ${recentEnergy || 'no history yet'}
TODAY'S ONE THING: ${focusToday?.text || 'not set'}

OPEN TASKS (${openTasks.length}): ${openTasks.map((t) => `[${personName(t.owner_person_id)}${t.energy && t.energy !== 'any' ? `, fits ${t.energy}` : ''}] ${t.text}`).join('; ') || 'none'}

STRATEGY NOTES (${strategy.length}): ${strategy.map((s) => s.text).join('; ') || 'none'}

KNOWLEDGE / IDEAS (${knowledge.length}): ${knowledge.map((k) => k.text).join('; ') || 'none'}

CONSIGNMENT: ${unsoldConsign.length} unsold items worth $${consignValue} on the floor
REPAIRS QUEUE: ${openRepairs.length} open jobs (${openRepairs.map((r) => `${r.item} [${REPAIR_STAGE_LABEL[r.stage] || r.stage}]`).join(', ') || 'none'})
MURBAH OPPORTUNITIES: ${murbah.map((m) => `${m.title} — ${MURBAH_STAGE_LABEL[m.stage] || m.stage}`).join('; ') || 'none'}
INBOX (${openInbox.length} not yet done): ${openInbox.map((i) => `[${i.channel}] ${i.from_name}: ${i.message} (${INBOX_STAGE_LABEL[i.stage] || i.stage})`).join('; ') || 'none'}
UNSORTED BRAIN DUMP (${dump.length}): ${dump.map((d) => d.text).join('; ') || 'none'}

LIFE STREAMS (outside the shop): ${lifeStreamsText}
`.trim();
}

const JARVIS_SYSTEM_PROMPT = `You are Jarvis, a sharp, warm, practical advisor for someone with ADHD who runs Valiant Music, a one-person vintage guitar shop, aiming for $100k profit on 30 hrs/week. You're looking at a live snapshot of his brain dump, tasks, strategy notes, knowledge/ideas, consignment stock, repairs queue, Murbah property opportunities, his energy log over the last 14 days, and his life streams outside the shop (health, money, home, people, growth).

Answer whatever he actually asks, grounded in that snapshot — connect the dots across business and life where it's relevant, flag anything stale or that could make money fast, and if the energy log shows a real pattern worth naming, name it plainly like a good colleague would (never diagnose or moralise). Be direct and specific, not generic boilerplate. Match your reply's length to the question: a quick question gets a quick answer, not a forced 3-5 bullet report. No preamble, no sign-off.`;

export default async function handler({ user, body }) {
  const message = (body?.message || '').trim();
  if (!message) throw Object.assign(new Error('message is required'), { status: 400 });

  const [snapshot, history] = await Promise.all([
    buildSnapshot(user.id),
    prisma.deckJarvisMessage.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: HISTORY_TURNS,
    }),
  ]);
  history.reverse();

  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'user', content: message } });

  const conversationBlock = history.length
    ? history.map((m) => `${m.role === 'user' ? 'Rob' : 'Jarvis'}: ${m.content}`).join('\n')
    : '(no prior conversation)';

  const prompt = `${JARVIS_SYSTEM_PROMPT}

DATA SNAPSHOT:
${snapshot}

RECENT CONVERSATION:
${conversationBlock}

Rob: ${message}
Jarvis:`;

  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS });

  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: reply } });

  return { reply };
}
