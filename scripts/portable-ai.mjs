// Choose where a local Portable Morpheus gets its AI.
//
//   node scripts/portable-ai.mjs                                    # what is configured, and what is out there
//   node scripts/portable-ai.mjs --use local [--base-url … --model …]  # a model on this machine
//   node scripts/portable-ai.mjs --use key --base-url … --model … --key …  # your own provider
//   node scripts/portable-ai.mjs --use cloud --broker-url …          # the paid default (see below)
//
// Decided 2026-09-29 (Rob): the paid path works out of the box, a local LLM is opt-in. The three
// sources and their real costs and privacy consequences live in server/src/lib/portableAi.js, which is
// also what the guard asserts — so the words here cannot drift from the rule.
//
// WHAT THIS WILL NOT DO: claim the paid default works. The broker that makes it work is a service in
// `hosted-broker/` that is NOT deployed, and the shipped default URL is deliberately inert. So
// `--use cloud` probes the URL you give it and refuses rather than writing a dead one.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL_PATTERNS } from '../server/src/lib/costEstimate.js';
import {
  AI_SOURCES, LOCAL_CANDIDATES, BROKER_PLACEHOLDER, AI_ENV_KEYS, NOT_CONFIGURED,
  matchesLocalPattern, envLinesFor, privacyLine,
} from '../server/src/lib/portableAi.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, 'server', '.env');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USE = flag('--use');
const say = (s) => console.log(s);

const readEnv = () => (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '');
const envValue = (key) => {
  const line = readEnv().split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
};

/** Probe an OpenAI-compatible server. Returns {ok, models, error} — never throws, never guesses. */
async function probe(baseUrl) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const models = (body?.data || []).map((m) => m?.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message.split('\n')[0] };
  }
}

say('\n  PORTABLE MORPHEUS — where does the AI come from?\n');
for (const s of AI_SOURCES) {
  say(`  ${s.worksToday ? '✓' : '×'} ${s.label}`);
  say(`      costs:   ${s.costs}`);
  say(`      privacy: ${s.privacy}`);
}
say('');

const configuredBase = envValue('LLM_BASE_URL');
const configuredModel = envValue('LLM_MODEL');
const configuredBroker = envValue('MORPHEUS_BROKER_URL');

// ── read-only report ────────────────────────────────────────────────────────
say('  What this install currently has:');
say(`    LLM_BASE_URL   ${configuredBase || '(empty)'}`);
say(`    LLM_MODEL      ${configuredModel || '(empty)'}`);
say(`    LLM_API_KEY    ${envValue('LLM_API_KEY') ? '(set)' : '(empty)'}`);
say(`    BROKER_URL     ${configuredBroker || '(empty)'}${configuredBroker === BROKER_PLACEHOLDER ? '  ← the inert placeholder' : ''}`);
if (!configuredBase && !configuredBroker) {
  say('');
  say(`    ${NOT_CONFIGURED}`);
}

say('\n  Local servers listening right now:');
let found = null;
for (const c of LOCAL_CANDIDATES) {
  const r = await probe(c.baseUrl);
  if (r.ok) {
    say(`    ✓ ${c.label} at ${c.baseUrl} — ${r.models.length} model(s)${r.models.length ? `: ${r.models.slice(0, 4).join(', ')}` : ''}`);
    if (!found) found = { ...c, models: r.models };
  } else {
    say(`    · ${c.label} at ${c.baseUrl} — ${r.error}`);
  }
}
if (!found) say('    (none — start one, or pass --base-url to point at any OpenAI-compatible server)');

if (!USE) {
  say('\n  To choose one:');
  say('    npm run portable:ai -- --use local                       (uses a server found above)');
  say('    npm run portable:ai -- --use key --base-url … --model … --key …');
  say('    npm run portable:ai -- --use cloud --broker-url …        (needs a deployed broker — see hosted-broker/README.md)');
  say('');
  process.exit(0);
}

// ── choosing a source ───────────────────────────────────────────────────────
if (USE === 'cloud') {
  const url = flag('--broker-url') || configuredBroker;
  if (!url || url === BROKER_PLACEHOLDER) {
    say('\n  ✗ The paid default needs a DEPLOYED broker, and there is not one.');
    say(`    The shipped default is ${BROKER_PLACEHOLDER} — deliberately inert, so writing it would`);
    say('    configure nothing while looking configured. Deploy hosted-broker/ (see its README for');
    say('    the one-container steps), then pass --broker-url. Nothing was changed.\n');
    process.exit(2);
  }
  const r = await probe(`${url.replace(/\/+$/, '')}/v1`);
  if (!r.ok) {
    say(`\n  ✗ ${url} did not answer a models request (${r.error}). Nothing was changed.\n`);
    process.exit(1);
  }
  writeEnvLines(envLinesFor({ source: 'cloud', brokerUrl: url }));
  say(`\n  ✓ Morpheus Cloud broker set to ${url}.`);
  say(`    ${privacyLine('cloud')}\n`);
  process.exit(0);
}

if (USE !== 'local' && USE !== 'key') {
  say(`\n  ✗ Unknown --use "${USE}". Expected local, key or cloud. Nothing was changed.\n`);
  process.exit(2);
}

const baseUrl = flag('--base-url') || (USE === 'local' ? found?.baseUrl : '') || '';
let model = flag('--model') || '';
const key = flag('--key') || '';

if (!baseUrl) {
  say(`\n  ✗ ${USE === 'local' ? 'No local server was found on the usual ports' : '--base-url is required'}.`);
  say('    Nothing was changed. Pass --base-url to point at any OpenAI-compatible server.\n');
  process.exit(2);
}
if (!model) {
  // A base URL with no model means "use whatever that server has" — ask it, rather than complaining
  // that nothing was found, which is what the first version did and was simply wrong about the cause.
  const r = await probe(baseUrl);
  if (!r.ok) {
    say(`\n  ✗ ${baseUrl} did not answer a models request (${r.error}). Nothing was changed.\n`);
    process.exit(1);
  }
  model = r.models[0] || '';
  if (!model) {
    say(`\n  ✗ ${baseUrl} answered but listed no models. Pass --model explicitly. Nothing was changed.\n`);
    process.exit(2);
  }
}
if (USE === 'key' && !key) {
  say('\n  ✗ --key is required for your own provider. Nothing was changed.\n');
  process.exit(2);
}

const check = await probe(baseUrl);
if (!check.ok) {
  say(`\n  ✗ ${baseUrl} did not answer a models request (${check.error}). Nothing was changed.\n`);
  process.exit(1);
}
if (check.models.length && !check.models.includes(model)) {
  say(`\n  ! ${baseUrl} does not list "${model}" among its models (${check.models.slice(0, 4).join(', ')}).`);
  say('    Writing it anyway, because a server may serve more than it lists.\n');
}

writeEnvLines(envLinesFor({ source: USE, baseUrl, model, key }));
say(`\n  ✓ AI source set: ${model} at ${baseUrl}`);
say(`    ${privacyLine(USE)}`);
// The cost-ledger trap: a local model whose id matches no LOCAL_MODEL_PATTERNS entry is priced from
// DEFAULT_PRICING, so a call that cost nothing gets recorded as if it cost something — the same class
// of bug as gemini-3.5-flash-lite billing from a generic default.
if (USE === 'local' && !matchesLocalPattern(model, LOCAL_MODEL_PATTERNS)) {
  say('');
  say(`    ! "${model}" matches none of the local-model patterns (${LOCAL_MODEL_PATTERNS.slice(0, 6).join(', ')}, …),`);
  say('      so the cost ledger will price it from the generic default — a cost nobody pays, recorded as');
  say('      if someone did. Add the pattern to LOCAL_MODEL_PATTERNS in server/src/lib/costEstimate.js.');
}
say('');
process.exit(0);

/** Replace only the keys this wizard owns; every other line in .env is left as it was. */
function writeEnvLines(lines) {
  if (!existsSync(ENV_PATH)) {
    say('  ✗ server/.env is missing — run the setup first: npm run portable:setup');
    process.exit(1);
  }
  const kept = readEnv().split('\n').filter((l) => !AI_ENV_KEYS.some((k) => l.startsWith(`${k}=`)));
  writeFileSync(ENV_PATH, `${[...kept, ...lines].join('\n').replace(/\n+$/, '')}\n`);
  say(`  · server/.env updated: ${lines.map((l) => l.split('=')[0]).join(', ')} (values not printed)`);
}
