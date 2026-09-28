// Does what the operator described need a backend, or is it a static site?
//
// WHY THIS EXISTS. /begin is the on-ramp for someone who wants a website or a
// hosted web app, and the honest answer to "what do I have to connect?" depends
// on which of those it is. A static site needs somewhere to build it and
// somewhere to host it. A full-stack app needs those AND a place for its data.
// Asking everyone for the same two things is either a needless hurdle — a
// brochure site told to set up a database — or a missing step that only shows up
// later, as a booking app that goes live and cannot save a booking.
//
// The MODEL decides the kind and says why. The connection list is NOT invented by
// the model: `needsFor()` derives it here from the kind alone. That split is
// deliberate — a model that guesses the kind wrong then asks for the wrong
// services is a much worse failure than one that guesses the kind wrong, because
// the customer cannot tell which connections they were missing. It also means an
// unusable answer degrades to the SMALLER list, not to nothing.
//
// Pure and import-free on purpose: `scripts/verify-onramp.mjs` runs in CI's
// no-install job, and the guard tests this rule directly rather than grepping a
// handler for a regex.

/** The two answers. Anything else is not an answer. */
export const APP_KINDS = ['static', 'fullstack'];

/**
 * The connection ids each kind needs, in the order they should be shown.
 *
 * 'github' is first because it is what builds the app either way, and it is the
 * one the customer never has to paste anything for. 'netlify' hosts a static site
 * and can run a full-stack app's functions. 'supabase' is the free Postgres the
 * generated backend uses, and is only asked for when there is data to store.
 *
 * These are ids, not services-in-the-abstract: the UI resolves each to a label and
 * its one-action deep link from the same registry the Connections editor uses, so
 * a provider URL exists in one place.
 */
export function needsFor(kind) {
  return kind === 'fullstack' ? ['github', 'netlify', 'supabase'] : ['github', 'netlify'];
}

/** The schema handed to invokeAI — a schema call throws rather than returning prose. */
export const APP_KIND_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: APP_KINDS,
      description: 'static = only ever serves files to a browser; fullstack = stores data, has logins, takes payments server-side, or runs code on a request',
    },
    reason: {
      type: 'string',
      description: 'ONE plain sentence a non-technical customer would understand, saying which it is and why. No jargon, and no mention of this schema.',
    },
  },
  required: ['kind', 'reason'],
};

/**
 * The prompt. It states the tie-break explicitly, because the tie-break is a
 * product decision and leaving it to the model is how you get a different answer
 * for the same sentence on two different days.
 */
export function buildAppKindPrompt(description) {
  return `You are deciding what a website or app needs in order to run, from the customer's own description of it.

The customer said:
"""
${description}
"""

Answer with a JSON object:
- "kind": "static" if it can work as files served to a browser with no server-side code and nowhere to store data — a brochure site, a portfolio, a landing page, a menu, an announcement. "fullstack" if it must store data, have user accounts or logins, take payments on the server, hold a secret key, or run code when a request arrives — a booking system, a shop with orders, a customer list, a dashboard, anything with a database.
- "reason": ONE sentence, in plain language the customer would understand, saying which it is and why.

When it could honestly be built either way, choose "static": a first version that needs nothing but hosting is cheaper, and a backend can be added later. Do not choose "fullstack" for something that merely sounds impressive.`;
}

/**
 * The model's answer, made safe to render.
 *
 * An unusable answer (wrong shape, unknown kind) falls back to 'static' and is
 * marked `fellBack` so the UI can say "I could not tell" and offer the choice,
 * rather than presenting a guess as a decision. The reason is bounded: it is
 * shown to the customer, and a model that ignores "one sentence" must not be able
 * to push a wall of text into a phone screen.
 */
export function normalizeAppKind(result) {
  const known = APP_KINDS.includes(result?.kind);
  const kind = known ? result.kind : 'static';
  const reason = typeof result?.reason === 'string' ? result.reason.trim().slice(0, 240) : '';
  return { kind, reason, needs: needsFor(kind), fellBack: !known };
}
