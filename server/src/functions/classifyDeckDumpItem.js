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
import { CLASSIFY_SCHEMA, buildClassifyPrompt, normalizeClassifyResult, patternClassify } from '../lib/deckDumpClassify.js';

export default async function handler({ user, body }) {
  const text = (body?.text || '').trim();
  if (!text) throw Object.assign(new Error('text is required'), { status: 400 });

  const [businessContext, people] = await Promise.all([
    getDeckBusinessContext(user.id),
    // Names are fetched WITHOUT filtering to other people, because the code fast path needs to
    // recognise the speaker's own name too ("Rob needs to get bread" said by Rob). The PROMPT still
    // gets only other people — offering the speaker their own name invites the model to assign
    // everything to them. A failure to list people must not break capture, so this fails open to
    // "no assignable owners" rather than throwing — but it says so, because a silently empty list
    // would quietly stop owner assignment forever.
    prisma.deckPerson.findMany({ where: { created_by_id: user.id }, select: { name: true, is_self: true } })
      .catch((err) => {
        console.warn('[classifyDeckDumpItem] deck_people lookup failed — items will be filed without owner assignment:', err?.message || err);
        return [];
      }),
  ]);
  const peopleNames = people.filter((p) => !p.is_self).map((p) => p.name);
  const selfNames = people.filter((p) => p.is_self).map((p) => p.name);

  // THE EXPLICIT CASES NEVER REACH THE MODEL — see patternClassify. "I need to get cheese" is a task
  // by the prompt's own rule, and eight measured calls show the model spends its entire output budget
  // (4000, then 8000) deliberating about exactly that kind of sentence, for 18-34 seconds, before
  // either falling back or filing it as knowledge. Deciding it here is instant, identical every time
  // and free; the model keeps the dumps that need judgement.
  const decided = patternClassify(text, { people: peopleNames, selfNames });
  if (decided) {
    console.log(`[classifyDeckDumpItem] decided in code — explicit action phrasing, single thought — no model call (${decided.length} item(s))`);
    return { items: decided, destination: decided[0].destination, life_stream_key: decided[0].life_stream_key, decidedBy: 'pattern' };
  }

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
  //
  // MEASURED 2026-09-28, AND 4000 WAS NOT ENOUGH: the one `classify` call since the cap was
  // raised (2026-09-27 20:48) ended at `out=4000` from a 962-token prompt after 18.98s — the whole
  // budget, on a 27-character dump. Rob's report ("brain dump is not filing") is that call: it
  // truncated, threw, and the dump landed in the unsorted pile. (1) Raising the cap again is the
  // move this was already tried with, and a bigger budget buys the model more *thinking*, not more
  // classification. (2) A truncated LIST is not a truncated answer: the items already written are
  // complete, so `salvagePartial` recovers them and `normalizeClassifyResult`'s coverage guard
  // files whatever the answer did not reach.
  //
  // MEASURED 2026-10-01, AND (2) IS NOT ENOUGH ON ITS OWN. Rob again: "the brain dump keeps filing
  // files to unfiled ... that's a just in case so you can file it manually". The pile is the ONLY
  // fallback the frontend has, and its only creator is the catch around this call (checked:
  // CommandDeckContext.jsx has the sole DeckDumpItem.create in the codebase). Reading
  // `usage_events` for the last four brain-dump calls: **every one of them ended at exactly
  // out=4000 from a ~961-token prompt after ~18-19s**, and three logged OUTPUT_TRUNCATED *after*
  // #390 landed. So the model spends the entire budget thinking and sometimes never emits a single
  // complete item, which leaves `salvageJson` nothing to recover and rethrows — four for four.
  //
  // AND THAT, ON A 963-TOKEN PROMPT, IS THE WRONG BUDGET — measured again 2026-10-01 12:41Z and 12:43Z
  // on two six-word dumps ("I need to get cheese", "Rob needs to get bread"): in=961, out=4000, ~19s,
  // nothing salvageable, pile. Six for six. So the cost of a failure is not the reason to leave it.
  //
  // MODEL-DECISIONS.md records "do not fix a truncating SMALL call by raising its cap — the reasoning
  // tax was the cause". This is not a small call: it splits a dictation, decides actionable-vs-not per
  // thought, picks a life stream and resolves an owner. It was swept into the `classify` role, whose
  // other callers are booleans (~250-token prompts answering in 30-74 output tokens — measured). The
  // budget is raised from 4000 to 8000 for the same reason `diagnosis` went 1200 -> 8000 and was
  // recorded as FIXED by it, and with a decision rule declared in advance:
  //
  //   * calls now finish at out ≈ 100-500  -> the cap was the problem; leave it.
  //   * calls still end at exactly 8000    -> the model consumes whatever it is given, the cap is
  //     hopeless, and the next move is the PROMPT or the design (the instruction block is ~460 of the
  //     963 tokens) — not another cap.
  //
  // A larger cap costs nothing unless it is used: billing is on tokens actually produced.
  //
  // NO RETRY. #467 added one, and the very next dump settled it: "I need to get fruit" made TWO
  // calls 19 seconds apart, in=961, out=4000, out=4000 — the same prompt, two independent draws, the
  // identical saturation both times. The failure is a property of the prompt, not of the draw, so a
  // retry buys nothing and costs the operator another ~19 seconds of a capture that is supposed to be
  // thoughtless. It is gone.
  //
  // Whatever the cap does, the outcome is independent of the model: a failure here may NEVER hand the
  // dump back to the operator as a manual chore. One call, and then the deterministic fallback that
  // already exists (`normalizeClassifyResult` with no result files the whole dump to Knowledge and
  // marks it `nothing-classified`, which the card reports as "I could not classify it, so your words
  // are in there whole"). The pile goes back to meaning what Rob says it means: the last resort for
  // when Morpheus cannot be reached at all.
  let result = null;
  let truncated = false;
  try {
    ({ result, truncated } = await invokeAI({
      userId: user.id, prompt, schema: CLASSIFY_SCHEMA, role: 'classify', maxTokens: 8000, salvagePartial: true,
    }));
  } catch (aiErr) {
    // NOT A THROW. The words are the valuable part and they are still in hand, so the dump is filed
    // as one unclassified item and the operator is told which it was — never left to file it by hand.
    console.warn('[classifyDeckDumpItem] classification failed — filing the whole dump as one unclassified item rather than the unsorted pile:', aiErr?.message || aiErr);
    result = null;
    truncated = true;
  }

  const items = normalizeClassifyResult(result, text, peopleNames);

  // The truncation has to say so somewhere: the previous three rounds of this were diagnosed from
  // the container log hours later, by inferring it from `output_tokens == maxTokens`. Now it names
  // itself, with how much survived.
  if (truncated) {
    console.warn(`[classifyDeckDumpItem] the classification hit the maxTokens cap — recovered the complete prefix (${items.length} item(s) before the coverage guard); the rest of the dump is filed whole rather than dropped.`);
  }

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
