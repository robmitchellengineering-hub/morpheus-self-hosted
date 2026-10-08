// A PROPOSAL for a finding that has no rule of its own — and the rules that decide
// whether one may be offered to the operator at all.
//
// THE BOUND IS THE PLUGIN'S, NOT THIS FILE'S. An AI pointed at a live site with the
// freedom to invent an action can invent a harmful one, and nothing downstream would
// know it was outside the design. So the vocabulary lives in the plugin
// (`Morpheus_Fixes::ai_operations()`), one operation per finding, and the model's whole
// job is to choose the operation the finding already allows and fill in its arguments.
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
    op: { type: 'string', description: 'The one operation available for this finding, copied exactly.' },
    args: { type: 'object', description: 'Only the arguments the operation declares above.' },
    why: { type: 'string', description: 'One sentence, in plain words, for the site owner.' },
    cannot: { type: 'string', description: 'Set this INSTEAD of op/args when the operation cannot honestly fix this finding, and say what to do instead.' },
  },
  required: ['why'],
  additionalProperties: false,
};

export function buildProposalPrompt({ finding, menu, site } = {}) {
  const f = finding || {};
  const m = menu || {};
  const args = m.args && typeof m.args === 'object' ? m.args : {};

  const lines = [
    'You are helping the owner of a WordPress site decide what to do about ONE finding.',
    '',
    'You may NOT invent an action. Exactly one operation is available for this finding, and it is:',
    `  op: ${m.op || '(none)'}`,
    `  what it does: ${m.does || ''}`,
    '  arguments it takes:',
  ];
  for (const [name, desc] of Object.entries(args)) lines.push(`    ${name}: ${desc}`);
  if (!Object.keys(args).length) lines.push('    (none)');

  lines.push(
    '',
    'If the operation cannot honestly resolve this finding, say so in "cannot" and explain what the',
    'owner should do instead. That is a good answer, not a failure — most findings on a WordPress site',
    'are fixed by a person, and inventing an action that does not address the cause is the one outcome',
    'that is never acceptable.',
    '',
    'Answer with JSON only, in exactly this shape:',
    '  { "op": "<the operation above>", "args": { ... }, "why": "<one sentence, in plain words, for the site owner>", "cannot": "<only if the operation cannot honestly fix this>" }',
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
  const m = menu || {};
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
  if (!m.op) {
    return { ok: false, code: 'NO_AI_ACTION', error: 'Morpheus has no mechanism to propose for this finding. Nothing was changed.' };
  }
  if (op !== m.op) {
    return { ok: false, code: 'AI_OP_NOT_ALLOWED', error: `Morpheus proposed "${op}", which is not what it may do about this finding. Nothing was changed.` };
  }

  // ONLY the arguments the menu declares, each a short string. An extra key is a model
  // reaching past its brief, and it is refused rather than quietly dropped — the plugin
  // would refuse it too, and finding out here is cheaper than finding out there.
  const declared = Object.keys(m.args && typeof m.args === 'object' ? m.args : {});
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
 * description believed.
 */
export function describeProposal(proposal, menu) {
  if (!proposal) return '';
  const m = menu || {};
  const bits = Object.entries(proposal.args || {}).map(([k, v]) => `${k} = ${v}`);
  return `${m.label || m.op}: ${m.does || ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}
