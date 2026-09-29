// What choosing a delivery posture does to the rest of the screen.
//
// WHY THIS IS SEPARATED FROM THE COMPONENT. The rule that matters is not "does a button render" — it is
// what a click does to the five component selections, and whether the operator is then told the truth
// about the stack they have chosen. That rule is worth testing, and `BackendPanel.jsx` is a 900-line
// component with no render harness in this repo, so a rule living inside it can only be asserted by
// grepping its markup — which is how a check passes while the behaviour is wrong.
//
// So the pure decisions live here and `scripts/` can exercise them directly, including the case that
// prompted the whole posture feature: an operator who edits one service after choosing a preset must be
// told that their stack no longer matches, rather than shown a preset tick over a stack that cannot run.
//
// Import-free of React on purpose, so it loads under `node --test` and in the no-install guards job.

/**
 * The five selections a posture implies, as a NEW object (never the posture's own, which is a shared
 * constant — a component that mutated it would corrupt every other render).
 */
export function componentsForPosture(posture) {
  // `{ ...null }` is `{}`, not null — so a posture object with no `components` would produce an EMPTY
  // stack, which the panel would then render as a stack needing no accounts. Failing to null is the
  // honest answer: the caller shows nothing rather than a stack nobody described.
  if (!posture || !posture.components) return null;
  return { ...posture.components };
}

/**
 * Everything the panel needs to say about the current selection, in one place.
 *
 * `matches` and `needsAccounts` are deliberately returned together: "which preset is this" and "can it
 * run without anyone's account" are different questions, and the interesting case is a stack that
 * matches no preset AND needs accounts — an operator who has edited their way into something that may
 * not run at all.
 */
export function selectionSummary({ components, postureOf, stackRequirement }) {
  const need = stackRequirement(components || {});
  return {
    matchesPreset: postureOf(components || {}),
    selfContained: need.selfContained,
    needsAccounts: need.needsAccounts || [],
  };
}

/**
 * The sentence shown above the service list. Plain words, and never green ink for prose — the repo's
 * prose-ink rule reserves the brand colour for structure.
 */
export function selectionSentence(summary) {
  if (!summary) return '';
  if (summary.selfContained) return 'This stack runs on your own machine — no account with anyone.';
  const names = summary.needsAccounts.map((n) => n.label).join(', ');
  const base = `This stack needs an account with ${names}.`;
  // Only when it ALSO matches no preset: if it matches the cloud preset, needing cloud accounts is the
  // expected, chosen outcome and saying "check it can run" would be noise.
  return summary.matchesPreset ? base : `${base} It no longer matches a preset, so check it can actually run.`;
}

/**
 * The badge on each posture card: what the operator is committing to before they click.
 */
export function postureBadge(summary) {
  const n = summary?.needsAccounts?.length || 0;
  if (summary?.selfContained) return 'no accounts needed';
  return `${n} account${n === 1 ? '' : 's'} needed`;
}
