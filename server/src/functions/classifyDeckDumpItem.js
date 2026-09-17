// Brain dump's actual promise ("otherwise Jarvis files it where it
// belongs") — a text (no name mentioned, so addDump's own regex-based
// owner detection didn't fire) gets classified into where it actually
// belongs: a task, a strategy note, a knowledge/idea note, or a life-stream
// note (health/money/home/people/growth). Called synchronously from
// addDump before the item is saved anywhere, so a dump entry lands directly
// in the right place instead of sitting in an "unsorted" pile waiting on a
// manual tap — same "capture without thinking, Jarvis handles the rest"
// principle the owner-detection path already has.
import { invokeAI } from '../ai.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    destination: {
      type: 'string',
      enum: ['task', 'strategy', 'knowledge', 'life_stream'],
      description: 'task = ANY concrete to-do, business or personal (get milk, book the kids into swimming, call a supplier, fix a pickup); strategy = a business plan/approach idea; knowledge = a fact, reference, or idea worth keeping that is not itself actionable; life_stream = a STATUS or REFLECTION note about health, money, home, relationships/people, or personal growth — not an action to take',
    },
    life_stream_key: {
      type: 'string',
      enum: ['health', 'money', 'home', 'people', 'growth'],
      description: 'Only set when destination is life_stream — which of the five streams this belongs to.',
    },
  },
  required: ['destination'],
};

export default async function handler({ user, body }) {
  const text = (body?.text || '').trim();
  if (!text) throw Object.assign(new Error('text is required'), { status: 400 });

  const businessContext = await getDeckBusinessContext(user.id);
  const prompt = `Classify this brain-dump note from someone running ${businessContext}. Pick exactly one destination. The deciding question is ACTIONABLE vs NOT — never business vs personal; a personal errand is just as much a task as a business one:
- task: ANY concrete thing to actually go do or follow up on — business related (call a supplier, follow up a job, list an item) OR personal/home/family (get milk, book a dentist appointment, pick up the kids, pay a bill). If it reads as "I need to X" / "remember to X" / an instruction to do something, it is a task even if X is a two-second errand.
- strategy: a business strategy, plan, or approach worth tracking — not a single action, a way of doing things
- knowledge: a fact, reference, or idea worth keeping that isn't itself an action
- life_stream: a STATUS UPDATE or REFLECTION about health, money (personal, not business cashflow), home, relationships/people, or personal growth — e.g. "haven't slept well this week", "spending feels out of control", "barely see the kids lately". These describe how an area of life is going; they do NOT ask for a specific action to be taken. If it names a specific thing to go do, it's a task instead, even if that area of life is health/home/etc.

TEXT: "${text}"

If destination is life_stream, also set life_stream_key to whichever of health/money/home/people/growth fits best.`;

  // Deliberately generous even though the answer is one enum value plus an
  // optional second one — this deployment's model can burn real budget on
  // hidden reasoning before the actual JSON (the same lesson chatWithJarvis.js
  // and syncDeckGmailInbox.js's classifier both already learned the hard way).
  const { result } = await invokeAI({ userId: user.id, prompt, schema: CLASSIFY_SCHEMA, maxTokens: 600 });

  const destination = ['task', 'strategy', 'knowledge', 'life_stream'].includes(result?.destination) ? result.destination : 'knowledge';
  const life_stream_key = ['health', 'money', 'home', 'people', 'growth'].includes(result?.life_stream_key) ? result.life_stream_key : null;

  return { destination, life_stream_key };
}
