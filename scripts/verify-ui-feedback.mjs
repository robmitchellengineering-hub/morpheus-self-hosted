// Does a generated app tell the user what it is doing, and is the operator told how it behaves?
//
// WHY THIS EXISTS. Security was the first posture; this is the second, and it is the same shape with the
// opposite failure mode. An app that never shows a busy state, never says "3 of 12", swallows a failure
// with nothing on screen and clears the form on the way out is not dangerous — it is UNTRUSTWORTHY, and
// none of it raises an error anywhere. The planner and the coder are both given the ten rules; this proves
// the rules are the ones actually checked, and that the checks can fire.
//
// The checks are pure functions over a generated file list, so every finding is asserted here without a
// model, a key or a credit. What this guard is really testing is the CONSERVATISM: a false finding costs
// the operator's trust, so every check must require a real code shape — and comments and string literals
// must be stripped before any check runs (H19 records six guards this repo shipped that were satisfied by
// their own prose).
//
// Run:  node scripts/verify-ui-feedback.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UI_FEEDBACK_RULES, UI_FEEDBACK_CHECKS, UI_FEEDBACK_PROMPT_BLOCK, UI_FEEDBACK_ACCEPTANCE,
  uiFeedbackFindings, uiFeedbackSummary, isUiApp, stripProse,
} from '../server/src/lib/uiFeedback.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const ids = (files) => uiFeedbackFindings(files).map((f) => f.id);
const EXPECTED_IDS = ['silent-fetch', 'no-pending-state', 'unconfirmed-destructive', 'input-lost', 'no-empty-state', 'no-progress-surface'];

// A clean UI app: the shape the generator is asked to produce, with every one of the ten rules visibly
// satisfied. The fixtures are written so no string interpolation is evaluated by THIS file — inside a
// template literal a `${...}` in the fixture would run here, not in the fixture.
const GOOD = [
  { path: 'package.json', content: '{ "name": "good-app", "scripts": { "dev": "vite" } }\n' },
  { path: 'index.html', content: '<!doctype html>\n<div id="root"></div>\n<script type="module" src="/src/main.jsx"></script>\n' },
  { path: 'src/main.jsx', content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n" },
  { path: 'README.md', content: '# Good app\n\nnpm install && npm run dev\n' },
  { path: 'src/App.jsx', content: [
    "import { useState } from 'react';",
    "import axios from 'axios';",
    '',
    'export default function App() {',
    '  const [items, setItems] = useState([]);',
    "  const [title, setTitle] = useState('');",
    '  const [saving, setSaving] = useState(false);',
    '  const [progress, setProgress] = useState(0);',
    '  const [error, setError] = useState(null);',
    '',
    '  async function handleSave(e) {',
    '    e.preventDefault();',
    '    setSaving(true);',
    '    try {',
    "      const res = await axios.post('/api/items', { title });",
    "      setTitle('');",
    '      setItems([...items, res.data]);',
    '    } catch (err) {',
    "      setError('Could not save the item. Try again.');",
    '    } finally {',
    '      setSaving(false);',
    '    }',
    '  }',
    '',
    '  async function handleUpload(file) {',
    '    const form = new FormData();',
    "    form.append('file', file);",
    '    try {',
    "      await axios.post('/api/upload', form, {",
    '        onUploadProgress: (e) => setProgress((e.loaded / e.total) * 100),',
    '      });',
    '    } catch (err) {',
    "      setError('Upload failed. Check your connection and try again.');",
    '    }',
    '  }',
    '',
    '  function handleRemove(id) {',
    "    if (!window.confirm('Remove this item?')) return;",
    "    axios.delete('/api/items/' + id).catch(() => setError('Could not remove it.'));",
    '  }',
    '',
    '  return (',
    '    <main>',
    '      <form onSubmit={handleSave}>',
    '        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />',
    "        <button disabled={saving}>{saving ? 'Saving' : 'Save'}</button>",
    '      </form>',
    '      {error && <p>{error}</p>}',
    '      <progress value={progress} max="100" />',
    '      {items.length === 0 ? (',
    '        <p>Nothing here yet.</p>',
    '      ) : (',
    '        <ul>{items.map((i) => <li key={i.id}>{i.name} <button onClick={() => handleRemove(i.id)}>Remove</button></li>)}</ul>',
    '      )}',
    '    </main>',
    '  );',
    '}',
  ].join('\n') },
];

// A bad UI app that trips every one of the six checks, on purpose:
//   silent-fetch          a bare `fetch` and a bare `axios.post` with no catch and no failure surface
//   no-pending-state      an async onSubmit handler with no pending/disabled/loading state anywhere
//   unconfirmed-destructive  `axios.delete` with no confirmation step
//   input-lost            `setTitle('')` immediately before the `await`
//   no-empty-state        `items.map(...)` with no length/empty branch
//   no-progress-surface   `handleUpload` with no count, percentage or elapsed-time reference
const BAD = [
  { path: 'src/App.jsx', content: [
    "import { useState } from 'react';",
    "import axios from 'axios';",
    '',
    'export default function App() {',
    '  const [items, setItems] = useState([]);',
    "  const [title, setTitle] = useState('');",
    '',
    '  async function handleSubmit(e) {',
    '    e.preventDefault();',
    "    setTitle('');",
    "    await fetch('/api/items', { method: 'POST', body: JSON.stringify({ title }) });",
    '    setItems([]);',
    '  }',
    '',
    '  function handleUpload(file) {',
    "    axios.post('/api/upload', file);",
    '  }',
    '',
    '  return (',
    '    <div>',
    '      <form onSubmit={handleSubmit}>',
    '        <input value={title} onChange={(e) => setTitle(e.target.value)} />',
    '        <button type="submit">Save</button>',
    '      </form>',
    '      <ul>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>',
    "      <button onClick={() => axios.delete('/api/items/' + items[0].id)}>Clear all</button>",
    '      <button onClick={handleUpload}>Upload</button>',
    '    </div>',
    '  );',
    '}',
  ].join('\n') },
];

// Not a UI app: a generated Express backend and a non-UI compile target. No screens, so there is nothing
// to check — which must be reported as NOT EXAMINED, never as a clean bill (H17).
const NON_UI = [
  { path: 'server/index.js', content: "const express = require('express');\napp.get('/api/tasks', list);\n" },
  { path: 'package.json', content: '{ "name": "backend", "scripts": { "start": "node server/index.js" } }\n' },
  { path: 'firmware.ino', content: 'void setup() { Serial.begin(9600); }\nvoid loop() {}\n' },
];

console.log('\n1. a good UI app is clean, and the report says what that means');
check('no findings on a well-formed UI app', ids(GOOD), []);
check('…and the app is recognised as a UI app', isUiApp(GOOD), true);
// The most important sentence for a UI report: "no findings" is NOT "usable". The ten rules cannot be
// verified from the files — only the patterns can — so the clean summary must not read as a pass.
const cleanSummary = uiFeedbackSummary([], { filesExamined: GOOD.length, uiApp: true });
check('the clean summary refuses to claim the app is usable', /not the same as "usable"/.test(cleanSummary), true);
check('…and claims nothing of its own while doing so', (cleanSummary.match(/usab/gi) || []).length, 1);
check('…and does not reach for a synonym either',
  /\b(fully|completely|thoroughly|all)\s+(verified|checked|usable|tested|covered)\b/i.test(cleanSummary), false);
check('…and names how much it examined', /across 5 file\(s\)/.test(cleanSummary), true);
check('a report on NOTHING says nothing is claimed',
  /Nothing was examined, so nothing is claimed/.test(uiFeedbackSummary([], { filesExamined: 0, uiApp: true })), true);

console.log('\n2. every check fires on the bad app and stays quiet on the good one');
// And the bad fixture really does contain all six conditions — a fixture that silently loses one would
// make its assertion green for a reason unrelated to the check (H19, the fixture half).
check('the bad fixture trips exactly the six checks',
  ids(BAD).slice().sort(), EXPECTED_IDS.slice().sort());
check('the checks are exactly the documented six', UI_FEEDBACK_CHECKS.map((c) => c.id), EXPECTED_IDS);
for (const c of UI_FEEDBACK_CHECKS) {
  check(`"${c.id}" fires on the bad fixture`, ids(BAD).includes(c.id), true);
  check(`…and stays quiet on the good one`, ids(GOOD).includes(c.id), false);
}
for (const c of UI_FEEDBACK_CHECKS) {
  check(`"${c.id}" is HIGH or note`, ['high', 'note'].includes(c.severity), true);
}
check('silent-fetch is HIGH — it is the failure the user cannot see',
  uiFeedbackFindings(BAD).find((f) => f.id === 'silent-fetch')?.severity, 'high');
check('no-progress-surface is a NOTE — a slow screen is not a hole',
  uiFeedbackFindings(BAD).find((f) => f.id === 'no-progress-surface')?.severity, 'note');

console.log('\n3. prose is not code — comments and string literals cannot create a finding');
check('a comment is removed before matching', stripProse("// fetch('/api/x')\nconst a = 1;").includes('fetch'), false);
check('…and a string literal is removed too', stripProse("const s = \"fetch('/api/x')\";").includes('fetch'), false);
check('…and a template literal is removed too', stripProse('const s = `fetch("/api/x")`;').includes('fetch'), false);
check('…but real code survives', stripProse("fetch('/api/x');").includes('fetch'), true);
// The whole point, asserted the way the repo's own H19 demands: a file whose ONLY destructive call, list
// render, network call, long operation and input clear are inside prose must produce NO findings at all.
const PROSE_ONLY = [{ path: 'src/Prose.jsx', content: [
  "// fetch('/api/items') and axios.delete('/api/items/1') and items.map((i) => i)",
  "/* setTitle('') then await fetch('/api/items') */",
  'const note = "handleUpload(file) calls sync() and setTitle(\'\')";',
  'const other = `compileProject() with no progress`;',
  'export default function Prose() { return <div />; }',
].join('\n') }];
check('a UI file whose only shapes are prose produces no findings', ids(PROSE_ONLY), []);

console.log('\n4. a non-UI app is NOT examined — never "clean"');
check('a backend-only app is not a UI app', isUiApp(NON_UI), false);
check('…and no check runs over it', ids(NON_UI), []);
const nonUiSummary = uiFeedbackSummary([], { filesExamined: NON_UI.length, uiApp: false });
check('…and its summary says NOT examined', /NOT examined/.test(nonUiSummary), true);
check('…and it denies being a pass', /not a pass/.test(nonUiSummary), true);
check('…and it never wears the word "clean"', /\bclean\b/i.test(nonUiSummary), false);
check('a plain .js file with no JSX is not a UI app',
  isUiApp([{ path: 'server/routes/tasks.js', content: 'router.get("/api/tasks", list);' }]), false);
check('a .js file that really renders JSX is one',
  isUiApp([{ path: 'src/widget.js', content: "export default function W() { return <button onClick={go}>Go</button>; }" }]), true);

console.log('\n5. the report is actionable and its evidence is a path');
const badFindings = uiFeedbackFindings(BAD);
check('high findings sort first', badFindings[0].severity, 'high');
check('every finding says WHY it matters', UI_FEEDBACK_CHECKS.every((c) => typeof c.why === 'string' && c.why.length > 40), true);
check('every finding comes with a fix, not just a complaint', UI_FEEDBACK_CHECKS.every((c) => typeof c.fix === 'string' && c.fix.length > 20), true);
check('every finding carries a named reason for THIS hit',
  badFindings.every((f) => typeof f.detail === 'string' && f.detail.length > 10), true);
check('every finding carries a path, and it names a real file',
  badFindings.every((f) => typeof f.path === 'string' && f.path.length > 0 && (BAD.some((b) => b.path === f.path) || f.path === '(check failed to run)')), true);
check('the evidence is the path, never the file content',
  badFindings.every((f) => !f.path.includes('import') && !f.path.includes('\n')), true);
check('the summary names the app as a UI app when it is one',
  /UI feedback finding|note\(s\)|not the same as/.test(uiFeedbackSummary(badFindings, { filesExamined: BAD.length, uiApp: true })), true);
check('a malformed file entry does not crash the checker', Array.isArray(uiFeedbackFindings([null, {}, { path: 42 }])), true);
check('a missing file list is not a crash', Array.isArray(uiFeedbackFindings(undefined)), true);
// A check that throws must report that it did not run rather than reading as clean (H17). This is
// exercised BEHAVIOURALLY — a real throwing check is pushed onto the exported list and run — because the
// security guard's version of this assertion only re-tests that `env-committed` fires, which it does with
// or without the try/catch, so its name overclaims what it proves.
UI_FEEDBACK_CHECKS.push({
  id: 'throws-on-purpose',
  severity: 'note',
  title: 'A check injected by the guard to prove the throw path',
  why: 'Not a real rule — the guard needs a check that throws to prove a failed check never reads as clean.',
  fix: 'Nothing to fix; this entry exists only inside the guard run.',
  applies: () => { throw new Error('injected by verify-ui-feedback.mjs'); },
});
let thrownFindings;
try {
  thrownFindings = uiFeedbackFindings(BAD);
} finally {
  UI_FEEDBACK_CHECKS.pop();
}
check('a check that throws reports that it did not run rather than reading as clean',
  thrownFindings.some((f) => f.id === 'throws-on-purpose' && f.path === '(check failed to run)'), true);

console.log('\n6. the rules the app is CHECKED against are the rules it is GIVEN');
check('the prompt block carries all ten rules', UI_FEEDBACK_RULES.every((r) => UI_FEEDBACK_PROMPT_BLOCK.includes(r.rule)), true);
check('…one numbered line per rule',
  UI_FEEDBACK_PROMPT_BLOCK.split('\n').filter((l) => /^\s+\d+\.\s/.test(l)).length, 10);
check('…and every rule has a distinct id', new Set(UI_FEEDBACK_RULES.map((r) => r.id)).size, 10);
check('…and ends by saying exactly these are the rules checked',
  /checked against exactly these/.test(UI_FEEDBACK_PROMPT_BLOCK), true);
// A cost bound, not a style rule: this block is paid for on every planner and coder call. If it grows
// past this, the change should say so rather than spend more context quietly.
check('…and stays inside its context budget', UI_FEEDBACK_PROMPT_BLOCK.length < 1600, true);
check('the acceptance checklist names the five things to try',
  ['large upload', 'unplug the network', 'wrong password', 'empty file', 'clicking again']
    .every((s) => UI_FEEDBACK_ACCEPTANCE.includes(s)), true);

console.log('\n7. both generating paths give the rules to the planner AND the coder, and report the result');
const rawChat = read('server/src/functions/chatWithMorpheus.js');
const rawGen = read('server/src/functions/generateBackend.js');
const rawPlan = read('server/src/functions/planBackend.js');
const codeChat = code(rawChat);
const codeGen = code(rawGen);
// Anchored INSIDE each template literal, so a comment or a different prompt cannot satisfy it. `[^\`]*`
// stops at the literal's own closing backtick — a lazy `[\s\S]*?` would scan straight out of one literal
// into the next, which is exactly how a mutation moved the block onto one branch and still passed (H19).
check('the main build\'s planner is told the rules',
  /const PLANNER_INSTRUCTIONS = `[^`]*\$\{UI_FEEDBACK_PROMPT_BLOCK\}/.test(rawChat), true);
check('…and its coder is told them too',
  /const CODER_INSTRUCTIONS = `[^`]*\$\{UI_FEEDBACK_PROMPT_BLOCK\}/.test(rawChat), true);
check('…once per prompt, as the one mechanism rather than ad hoc',
  (rawChat.match(/\$\{UI_FEEDBACK_PROMPT_BLOCK\}/g) || []).length, 2);
check('the backend architecture planner is told the rules',
  /const prompt = `[^`]*\$\{UI_FEEDBACK_PROMPT_BLOCK\}/.test(rawPlan), true);
check('the backend generator\'s planner is told the rules',
  /const planPrompt = `[^`]*\$\{UI_FEEDBACK_PROMPT_BLOCK\}/.test(rawGen), true);
check('…and its coder is told them too',
  /const writePrompt = `[^`]*\$\{UI_FEEDBACK_PROMPT_BLOCK\}/.test(rawGen), true);
check('…once per prompt there, too',
  (rawGen.match(/\$\{UI_FEEDBACK_PROMPT_BLOCK\}/g) || []).length, 2);
// The report itself, over the WHOLE project: the empty states and the long operations are properties of
// the app, not of this turn's diff.
check('the main build examines the whole project', /uiFeedbackFindings\(projectFiles\)/.test(codeChat), true);
check('…and decides what a UI app is from the files', /isUiApp\(projectFiles\)/.test(codeChat), true);
check('…and reports it in the reply', /UI FEEDBACK:/.test(rawChat), true);
// RAW, not `code()`: the reply sentence lives inside a template literal, and `code()` strips line
// comments — which is exactly what the `// UI CHECK:` line looks like.
check('…and carries the acceptance checklist in the reply',
  /\/\/ UI CHECK: \$\{UI_FEEDBACK_ACCEPTANCE\}/.test(rawChat), true);
// Only for a turn that changed the app. The `if (uiApp) ...` version was the first attempt, and it put a
// build checklist on the end of every conversational reply about a UI project — the block below is reached
// on a `needsCode:false` turn too.
check('…and only for a turn that actually changed the app',
  /appliedCount\(appliedOps\) > 0\) fullReply \+= `\\n\\n\/\/ UI CHECK/.test(rawChat), true);
check('…and in the result payload', /uiFeedback: uiFeedbackReport/.test(codeChat), true);
check('…and a failed check is reported, not treated as clean',
  /the UI feedback check could not run/.test(rawChat), true);
check('the backend generator examines the whole project too', /uiFeedbackFindings\(projectFiles\)/.test(codeGen), true);
check('…and returns it', /uiFeedback,/.test(codeGen), true);
check('…and reports a failed check rather than clean',
  /the UI feedback check could not run/.test(rawGen), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a generated app can ship with silent work, lost input or an unconfirmed delete, with nobody told\n');
  process.exit(1);
}
console.log('a generated app is asked to show its work, is checked for the six shapes that hide it, and the operator is told which files to look at\n');
