// Where a local Portable Morpheus gets its AI — the rule, import-free so
// `scripts/verify-portable-ai.mjs` can assert it in CI's no-install job.
//
// DECIDED (Rob, 2026-09-29): the paid path works out of the box; a local LLM is opt-in. The plumbing
// for all three sources ALREADY EXISTS in `server/src/ai.js` and `config/hostedDefaults.js`:
//
//   1. per-account override   UserSettings (ai_mode 'custom' + base_url/key/model) — a user's own key,
//                             which is also how a locally hosted model is pointed at
//   2. this deployment's env  LLM_BASE_URL / LLM_API_KEY / LLM_MODEL — how a single-machine install
//                             sets its model once, for everything
//   3. Morpheus Cloud broker  MORPHEUS_BROKER_URL — "so a fresh self-host works out of the box with
//                             zero API keys, then graduates to the operator's own credentials"
//
// The order matters and is asserted against ai.js, not copied into a comment (see the guard).
//
// THE HONEST GAP, and it is infrastructure rather than code: the broker is NOT deployed. The shipped
// default is the deliberately inert `broker.morpheus.invalid`, so tier 3 currently resolves to
// nothing. That means "the paid path works out of the box" is not true yet for a local install, and
// nothing here should pretend otherwise.

/** The placeholder `hostedDefaults.js` uses to mean "no broker deployed". Asserted against that file. */
export const BROKER_PLACEHOLDER = 'https://broker.morpheus.invalid';

/**
 * Where a locally hosted OpenAI-compatible server usually listens. These are CONVENTIONS, not
 * contracts — the script probes them and then asks the server what models it has, and any other URL
 * can be passed explicitly. A guessed port that is silently assumed is how someone ends up talking to
 * the wrong thing.
 */
export const LOCAL_CANDIDATES = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'vllm', label: 'vLLM / llama.cpp', baseUrl: 'http://127.0.0.1:8000/v1' },
];

/** The three sources, with what each one actually costs and what it does with the user's data. */
export const AI_SOURCES = [
  {
    id: 'local',
    label: 'A model on this machine',
    worksToday: true,
    costs: 'Nothing to us and nothing to a provider — the compute is yours.',
    privacy: 'Prompts and code never leave this machine.',
    how: 'Runs a local OpenAI-compatible server (Ollama, LM Studio, vLLM) and points the install at it.',
  },
  {
    id: 'key',
    label: 'Your own provider key',
    worksToday: true,
    costs: 'Billed by your provider at their rates. Morpheus is not in the path.',
    privacy: 'Prompts go to that provider, under your account and their terms.',
    how: 'An OpenAI-compatible base URL, key and model written into server/.env.',
  },
  {
    id: 'cloud',
    label: 'Morpheus Cloud (the paid default)',
    worksToday: false,
    costs: 'Charged in Morpheus credits — this is the paid path, and the only one we can bill.',
    privacy: 'Prompts and code are evaluated on Morpheus infrastructure, not on your machine.',
    how: 'MORPHEUS_BROKER_URL pointing at a deployed Morpheus broker. Decided as the out-of-the-box default; NOT DEPLOYED YET, so it cannot work today.',
  },
];

/**
 * The privacy sentence for a chosen source. The obligation recorded in MORPHEUS-BIG-PICTURE.md: with
 * the paid path as the default, "all data stays on your machine" is true of data at rest and FALSE of
 * AI requests — so whichever source is chosen has to be named, in those words, at the point of choice.
 */
export function privacyLine(sourceId) {
  const s = AI_SOURCES.find((x) => x.id === sourceId);
  return s ? s.privacy : 'Unknown source — nothing about your data can be promised.';
}

/**
 * Does this model id look local to the COST LEDGER? `costEstimate.js`'s LOCAL_MODEL_PATTERNS decides
 * whether a call is recorded as $0. A local model whose id matches none of them is priced from
 * DEFAULT_PRICING — a cost nobody pays, recorded as if someone did. That is the same class of bug as
 * gemini-3.5-flash-lite billing from a generic default, so the wizard checks it before writing.
 */
export function matchesLocalPattern(modelId, patterns) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return false;
  return (patterns || []).some((p) => id.includes(String(p).toLowerCase()));
}

/** The `.env` lines for a chosen source. Never includes a value we were not explicitly given. */
export function envLinesFor({ source, baseUrl, model, key, brokerUrl }) {
  if (source === 'local' || source === 'key') {
    return [
      `LLM_BASE_URL=${baseUrl}`,
      // A local server still wants a non-empty Authorization header on most builds, so this is filled
      // with a placeholder rather than left blank — the tier is only used when the key is truthy.
      `LLM_API_KEY=${key || (source === 'local' ? 'local' : '')}`,
      `LLM_MODEL=${model}`,
    ];
  }
  if (source === 'cloud') return [`MORPHEUS_BROKER_URL=${brokerUrl}`];
  throw new Error(`Unknown AI source "${source}"`);
}

/** Keys the wizard owns — anything else in .env is left exactly as it was. */
export const AI_ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'MORPHEUS_BROKER_URL'];

/** What a fresh install should be told, in one sentence, when nothing is configured. */
export const NOT_CONFIGURED = 'No AI source is configured, so AI calls have nowhere to go. Pick one: '
  + 'a model on this machine (private, free), your own provider key, or Morpheus Cloud (paid, not deployed yet).';
