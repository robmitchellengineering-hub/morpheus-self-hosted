// Does the ZIP we hand the operator keep the promise printed on the button?
//
// WHY THIS EXISTS. The button said "Ready to run locally with zero platform dependency" and the export
// made that LOOK true by inventing files: no package.json in the project meant the ZIP got one with
// `scripts: { start: 'node index.js' }`, and no README.md meant the ZIP got one saying
// `npm install && npm start`. Two independent guesses that could contradict the real app — and for a
// Python, static or compiled project (ten targets ship) the invented Node manifest was simply false.
//
// So the checks here are two different jobs, and both matter:
//   1. BEHAVIOUR — call the pure module and assert what it returns for a good app, a liar, a Python
//      app, a static page, a broken start script and a two-part project. No model, no key, no credits.
//   2. WIRING — the export path and the two buttons must not go back to inventing files or promising
//      portability. Asserted on comment-stripped source, because the tenth time this repo was bitten
//      by a source check it was matching its own comment.
//
// Run:  node scripts/verify-export-promise.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportContents, exportProblems, exportVerdict, exportPlan, partsOf, startFor, documentedCommands, isScratch,
} from '../src/lib/exportPromise.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Comments stripped before matching source — a guard must never be satisfied by prose (H19). */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const ids = (files) => exportProblems(files).map((p) => p.id);

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const pkg = (scripts) => ({ path: 'package.json', content: JSON.stringify({ name: 'x', scripts }) });
const readme = (body) => ({ path: 'README.md', content: body });

// A generated app of the shape that runs: a manifest whose start script ships, and a README that opens
// with exactly that command.
const NODE_APP = [
  pkg({ start: 'node server.js' }),
  { path: 'server.js', content: "require('express')();" },
  { path: '.gitignore', content: '.env\n*.db\n' },
  readme('# App\n\n```bash\nnpm install\nnpm start\n```\n'),
];

console.log('\n1. the app that runs is reported as running, and nothing is invented');
check('a well-formed app has no findings', ids(NODE_APP), []);
check('…it is not blocked', exportVerdict(NODE_APP).ok, true);
check('…and the verdict names the command instead of promising portability',
  exportVerdict(NODE_APP).summary, 'One command starts this: npm install && npm start');
// The claim that made this feature necessary. A verdict must never re-assert it: the export cannot know
// a machine is portable, only what the files say.
check('…and never re-asserts "runs anywhere"',
  /runs? (anywhere|locally)|zero platform dependency|any machine|no platform/i.test(exportVerdict(NODE_APP).summary), false);

// The heart of the fix: when the project has no manifest, the export must not supply one.
const NO_MANIFEST = [{ path: 'index.html', content: '<html></html>' }, { path: 'style.css', content: 'a{}' }];
check('a project with no package.json does not get one',
  exportContents([...NO_MANIFEST, { path: 'app.js', content: 'x' }]).map((f) => f.path).sort(),
  ['app.js', 'index.html', 'style.css']);
check('…and a project with no README does not get one',
  exportContents(NO_MANIFEST).some((f) => /^README/i.test(f.path)), false);
check('…the export adds nothing at all, in any project shape',
  [NODE_APP, NO_MANIFEST, [{ path: 'main.py', content: 'x' }]]
    .every((f) => exportContents(f).length <= f.length && exportContents(f).every((o) => f.some((i) => i.path === o.path))), true);

console.log('\n2. Morpheus bookkeeping is not the operator\'s app');
check('the generator plan is recognised as scratch', isScratch('backend/.plan.json'), true);
check('…and is dropped from the export',
  exportContents([...NODE_APP, { path: 'backend/.plan.json', content: '{}' }]).some((f) => f.path.endsWith('.plan.json')), false);
// Reported when the caller hands over the RAW list, so the note is visible rather than silent.
check('…and its presence is still reported when seen',
  ids([...NODE_APP, { path: 'backend/.plan.json', content: '{}' }]), ['scratch-shipped']);

console.log('\n3. the export tells the truth about how to start it');
const LIAR = [pkg({ dev: 'vite' }), readme('# App\n\nRun `npm start`\n')];
check('a manifest with no start script is caught', ids(LIAR).includes('no-start-command'), true);
check('…and the README telling you to run it anyway is caught too',
  ids(LIAR).includes('readme-command-unbacked'), true);
check('…and the command is named as evidence, not just the file',
  exportProblems(LIAR).find((p) => p.id === 'readme-command-unbacked')?.evidence, ['README.md', 'npm start']);
check('a start script pointing at a file that is not in the ZIP is caught',
  ids([pkg({ start: 'node index.js' }), { path: 'server.js', content: 'x' }]).includes('start-entry-missing'), true);
check('…and the missing file is named',
  exportProblems([pkg({ start: 'node index.js' }), { path: 'server.js', content: 'x' }]).find((p) => p.id === 'start-entry-missing')?.why.includes('index.js'), true);
check('a README naming a file the export does not contain is caught',
  ids([pkg({ start: 'node server.js' }), { path: 'server.js', content: 'x' }, readme('# App\n\n```bash\nnode worker.js\n```\n')]).includes('readme-command-unbacked'), true);
check('a README naming a command with a real target is NOT a finding',
  ids([...NODE_APP, { path: 'worker.js', content: 'x' }, readme('# App\n\n```bash\nnpm install\nnpm start\nnode worker.js\n```\n')]), []);

console.log('\n4. one command per target, not npm for everything');
// Ten compile targets ship. Asserting `npm start` for a Python app would fail work that is perfect, and
// shipping the invented Node manifest for one is the lie this whole change is about.
check('a Python app gets the Python command',
  exportVerdict([{ path: 'requirements.txt', content: 'flask' }, { path: 'main.py', content: 'x' }]).summary,
  'One command starts this: pip install -r requirements.txt && python main.py');
check('…and no npm anywhere in its verdict',
  /npm/.test(exportVerdict([{ path: 'requirements.txt', content: 'flask' }, { path: 'main.py', content: 'x' }]).summary), false);
check('a static page is reported as a page, not a service',
  exportVerdict([{ path: 'index.html', content: '<html>' }]).summary, 'One command starts this: open index.html');
check('a compose file beats the manifest, because it brings the database',
  startFor(partsOf([pkg({ start: 'node s.js' }), { path: 's.js', content: 'x' }, { path: 'docker-compose.yml', content: 'services: {}' }])[0]).command,
  'docker compose up --build');

console.log('\n5. a project with two programs says so instead of pretending');
// The backend manifest has to be AT `backend/package.json` — the first fixture put both manifests at the
// root and then asserted two parts, which is H19's new habit in miniature: a fixture that cannot produce
// the condition makes the check agree with itself for the wrong reason. (It failed loudly here; the same
// mistake in a well-chosen fixture would have passed.)
const TWO_PART = [...NODE_APP, { path: 'backend/package.json', content: JSON.stringify({ scripts: { start: 'node index.js' } }) }, { path: 'backend/index.js', content: 'x' }];
check('the parts are found', partsOf(TWO_PART).map((p) => p.id), ['app', 'backend']);
check('…and two programs are reported as two commands, not one',
  ids(TWO_PART).includes('more-than-one-part'), true);
check('…and the verdict carries both, labelled',
  exportVerdict(TWO_PART).summary, 'Two programs, two commands — .: npm install && npm start · backend/: npm install && npm start');
check('a backend-only project is one part, and is not warned about',
  partsOf([{ path: 'backend/package.json', content: JSON.stringify({ scripts: { start: 'node index.js' } }) }, { path: 'backend/index.js', content: 'x' }]).map((p) => p.id), ['backend']);

console.log('\n6. what counts as an instruction');
check('fenced and inline commands are read',
  documentedCommands('# T\n\n```bash\nnpm install\nnpm start\n```\n\nrun `node s.js` then\n'),
  ['npm install', 'npm start', 'node s.js']);
check('prose is not a command', documentedCommands('You should install the dependencies carefully.'), []);
check('a comment line is not an instruction', documentedCommands('```bash\n# install first\nnpm install\n```'), ['npm install']);
check('an ellipsis placeholder is not an instruction', documentedCommands('```bash\nnpm install ...\n```'), []);
check('a prompt marker is stripped', documentedCommands('```bash\n$ npm start\n```'), ['npm start']);
check('a missing README is not a crash', Array.isArray(documentedCommands(undefined)), true);

console.log('\n7. the plan is the one place that decides what ships');
check('exportPlan returns the files and the verdict together',
  Object.keys(exportPlan(NODE_APP)).sort(), ['files', 'verdict']);
check('…over the same files the zip will contain',
  exportPlan(NODE_APP).files.map((f) => f.path).sort(), NODE_APP.map((f) => f.path).sort());
check('a malformed file list is not a crash',
  [undefined, null, 'nonsense', [{ path: 42 }]].every((f) => Array.isArray(exportContents(f)) && Array.isArray(exportProblems(f))), true);
check('a project with no files does not claim to be runnable',
  exportVerdict([]).ok, false);

console.log('\n8. the export path cannot go back to inventing files');
const hook = code(read('src/hooks/useWorkspace.js'));
// The exact two fabrications, as code rather than as prose.
check('the ZIP is no longer given a package.json', /zip\.file\(\s*['"]package\.json['"]/.test(hook), false);
check('…nor a README', /zip\.file\(\s*['"]README\.md['"]/.test(hook), false);
// The general form, because the two checks above only name the fabrications that were found by reading.
// There were THREE export paths and only two were found that way: `exportProject` and `BackendPanel`'s
// `downloadZip` were visible, and the EMAILED zip — the one nobody can inspect before it arrives — was
// found by this guard. No ZIP may ever be handed a file the project does not contain.
check('…no ZIP anywhere is given a file the project does not contain',
  /zip\.file\(\s*['"]/.test(hook), false);
check('…and every ZIP in the workspace is built from plan.files',
  (hook.match(/plan\.files\.forEach\(/g) || []).length, 2);
check('…and the export is built from the one mechanism', /exportPlan\(/.test(hook), true);
check('…so every file in the ZIP comes from the project', /plan\.files\.forEach\(/.test(hook), true);
// The caller has to be able to show the verdict, so it must be returned rather than swallowed.
check('…and the verdict is returned to the caller', /return plan\.verdict/.test(hook), true);
// An emailed ZIP has no button to hover, so the command has to travel with the mail — and the server
// function has to actually use it, or `runNote` is a channel that only looks like one.
check('…the email carries the command in the message',
  /runNote: plan\.verdict\.summary/.test(hook), true);
check('…and the server puts it in the email rather than dropping it',
  /\$\{note\}/.test(read('server/src/functions/emailProjectFiles.js')), true);

console.log('\n9. and the buttons tell the truth');
const bar = read('src/components/matrix/ProjectBar.jsx');
const panel = read('src/components/matrix/BackendPanel.jsx');
const PROMISE = /zero platform dependency|Ready to run locally|run anywhere|runs anywhere/i;
check('the ZIP hint no longer promises portability', PROMISE.test(code(bar)), false);
check('…nor does the backend ZIP hint', PROMISE.test(code(panel)), false);
check('the backend export uses the same mechanism', /exportPlan\(/.test(code(panel)), true);
// Both buttons must SHOW what was found; a verdict nobody displays is the same silent promise again.
check('the workspace button shows the verdict', /verdict\.summary/.test(code(bar)), true);
check('the backend button shows the verdict', /plan\.verdict\.summary/.test(code(panel)), true);
check('…and both distinguish "ready" from "not runnable yet"',
  /verdict\.ok \?/.test(code(bar)) && /plan\.verdict\.ok \?/.test(code(panel)), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a downloaded app could promise a way to run that does not exist\n');
  process.exit(1);
}
console.log('a downloaded app arrives as the real thing, with the command that starts it or the gap named\n');
