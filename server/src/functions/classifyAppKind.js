// What does the thing the operator described actually need?
//
// The decision behind /begin's connection list. Read server/src/lib/appKind.js for
// why the KIND is the model's answer but the CONNECTION LIST is not — briefly: a
// wrong kind is one visible sentence the customer can overrule, while a wrong
// service list is an invisible hole they cannot.
//
// Owner-authenticated like every other function (it is not in PUBLIC_FUNCTIONS),
// and it spends the caller's credits, so it is bounded on both ends: the
// description is capped before it reaches a model, and the answer is one of two
// kinds.
import { invokeAI } from '../ai.js';
import { APP_KIND_SCHEMA, buildAppKindPrompt, normalizeAppKind } from '../lib/appKind.js';

// Long enough for someone to describe their business properly, short enough that a
// paste of an entire document cannot be billed as a classification.
const MAX_DESCRIPTION = 2000;

export default async function handler({ user, body }) {
  const description = String(body?.description || '').trim();
  if (!description) throw Object.assign(new Error('Describe what it should do first.'), { status: 400 });
  if (description.length > MAX_DESCRIPTION) {
    throw Object.assign(new Error(`That is more than ${MAX_DESCRIPTION} characters — describe it in a few sentences.`), { status: 400 });
  }

  // `role: 'classify'` (flash @ 0.4) because this is a two-field decision, not
  // judgement. The budget is deliberately not tight: this platform bills a
  // reasoning model's thinking against max_tokens, and of the four `classify`
  // calls measured over a fortnight, three ended at exactly 1200 output tokens —
  // after the role was named. Nothing is billed for headroom that goes unused,
  // and a truncated schema call THROWS, which here would mean the on-ramp fails
  // on a sentence. See AGENTS.md and scripts/verify-ai-roles.mjs.
  const { result } = await invokeAI({
    userId: user.id,
    prompt: buildAppKindPrompt(description),
    schema: APP_KIND_SCHEMA,
    role: 'classify',
    maxTokens: 4000,
  });

  return normalizeAppKind(result);
}
