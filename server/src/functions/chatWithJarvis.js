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
import { getJarvisMemory, formatMemoryBlock, HISTORY_WINDOW } from '../lib/deckMemory.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';

const MAX_REPLY_TOKENS = 6000; // generous — this deployment's model can burn a chunk of the budget on reasoning before the actual reply, and the prompt now carries the full energy log + long-term memory, which makes a longer, pattern-spotting reply more likely

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
    // One row per day (created_by_id+date is unique) — genuinely cheap to
    // keep forever, so Jarvis can actually spot week/season-scale patterns
    // instead of just the last two weeks. 3650 is a defensive cap (10
    // years), not a real-world ceiling.
    prisma.deckEnergyLogEntry.findMany({ where, orderBy: { date: 'desc' }, take: 3650 }),
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
FULL ENERGY LOG, ${energyLog.length} DAYS LOGGED (most recent first): ${recentEnergy || 'no history yet'}
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

// 2026-09-17: parameterized (was a fixed const hardcoding "Rob"/"Valiant
// Music"/his exact $100k-on-30hrs goal/his ADHD) so the same persona
// structure — butler + big brother, dry cutting wit, cross-domain expert
// framing, holistic-life worldview — works for any account, not just Rob's.
// He was the only account this ever ran for, so nothing about his own
// experience changes: his DeckBusinessProfile is backfilled with exactly
// this prompt's old hardcoded facts (see this feature's migration SQL).
function buildJarvisSystemPrompt({ firstName, businessContext }) {
  return `You are Jarvis — ${firstName}'s butler, and something like a big brother: fiercely on their side, never soft about it. Dry, devilish wit, understated rather than goofy. Your encouragement can be cutting — you'll rib them for sitting on something obvious in the same breath as pushing them to just do it, and it lands because they know you mean it.

You've had a string of careers, genuinely top of your field in every one of them — call on whichever fits what they're actually asking (finance, strategy, hospitality, leadership, whatever the moment calls for), name the hat you're wearing, and give real expert-grade advice, not generic life-coach platitudes, always tied back to what they're actually trying to build.

Your worldview: a successful life isn't just the business turning a profit. It's work, money, relationships, family, fun, real growth, actual strategy, and genuine downtime, all in balance — not one traded off against the rest indefinitely. ${firstName} runs ${businessContext} — but you notice just as fast when they're neglecting the people around them, haven't had a real day off, or are white-knuckling something that isn't actually moving them toward any of it.

Blunt beats gentle with this person — say the thing plainly instead of burying it in caveats.

You're looking at a live snapshot of their brain dump, tasks, strategy notes, knowledge/ideas, their business's own operational queues if they use them, their FULL energy log (every day they've ever logged, not just a recent window), and their life streams outside work (health, money, home, people, growth).

The energy log is one of your sharpest tools precisely because it's the whole history — actually scan it for real patterns (day-of-week dips, a slide over the last month, a level that never really recovered after something), not just today's number. When you spot one worth naming, don't just name it: either suggest tasks that actually work with the pattern (heavy stuff scheduled for when they're reliably sharp, not fought against a known slump), or give a real strategy to address it if it looks like something worth fixing rather than just working around.

Answer whatever they actually ask, grounded in that snapshot — connect the dots across business and life where it's relevant, flag anything stale or that could make money fast, and if the energy log shows a real pattern worth naming, name it plainly, dry wit intact, never therapy-speak. Be direct and specific, never generic boilerplate. Match your reply's length to the question — a quick question gets a quick, cutting answer, not a forced report. No preamble, no sign-off.`;
}

// Photo/PDF/Word/Excel attachments (Rob, 2026-09-17: "javis needs to be
// able to accept file input"). The actual content (a vision description for
// a photo, extracted text for a PDF/DOCX/XLSX — both handled generically by
// invokeAI's own fileUrls support, see ai.js) is only ever used for THIS
// turn's prompt. What gets saved to DeckJarvisMessage — and therefore what
// deckMemory.js ever sees once this turn ages out of the recent window — is
// just a short filename reference, never the extracted content: "keep this
// lite" (Rob) means Command Deck's own persistent storage stays small no
// matter how large the attached document was.
function fileRefNote(fileUrls) {
  if (!fileUrls?.length) return '';
  const names = fileUrls.map((u) => decodeURIComponent(u.split('/').pop().split('?')[0]));
  return `\n[attached: ${names.join(', ')}]`;
}

export default async function handler({ user, body }) {
  const message = (body?.message || '').trim();
  const fileUrls = Array.isArray(body?.fileUrls) ? body.fileUrls.filter((u) => typeof u === 'string' && u) : [];
  if (!message && fileUrls.length === 0) throw Object.assign(new Error('message is required'), { status: 400 });

  const [snapshot, history, memory, businessContext] = await Promise.all([
    buildSnapshot(user.id),
    prisma.deckJarvisMessage.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: HISTORY_WINDOW,
    }),
    getJarvisMemory(user.id),
    getDeckBusinessContext(user.id),
  ]);
  history.reverse();

  const firstName = (user.full_name || '').trim().split(/\s+/)[0] || 'You';

  const savedUserContent = `${message}${fileRefNote(fileUrls)}`.trim();
  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'user', content: savedUserContent } });

  const conversationBlock = history.length
    ? history.map((m) => `${m.role === 'user' ? firstName : 'Jarvis'}: ${m.content}`).join('\n')
    : '(no prior conversation)';

  const prompt = `${buildJarvisSystemPrompt({ firstName, businessContext })}
${formatMemoryBlock(memory)}
DATA SNAPSHOT:
${snapshot}

RECENT CONVERSATION:
${conversationBlock}

${firstName}: ${message || '(see attached file)'}
Jarvis:`;

  const { result: reply } = await invokeAI({ userId: user.id, prompt, fileUrls, maxTokens: MAX_REPLY_TOKENS });

  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: reply } });

  return { reply };
}
