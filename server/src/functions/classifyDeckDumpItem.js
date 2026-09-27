// Brain dump's actual promise ("otherwise Jarvis files it where it
// belongs") — a text gets classified into where it actually belongs: a task, a
// strategy note, a knowledge/idea note, or a life-stream note
// (health/money/home/people/growth). Called synchronously from addDump before
// the item is saved anywhere, so a dump entry lands directly in the right place
// instead of sitting in an "unsorted" pile waiting on a manual tap — the same
// "capture without thinking, Jarvis handles the rest" principle the
// owner-detection path already has.
//
// A dictated dump is usually SEVERAL thoughts in one breath, so this returns a
// LIST: each item with its own destination and its own owner. The splitting,
// validation and no-content-lost guards live in lib/deckDumpClassify.js, which
// is dependency-free and asserted by scripts/verify-dump-classify.mjs.
import { invokeAI } from '../ai.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { prisma } from '../db.js';
import { CLASSIFY_SCHEMA, buildClassifyPrompt, normalizeClassifyResult } from '../lib/deckDumpClassify.js';

export default async function handler({ user, body }) {
  const text = (body?.text || '').trim();
  if (!text) throw Object.assign(new Error('text is required'), { status: 400 });

  const [businessContext, people] = await Promise.all([
    getDeckBusinessContext(user.id),
    // Only OTHER people — the speaker's own to-dos need no owner hint, and
    // offering their own name invites the model to assign everything to them.
    // A failure to list people must not break capture, so this fails open to
    // "no assignable owners" rather than throwing — but it says so, because a
    // silently empty list would quietly stop owner assignment forever.
    prisma.deckPerson.findMany({ where: { created_by_id: user.id, is_self: false }, select: { name: true } })
      .catch((err) => {
        console.warn('[classifyDeckDumpItem] deck_people lookup failed — items will be filed without owner assignment:', err?.message || err);
        return [];
      }),
  ]);
  const peopleNames = people.map((p) => p.name);

  const prompt = buildClassifyPrompt({ text, businessContext, peopleNames });

  // A budget, not a target: nothing is billed for headroom that goes unused, and the
  // failure this prevents is expensive. `role: 'classify'` was the fix for the first
  // round of truncations (the call used to name no role and resolved to the platform
  // default), and an earlier comment here claimed the classify role had "no
  // hidden-reasoning tax to eat the budget in the first place" — which is not true of
  // this platform, and the cap of 1200 stayed low because of it. Measured on
  // 2026-09-27: of the four `classify` calls in the preceding 14 days, THREE ended at
  // exactly 1200 output tokens with `OUTPUT_TRUNCATED (role=classify, maxTokens=1200)`
  // in the container log — i.e. after the role was named, on most calls, the model was
  // still cut off mid-answer. The platform's own message says why: "the role runs on a
  // reasoning model, whose thinking is billed against this same limit".
  //
  // Why it matters more here than the wasted call: `invokeAI` THROWS on a truncated
  // completion, so the handler fails and the client's catch files the WHOLE dump to one
  // owner via the name regex — the per-thought split this classifier exists to provide,
  // silently reverted, with a name in the text dragging every thought onto that person.
  // The answer itself is a short list (<= MAX_ITEMS entries), so ~4000 leaves the
  // reasoning several thousand tokens of room while keeping the dictation path quick.
  const { result } = await invokeAI({ userId: user.id, prompt, schema: CLASSIFY_SCHEMA, role: 'classify', maxTokens: 4000 });

  const items = normalizeClassifyResult(result, text, peopleNames);

  // Both shapes are returned on purpose. The frontend (Netlify) and this server
  // (Northflank) deploy independently, so a frontend still running the previous
  // build keeps working: it reads `destination`/`life_stream_key` and files the
  // whole text to one place, exactly as before. The new build prefers `items`.
  // Dropping the legacy fields would silently route every dump to the Knowledge
  // fallback during that window.
  return {
    items,
    destination: items[0].destination,
    life_stream_key: items[0].life_stream_key,
  };
}
