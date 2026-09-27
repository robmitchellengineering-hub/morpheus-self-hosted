// Pure logic for the brain-dump classifier — deliberately dependency-free so
// scripts/verify-dump-classify.mjs can assert it in CI's no-install guards job,
// the same way server/src/lib/selfDevDrift.js is verified.
//
// WHY THIS EXISTS
//
// Brain dump's promise is "Type it. Don't think." — and the input is dictation
// on a phone, which is the one input mode that produces several thoughts in one
// breath ("get milk, chase the Henderson quote, and I'm a bit stressed about
// money"). The original classifier took a SINGLE `destination`, so a dump like
// that was forced into exactly one bucket and the rest of the sentence was
// entombed inside it — a money worry filed as a task, or two real tasks filed
// as one knowledge note. Nothing errored; the context Jarvis is supposed to
// synthesise across just quietly never arrived.
//
// So classification now returns a LIST of items, each filed to its own
// destination and its own owner. Two guards keep that from losing anything:
// the model is told to preserve the speaker's own words, and normalize() falls
// back to the whole original text whenever the returned items don't cover it.

export const DESTINATIONS = ['task', 'strategy', 'knowledge', 'life_stream'];
export const LIFE_STREAM_KEYS = ['health', 'money', 'home', 'people', 'growth'];

// A dump is a brain dump, not a transcript — past this it is splitting into
// sentence fragments rather than distinct thoughts, which fragments a coherent
// note instead of filing it.
export const MAX_ITEMS = 8;

// Fraction of the original characters the returned items must account for — a
// backstop for a wholesale loss, not the main rule. Character coverage cannot tell a
// faithful split from a dropped SHORT thought: dropping "get milk" from
// "Book the kids into swimming, pay the rego, get milk" leaves 0.76, while a faithful
// three-item split of that same dump only reaches ~0.86, because the connectives go
// with the split. Those are ten points apart and the old 0.6 floor sat below both, so
// the check that exists to stop a thought being lost passed the case it was written
// for. `unrepresentedClause` below is the rule that actually holds.
const MIN_COVERAGE = 0.6;

// A clause shorter than this is a fragment ("oh also"), not a thought worth chasing.
const MIN_CLAUSE_CHARS = 8;

/** Words worth comparing: lowercase, punctuation dropped, two-letter noise ignored. */
const compareWords = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 3);

/**
 * The first substantive clause of the dump that no item accounts for, or null.
 *
 * The schema asks the model to copy the speaker's OWN WORDS, so a faithful split
 * represents every clause it was given — and a clause that survives no item is a
 * thought that was dropped. Compared by majority word overlap rather than exact
 * substring, because the model lightly rewrites ("book the kids into swimming" →
 * "book kids swimming") and an exact match would fire on every paraphrase.
 */
function unrepresentedClause(text, items) {
  const clauses = String(text)
    .split(/(?:[.;!?]+|,|\s+(?:and|also|plus|then)\s+)/i)
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_CLAUSE_CHARS);
  if (!clauses.length) return null;
  const itemWords = new Set(compareWords(items.map((i) => i.text).join(' ')));
  for (const clause of clauses) {
    const words = compareWords(clause);
    if (!words.length) continue;
    const missing = words.filter((w) => !itemWords.has(w));
    if (missing.length / words.length >= 0.5) return clause;
  }
  return null;
}

const DEFAULT_DESTINATION = 'knowledge';

// Why an item is the whole dump rather than a split of it. Both cases file the speaker's
// own words (that rule is absolute), but they mean different things to the operator, and
// without a marker the card said "Filed to Knowledge" for a dump the model could not
// classify at all — which reads exactly like a dump it classified successfully.
export const FALLBACK_NOTHING_CLASSIFIED = 'nothing-classified';
export const FALLBACK_INCOMPLETE = 'incomplete';

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// A list, not a single destination — see the header. Object-rooted with an
// array property, which is the shape every other schema in this codebase uses
// (chatWithMorpheus.js, autonomousBuildStep.js); a bare array root is not.
export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_ITEMS,
      description: 'One entry per distinct thought in the dump, in the order spoken. A single-thought dump returns a single entry.',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: "This item's own words, copied from the dump — not a summary, and no content from the other items.",
          },
          destination: {
            type: 'string',
            enum: DESTINATIONS,
            description: 'task = ANY concrete to-do, business or personal (get milk, book the kids into swimming, call a supplier, fix a pickup); strategy = a business plan/approach idea; knowledge = a fact, reference, or idea worth keeping that is not itself actionable; life_stream = a STATUS or REFLECTION note about health, money, home, relationships/people, or personal growth — not an action to take',
          },
          life_stream_key: {
            type: 'string',
            enum: LIFE_STREAM_KEYS,
            description: 'Only set when destination is life_stream — which of the five streams this belongs to.',
          },
          owner_name: {
            type: 'string',
            description: 'Only when the text explicitly hands this item to someone else by name. Omit entirely for the speaker\u2019s own to-dos.',
          },
        },
        required: ['text', 'destination'],
      },
    },
  },
  required: ['items'],
};

export function buildClassifyPrompt({ text, businessContext, peopleNames = [] }) {
  const names = peopleNames.filter((n) => collapse(n));
  const ownerBlock = names.length
    ? `\n\nPeople who can be assigned a task (ONLY use these exact names): ${names.map((n) => `"${collapse(n)}"`).join(', ')}. Set owner_name on an item only when the text explicitly hands that item to someone else by name — never for the speaker's own to-dos, and never guess.`
    : '';

  return `Split and classify this brain-dump note from someone running ${businessContext}.

It was most likely DICTATED, so it may contain several unrelated thoughts in one breath. Return one entry per distinct thought, in the order spoken. Do NOT split a single coherent thought: "call mum and dad" is ONE task, "book the kids into swimming and pay the rego" is TWO.

Each item's "text" must be the speaker's OWN WORDS, not a summary — copy the wording for that item, minus the connectives joining it to the others. Never invent content and never merge two separate thoughts into one item.

The deciding question for destination is ACTIONABLE vs NOT — never business vs personal; a personal errand is just as much a task as a business one:
- task: ANY concrete thing to actually go do or follow up on — business related (call a supplier, follow up a job, list an item) OR personal/home/family (get milk, book a dentist appointment, pick up the kids, pay a bill). If it reads as "I need to X" / "remember to X" / an instruction to do something, it is a task even if X is a two-second errand.
- strategy: a business strategy, plan, or approach worth tracking — not a single action, a way of doing things
- knowledge: a fact, reference, or idea worth keeping that isn't itself an action
- life_stream: a STATUS UPDATE or REFLECTION about health, money (personal, not business cashflow), home, relationships/people, or personal growth — e.g. "haven't slept well this week", "spending feels out of control", "barely see the kids lately". These describe how an area of life is going; they do NOT ask for a specific action to be taken. If it names a specific thing to go do, it's a task instead, even if that area of life is health/home/etc.

If an item's destination is life_stream, also set life_stream_key to whichever of health/money/home/people/growth fits best.

TEXT: "${collapse(text)}"${ownerBlock}`;
}

// Accepts both the current { items: [...] } shape and the legacy single
// { destination, life_stream_key } shape, so a response from an older cached
// prompt (or any model that ignores the array) still files correctly instead of
// throwing the dump away.
function extractRawItems(result, originalText) {
  if (result && Array.isArray(result.items) && result.items.length) return result.items;
  if (result && DESTINATIONS.includes(result.destination)) {
    return [{ text: originalText, destination: result.destination, life_stream_key: result.life_stream_key, owner_name: result.owner_name }];
  }
  return [];
}

function resolveOwner(rawName, peopleNames) {
  const wanted = collapse(rawName).toLowerCase();
  if (!wanted) return null;
  const hit = peopleNames.find((n) => collapse(n).toLowerCase() === wanted);
  return hit ? collapse(hit) : null;
}

export function normalizeClassifyResult(result, originalText, peopleNames = []) {
  const text = collapse(originalText);
  const raw = extractRawItems(result, text);

  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const itemText = collapse(entry.text);
    if (!itemText) continue;
    // An unknown destination is dropped to the default rather than discarding
    // the item — the words are the valuable part, the bucket is recoverable.
    const destination = DESTINATIONS.includes(entry.destination) ? entry.destination : DEFAULT_DESTINATION;
    const lifeStreamKey = destination === 'life_stream' && LIFE_STREAM_KEYS.includes(entry.life_stream_key)
      ? entry.life_stream_key
      : null;
    const ownerName = resolveOwner(entry.owner_name, peopleNames);

    const fingerprint = `${destination}\u0000${itemText.toLowerCase()}`;
    if (seen.has(fingerprint)) continue; // a repeated item inflates coverage below
    seen.add(fingerprint);

    items.push({ text: itemText, destination, life_stream_key: lifeStreamKey, owner_name: ownerName });
    if (items.length >= MAX_ITEMS) break;
  }

  if (!items.length) {
    return [{ text, destination: DEFAULT_DESTINATION, life_stream_key: null, owner_name: null, fallback_reason: FALLBACK_NOTHING_CLASSIFIED }];
  }

  // Two ways to lose something, so two tests. The clause test is the one that fires
  // in practice: it catches a dropped thought of any length, where character coverage
  // only notices a large loss. The asymmetry stays deliberate — firing when it needn't
  // costs a slightly coarser filing (the user sees their own words, unfiltered), while
  // not firing when it should loses a thought the synthesis can then never reason over.
  const covered = items.reduce((sum, i) => sum + i.text.length, 0);
  const droppedClause = unrepresentedClause(text, items);
  if (covered < text.length * MIN_COVERAGE || droppedClause) {
    const first = items[0];
    return [{ text, destination: first.destination, life_stream_key: first.life_stream_key, owner_name: first.owner_name, fallback_reason: FALLBACK_INCOMPLETE }];
  }

  return items;
}
