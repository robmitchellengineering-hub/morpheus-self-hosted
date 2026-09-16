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

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    destination: {
      type: 'string',
      enum: ['task', 'strategy', 'knowledge', 'life_stream'],
      description: 'task = a concrete action to do; strategy = a business plan/approach idea; knowledge = a fact, reference, or idea worth keeping that is not itself actionable; life_stream = about health, money, home, relationships/people, or personal growth outside the shop',
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

  const prompt = `Classify this brain-dump note from someone running Valiant Music, a one-person vintage guitar shop. Pick exactly one destination:
- task: a concrete action to do (something to call, fix, order, list, follow up on)
- strategy: a business strategy, plan, or approach worth tracking
- knowledge: a fact, reference, or idea worth keeping that isn't itself an action
- life_stream: about health, money (personal, not shop cashflow), home, relationships/people, or personal growth — anything outside running the shop day to day

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
