// Jarvis's past careers — the register, and the practitioner's brief for the ones he can be held to.
//
// WHY THIS EXISTS. Rob, 2026-10-03: *"So we need to fill out the carreers with specialized knowlage
// maybe kept in some specially designed ai shorthand so we can keep bulk knowlage on hand thats
// referencable quickly"*. The design is JARVIS-CAREERS-KNOWLEDGE.md; this module is its data half.
//
// THE ONE RULE FOR A CARD: every line must change the answer.
//
// The model already knows what a doctor, an accountant and a lawyer know — it has read more of all
// three than any practitioner. A card that restates that is a badly-written encyclopedia that costs
// tokens on every matching message. So a card carries only what the model CANNOT supply:
//
//   lens    how a practitioner frames the problem before answering
//   first   the first move, and its order
//   red     what a professional refuses to wave through
//   traps   the common wrong answer in this domain
//   refer   when to stop and hand over to a human
//   check   the facts that must be looked up and NEVER asserted from memory
//   region  what varies by jurisdiction — or an explicit "none", so that is a decision not an omission
//
// `check` and `region` are the two that keep this honest. Tax thresholds, drug interactions, statutory
// deadlines and safety codes are the facts most worth having and the ones a hand-written card gets
// wrong within a year, so the card says to look them up rather than asserting them.
//
// Import-free on purpose: nothing here but strings, so `scripts/verify-jarvis-careers.mjs` runs in
// CI's no-install guards job. Same reason `jarvisPersona.js` and `deckSnapshotGate.js` are.
//
// ⚠️ THIS IS A FRAMING AID, NOT A SOURCE OF TRUTH. These cards are written by an engineer, not by a
// doctor, a lawyer or an accountant. `refer` and `check` exist so the output stays a prompt to think
// properly and get real help — never a substitute for it.

/**
 * Rob gave this list verbatim (2026-10-03) as a FIXED set. Order is his, and is asserted in CI.
 *
 * The persona's career list is rendered FROM this array, so the two cannot drift — before this there
 * were two hardcoded copies of the same 36 names, which is exactly how a list starts disagreeing
 * with itself.
 */
export const CAREER_KEYS = [
  'doctor', 'lawyer', 'realtor', 'financial advisor', 'accountant', 'psychologist', 'psychiatrist',
  'social worker', 'mental-health professional', 'bodyguard', 'Brazilian jiu-jitsu instructor', 'ninja',
  'combat intelligence specialist', 'engineer', 'scientist', 'physicist', 'stockbroker', 'banker',
  'workplace health and safety compliance officer', 'general', 'fighter pilot', 'chef', 'animal trainer',
  'survivalist', 'interior designer', 'software engineer', 'general manager', 'consultant', 'data analyst',
  'magician', 'strategist', 'lounge singer', 'jazz drummer', 'cowboy', 'astronaut', 'fireman',
];

/** The sections every card must carry, in this order. A card missing one is a half-written brief. */
export const CARD_SECTIONS = ['lens', 'first', 'red', 'traps', 'refer', 'check', 'region'];

/**
 * A card is a SHORTHAND. This budget is what stops the register quietly becoming 36 essays, which is
 * the single most likely way this feature goes wrong — so it is enforced in CI, not by intent.
 *
 * 850 chars ≈ 210 tokens: enough for the seven sections to each say something real (the first three
 * land at 714–767, so there is headroom without room for padding), and small enough that three
 * selected briefs are ~600 tokens rather than the ~4,000 that would make the feature a liability.
 * A card that needs more than this is not a card.
 */
export const CARD_MAX_CHARS = 850;

/**
 * The briefs. Deliberately only three to start: the format is the unproven part, so it gets proved on
 * a few before 33 more get written in a format nobody has tested. `verify-jarvis-careers.mjs` holds a
 * coverage floor so this can grow but cannot silently shrink.
 */
const CARDS = {
  doctor: `DOCTOR (general practice)
lens: what is most likely AND what is most dangerous — rule the dangerous one out first
first: triage by severity, not by the order the symptoms were described
red: chest pain spreading to jaw or arm · sudden worst-ever headache · calf pain with breathlessness · unexplained weight loss · any blood where it should not be
traps: reassuring without examining · treating the symptom they volunteered as the whole story
refer: anything acute or worsening — a real clinician, today; you are not examining anyone
check: doses, interactions and guidelines change — never assert them from memory
region: which drugs are funded, what a GP may prescribe and how referral works are country-specific`,

  lawyer: `LAWYER
lens: what is the actual legal question, who is carrying the risk, and what does the document already say
first: facts and the paper trail before the theory — and the jurisdiction before the rule
red: any limitation period or filing deadline · signing under pressure · a verbal variation of a written term · admitting fault in writing
traps: answering the question asked when the exposure is somewhere else · treating a general principle as the local rule
refer: court dates, criminal exposure, anything already in dispute — a local lawyer, promptly
check: statutes, thresholds, limitation periods and procedure are jurisdiction-specific and always looked up
region: everything here varies by country and state — name the one you are answering for`,

  accountant: `ACCOUNTANT
lens: what actually happened economically, and what the tax authority will treat it as — those are not always the same thing
first: entity structure and the period first, then the treatment; cash versus accrual decides half of it
red: mixing personal and business money · no contemporaneous records · a deduction nobody can substantiate · anything that changes an already-lodged return
traps: treating a cash movement as a deduction · assuming last year's treatment still applies
refer: a lodgement deadline, an audit notice or a structure change — a registered accountant
check: rates, thresholds, deadlines and concessions change every year — never from memory
region: income tax and filing dates are national; state taxes and payroll rules differ again`,
};

/** @returns {string[]} the careers that currently have a brief. */
export function cardedCareers() {
  return CAREER_KEYS.filter((k) => Boolean(CARDS[k]));
}

/** The comma list the persona renders, so the register is its only copy. */
export function careerListText() {
  return CAREER_KEYS.join(', ');
}

/**
 * The cards for the selected hats, or `''` when none were selected.
 *
 * Returns `''` — not a header with nothing under it — so that a turn with no careers produces a prompt
 * byte-identical to the one before this feature existed. `verify-jarvis-careers.mjs` asserts that,
 * which is what makes "this is not always-on" a fact rather than a claim.
 */
export function careerBlock(keys) {
  const wanted = Array.isArray(keys) ? keys : [];
  const cards = wanted.map((k) => CARDS[k]).filter(Boolean);
  if (!cards.length) return '';
  return [
    'The hats you are wearing right now, and how you actually know the job — use these, do not recite them:',
    ...cards,
  ].join('\n\n');
}

/** Is this key one of the 36? The selector is only ever allowed to return these. */
export function isKnownCareer(key) {
  return CAREER_KEYS.includes(String(key || '').trim());
}
