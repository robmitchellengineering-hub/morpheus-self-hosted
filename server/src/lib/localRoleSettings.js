// What this local instance's AI roles should resolve to.
//
// WHY THIS EXISTS. `resolvePlatformDefaultModel(role)` falls back to `default_model` when a role has no
// setting, and `default_model` is a REASONING model. So an instance without these rows runs the CODER on
// `deepseek-v4-pro` instead of the intended `deepseek-flash` — measured 2026-09-29: a local backend
// generation that appeared to take ~26 minutes was doing so with every call on the slow model, because
// the instance had never been configured. A measurement taken on an unconfigured instance is not a
// measurement of the pipeline; it is a measurement of the fallback.
//
// This is the same intent `staging/model-test-harness/expected-settings.json` states for production, and
// `check-settings.mjs` compares production against. Kept here as data so a test harness, a review of a
// slow run and a human can all point at one list, and so the values are not retyped per script.
//
// It is NOT a policy of its own: if the intended config changes there, change it here too, or a local run
// will measure a routing that production does not use.

export const INTENDED_ROLE_SETTINGS = Object.freeze({
  default_model: 'deepseek-v4-pro',
  default_temperature: '0.7',
  default_planner_model: 'deepseek-v4-pro',
  default_planner_temperature: '0.7',
  default_coder_model: 'deepseek-flash',
  default_coder_temperature: '0.4',
  default_reviewer_model: 'deepseek-v4-pro',
  default_reviewer_temperature: '0.4',
  default_diagnosis_model: 'deepseek-flash',
  default_diagnosis_temperature: '0.4',
  default_classify_model: 'deepseek-flash',
  default_classify_temperature: '0.4',
  default_draft_model: 'deepseek-flash',
  default_draft_temperature: '0.4',
});

/**
 * Which model a role resolves to, given these settings — the same order `ai.js` uses
 * (`default_<role>_model`, then `default_model`). The point of having it as a function is that a guard
 * can assert the CODER is not the fallback, which is the specific mistake that made a measurement wrong.
 */
export function resolvedModelFor(role, settings = INTENDED_ROLE_SETTINGS) {
  return settings[`default_${role}_model`] || settings.default_model || null;
}
