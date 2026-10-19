// A PROPOSAL for a finding that has no rule of its own — and the rules that decide
// whether one may be offered to the operator at all.
//
// THE BOUND IS THE PLUGIN'S, NOT THIS FILE'S. An AI pointed at a live site with the
// freedom to invent an action can invent a harmful one, and nothing downstream would
// know it was outside the design. So the vocabulary lives in the plugin
// (`Morpheus_Fixes::ai_operations()`), one LIST of operations per finding, and the model's
// whole job is to choose ONE of the operations the finding already allows — and, when there
// is more than one, to say why that one. It never supplies a mechanism, a path or a line of
// code; at most it fills in the arguments an operation declares, and an operation with no
// arguments is the safest kind because there is nothing to fill in at all.
//
// ⚠️ THE LIST IS THE POINT (2026-10-09). With one operation per finding, "the model chooses"
// was a menu of one: the choice meant nothing, and the check below could only ever confirm
// the only answer there was. A finding may now offer several, so the operations somebody
// genuinely has a choice about (turn debugging off, or keep it and move the log?) are the
// ones an AI can actually help with.
//
// This module builds the question, and then checks the answer against that vocabulary
// before the operator ever sees a button — and the plugin checks it AGAIN, against the
// site's own state, before anything is written. Two checks, one of them on the machine
// the change happens to.
//
// Pure and dependency-free, so a guard can exercise every rule without a model and
// without a site.

/** "Analyse, don't build" — the recorded slot for exactly this shape of call. */
export const PROPOSAL_ROLE = 'diagnosis';

/** Longest a model-supplied string may be before it is refused as noise. */
const MAX_STRING = 400;

/**
 * The question, in full.
 *
 * The finding is described in the plugin's own words — its label, what it found, and
 * how much of the site it covers — because a model given a paraphrase is being asked to
 * reason about the paraphrase. The menu is quoted EXACTLY, including the argument names,
 * so an invented argument is a visible mistake rather than a plausible one.
 */
/**
 * The shape of the answer. Passed to the model, which is why it is written as instructions
 * rather than as a validator — `validateProposal()` below is the validator, and it does not
 * trust this to have been obeyed.
 */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', description: 'ONE of the operations listed above for this finding, copied exactly.' },
    args: { type: 'object', description: 'Only the arguments the CHOSEN operation declares above.' },
    why: { type: 'string', description: 'One sentence, in plain words, for the site owner — and if you had a choice, why this one.' },
    cannot: { type: 'string', description: 'Set this INSTEAD of op/args when none of the operations can honestly fix this finding, and say what to do instead.' },
  },
  required: ['why'],
  additionalProperties: false,
};

/**
 * The operations a finding offers, as a list.
 *
 * ⚠️ A LIST, NOT ONE OPERATION. This used to be a single object, which made "the model
 * chooses" a menu of one: the choice meant nothing, and the check that the model had
 * picked from the menu could only ever confirm the only answer. A finding may now offer
 * several operations the site can perform, and choosing between them is the model's real
 * job. The single-object shape is still accepted so an older plugin cannot break this.
 */
function operationsOf(menu) {
  if (Array.isArray(menu)) return menu.filter((o) => o && typeof o === 'object' && o.op);
  if (menu && typeof menu === 'object' && menu.op) return [menu];
  return [];
}

export function buildProposalPrompt({ finding, menu, site } = {}) {
  const f = finding || {};
  const ops = operationsOf(menu);
  const many = ops.length > 1;

  const lines = [
    'You are helping the owner of a WordPress site decide what to do about ONE finding.',
    '',
    'You may NOT invent an action. The operations available for this finding are listed below,',
    many
      ? 'and your job is to CHOOSE ONE — the one that best fits what the check actually found — and say why it is the right one.'
      : 'and it is the only one:',
  ];
  if (many) lines.push('There is more than one because more than one honest answer exists. Choosing is the whole of your job here.');

  for (const [i, o] of ops.entries()) {
    lines.push('', `  op: ${o.op}${o.label ? ` — ${o.label}` : ''}`);
    lines.push(`  what it does: ${o.does || ''}`);
    const args = o.args && typeof o.args === 'object' ? o.args : {};
    const names = Object.keys(args);
    lines.push(`  arguments it takes: ${names.length ? '' : '(none)'}`);
    for (const name of names) lines.push(`    ${name}: ${args[name]}`);
  }
  if (!ops.length) lines.push('  (none)');

  lines.push(
    '',
    'If NONE of the operations can honestly resolve this finding, say so in "cannot" and explain what the',
    'owner should do instead. That is a good answer, not a failure — most findings on a WordPress site',
    'are fixed by a person, and inventing an action that does not address the cause is the one outcome',
    'that is never acceptable.',
    '',
    'Answer with JSON only, in exactly this shape:',
    '  { "op": "<ONE of the operations above, copied exactly>", "args": { ... }, "why": "<one sentence, in plain words, for the site owner>", "cannot": "<only if none of them can honestly fix this>" }',
    '',
    '--- THE FINDING ---',
    `id: ${f.id || ''}`,
    `title: ${f.label || ''}`,
    `status: ${f.status || ''}`,
    `what the check found: ${f.description || ''}`,
  );
  if (Array.isArray(f.rows) && f.rows.length) {
    lines.push('rows it reported (bounded):');
    for (const r of f.rows.slice(0, 20)) lines.push('  ' + JSON.stringify(r));
  }
  lines.push('', '--- THE SITE ---');
  lines.push(`WordPress: ${site?.wpVersion || 'unknown'}`);
  lines.push(`PHP: ${site?.phpVersion || 'unknown'}`);
  lines.push(`WordPress timezone (Settings → General): ${site?.timezone || 'not set'}`);
  lines.push(`PHP timezone in force right now: ${site?.phpTimezone || 'unknown'}`);
  lines.push('');
  lines.push('Use the values the site reports. Do not guess a timezone, a path or a plugin name.');

  return lines.join('\n');
}

/**
 * Is this answer usable?
 *
 * Everything here is a REFUSAL with a code, because a proposal that is dropped silently
 * reads in the panel as a broken button. `cannot` is deliberately a SUCCESS: the model
 * declining to act, with its reason, is the answer this whole design prefers.
 */
export function validateProposal(raw, { findingId, menu } = {}) {
  const ops = operationsOf(menu);
  const text = (v) => (typeof v === 'string' ? v.trim() : '');

  if (raw && typeof raw === 'object' && text(raw.cannot)) {
    return { ok: true, cannot: text(raw.cannot).slice(0, MAX_STRING), proposal: null };
  }

  const why = text(raw?.why);
  if (!why) {
    return { ok: false, code: 'NO_REASON', error: 'Morpheus did not say why, so there is nothing to show you. Nothing was changed.' };
  }
  if (why.length > MAX_STRING) {
    return { ok: false, code: 'REASON_TOO_LONG', error: 'The explanation was too long to be a sentence. Nothing was changed.' };
  }

  const op = text(raw?.op);
  if (!ops.length) {
    return { ok: false, code: 'NO_AI_ACTION', error: 'Morpheus has no mechanism to propose for this finding. Nothing was changed.' };
  }
  // ⚠️ THE CHOICE. This is the check the whole "the model chooses" design rests on: the
  // model is shown a MENU, and an operation outside it is refused rather than attempted.
  // Membership, not equality — a finding may offer more than one — and it is checked again
  // in the plugin, on the machine the change is made to.
  const chosen = ops.find((o) => o.op === op);
  if (!chosen) {
    return { ok: false, code: 'AI_OP_NOT_ALLOWED', error: `Morpheus proposed "${op}", which is not one of the things it may do about this finding (${ops.map((o) => `"${o.op}"`).join(', ')}). Nothing was changed.` };
  }

  // ONLY the arguments the CHOSEN operation declares, each a short string. Checked against
  // the operation it actually picked, not against the union of the menu — otherwise an
  // argument belonging to the other operation would sail through. An extra key is a model
  // reaching past its brief, and it is refused rather than quietly dropped: the plugin
  // would refuse it too, and finding out here is cheaper than finding out there.
  const declared = Object.keys(chosen.args && typeof chosen.args === 'object' ? chosen.args : {});
  const given = raw?.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
  for (const key of Object.keys(given)) {
    if (!declared.includes(key)) {
      return { ok: false, code: 'AI_ARG_NOT_ALLOWED', error: `Morpheus supplied an argument this operation does not take ("${key}"). Nothing was changed.` };
    }
  }
  const args = {};
  for (const key of declared) {
    const value = text(given[key]);
    if (!value) {
      return { ok: false, code: 'AI_ARG_MISSING', error: `Morpheus did not supply "${key}", which this operation needs. Nothing was changed.` };
    }
    if (value.length > MAX_STRING) {
      return { ok: false, code: 'AI_ARG_TOO_LONG', error: `The value for "${key}" was too long. Nothing was changed.` };
    }
    args[key] = value;
  }

  return { ok: true, cannot: null, proposal: { finding: String(findingId || ''), op, args, why } };
}

/**
 * The one line the operator reads before pressing anything: what will actually change.
 *
 * Rendered from the PROPOSAL, not from the model's sentence about it — a model that
 * describes a bigger or smaller change than it asked for must not be able to have its
 * description believed. The description comes from the operation the proposal NAMED, so
 * with a menu of two, this describes the one that will actually run.
 */
export function describeProposal(proposal, menu) {
  if (!proposal) return '';
  const chosen = operationsOf(menu).find((o) => o.op === proposal.op) || {};
  const bits = Object.entries(proposal.args || {}).map(([k, v]) => `${k} = ${v}`);
  return `${chosen.label || proposal.op}: ${chosen.does || ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}
