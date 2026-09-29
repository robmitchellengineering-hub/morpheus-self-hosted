// Does the AI-source wizard tell the truth about where the AI comes from?
//
// WHY THIS EXISTS. This is the step where a local install decides whether the operator's code and
// prompts stay on their machine, so being wrong is not a UX bug — it is the privacy claim being wrong.
// Three things are asserted:
//
//   1. the SOURCE TABLE — three ways in, what each costs, and what each does with the data, including
//      the one that does NOT work yet (the paid default needs a broker that is not deployed);
//   2. the ORDER — the wizard must describe the same resolution order `ai.js` actually uses, asserted
//      against that file rather than re-implemented here;
//   3. the LEDGER TRAP — a local model whose id matches no LOCAL_MODEL_PATTERNS entry is priced from
//      the generic default, recording a cost nobody pays. That is the gemini-3.5-flash-lite bug in a
//      different disguise, so the wizard warns instead of silently writing it.
//
// Dependency-free, so it runs in CI's no-install guards job. It also EXECUTES the wizard's read-only
// path — the lesson from verify-portable-remote.mjs, where a wrong import passed every text assertion.
//
// Run:  node scripts/verify-portable-ai.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL_PATTERNS } from '../server/src/lib/costEstimate.js';
import {
  AI_SOURCES, LOCAL_CANDIDATES, BROKER_PLACEHOLDER, AI_ENV_KEYS, NOT_CONFIGURED,
  matchesLocalPattern, envLinesFor, privacyLine,
} from '../server/src/lib/portableAi.js';
import { NOT_INSTALLED_YET } from '../server/src/lib/portableSetup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. three ways in, and the truth about each');
check('there are exactly three sources', AI_SOURCES.map((s) => s.id).join(','), 'local,key,cloud');
check('a model on this machine works today', AI_SOURCES.find((s) => s.id === 'local').worksToday, true);
check('your own key works today', AI_SOURCES.find((s) => s.id === 'key').worksToday, true);
// The honest one. The paid default is decided but the broker is not deployed, and claiming otherwise
// is what this repo keeps catching in its own documents.
check('the paid default is marked as NOT working today', AI_SOURCES.find((s) => s.id === 'cloud').worksToday, false);
check('…and says why, naming the broker', /NOT DEPLOYED YET/.test(AI_SOURCES.find((s) => s.id === 'cloud').how), true);
check('every source states a cost and a privacy consequence',
  AI_SOURCES.every((s) => s.costs && s.privacy), true);
check('the privacy sentence names where the data goes per source',
  [privacyLine('local'), privacyLine('key'), privacyLine('cloud')].map((p) => /never leave|go to that provider|Morpheus infrastructure/.test(p)).join(','),
  'true,true,true');
check('an unknown source promises nothing', /nothing about your data can be promised/.test(privacyLine('nope')), true);
check('a fresh install is told what is wrong, not left guessing',
  /nowhere to go/.test(NOT_CONFIGURED) && /(not deployed yet)/.test(NOT_CONFIGURED), true);

console.log('\n2. the order matches ai.js, not a comment here');
// Positional, against the real resolver: account override, then this deployment's env, then the
// Morpheus gateway. A checker that copies the order would agree with itself while the meter drifted.
const ai = read('server/src/ai.js');
const iCustom = ai.indexOf("settings?.ai_mode === 'custom'");
const iEnv = ai.indexOf('process.env.LLM_API_KEY');
const iGateway = ai.indexOf('aiGatewayDefault()');
check('all three tiers are present in ai.js', iCustom > 0 && iEnv > 0 && iGateway > 0, true);
check('…and resolve in the order this module documents', iCustom < iEnv && iEnv < iGateway, true);

console.log('\n3. the placeholder is the one hostedDefaults.js uses');
const hosted = read('server/src/config/hostedDefaults.js');
check('the inert broker URL is the same string in both files',
  [BROKER_PLACEHOLDER, hosted.includes(BROKER_PLACEHOLDER)].join(','), 'https://broker.morpheus.invalid,true');

console.log('\n4. the cost-ledger trap');
check('a qwen model is recognised as local', matchesLocalPattern('qwen2.5:7b', LOCAL_MODEL_PATTERNS), true);
check('a llama model too', matchesLocalPattern('llama3.2:latest', LOCAL_MODEL_PATTERNS), true);
// Measured against the real list: this is the case that gets priced from DEFAULT_PRICING.
check('a deepseek-r1 local model is NOT recognised — the trap the wizard warns about',
  matchesLocalPattern('deepseek-r1:7b', LOCAL_MODEL_PATTERNS), false);
check('no model id is not a match', matchesLocalPattern('', LOCAL_MODEL_PATTERNS), false);
check('the local ports are conventions, and there are at least three to probe',
  LOCAL_CANDIDATES.length >= 3 && LOCAL_CANDIDATES.every((c) => c.baseUrl.startsWith('http://127.0.0.1:')), true);

console.log('\n5. what gets written, and nothing else');
check('a local source writes the three LLM lines, with a placeholder key the tier requires',
  envLinesFor({ source: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' }).join('|'),
  'LLM_BASE_URL=http://127.0.0.1:11434/v1|LLM_API_KEY=local|LLM_MODEL=qwen2.5:7b');
check('an own key uses the key it was given',
  envLinesFor({ source: 'key', baseUrl: 'https://api.example.com/v1', model: 'm', key: 'sk-x' }).includes('LLM_API_KEY=sk-x'), true);
check('the paid source writes the broker URL and no LLM lines',
  envLinesFor({ source: 'cloud', brokerUrl: 'https://broker.example.com' }).join('|'), 'MORPHEUS_BROKER_URL=https://broker.example.com');
check('an unknown source throws rather than writing something',
  (() => { try { envLinesFor({ source: 'nope' }); return 'no throw'; } catch { return 'threw'; } })(), 'threw');
check('the wizard owns exactly those four keys', AI_ENV_KEYS.join(','), 'LLM_BASE_URL,LLM_API_KEY,LLM_MODEL,MORPHEUS_BROKER_URL');

console.log('\n6. the script itself');
const script = read('scripts/portable-ai.mjs');
check('it edits .env in place, touching only the keys it owns',
  /filter\(\(l\) => !AI_ENV_KEYS\.some\(\(k\) => l\.startsWith\(`\$\{k\}=`\)\)\)/.test(script), true);
check('it never prints a key value', /console\.log[^\n]*\$\{key\}|say\([^\n]*\$\{flag\('--key'\)/.test(script), false);
check('it refuses the paid default while the broker is the inert placeholder',
  /url === BROKER_PLACEHOLDER/.test(script) && /configure nothing while looking configured/.test(script), true);
check('the read-only path exits before anything is written',
  script.indexOf('if (!USE) {') > 0 && script.indexOf('if (!USE) {') < script.indexOf('writeEnvLines(envLinesFor'), true);
check('probes are bounded, so a hung server cannot hang the wizard', /AbortSignal\.timeout\(/.test(script), true);

console.log('\n7. it runs (a source check cannot see a wrong import or a bad probe)');
const proc = spawnSync(process.execPath, [join(ROOT, 'scripts/portable-ai.mjs')], { encoding: 'utf8', timeout: 60000 });
const said = `${proc.stdout}${proc.stderr}`;
check('the read-only path exits 0', proc.status, 0);
check('…and reports the sources and the local-server sweep', /three|Local servers listening|No AI source is configured/.test(said), true);
check('…and never prints a stack trace', /SyntaxError|ERR_MODULE_NOT_FOUND|at ModuleJob/.test(said), false);

console.log('\n8. the lists that say what is missing have moved with it');
check('the installer no longer lists the AI choice as missing',
  NOT_INSTALLED_YET.some((n) => /^A wizard for choosing where AI comes from/.test(n)), false);
check('…and names it as a command instead', NOT_INSTALLED_YET.some((n) => /portable:ai/.test(n)), true);
check('the bundle README says the same', /portable:ai/.test(read('server/src/lib/portableBundle.js')), true);
check('reality.mjs reports it', /portable-ai/i.test(read('scripts/reality.mjs')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a local install could be told something untrue about where its code goes\n');
  process.exit(1);
}
console.log('the AI source is chosen explicitly, priced honestly, and says where the data goes\n');
