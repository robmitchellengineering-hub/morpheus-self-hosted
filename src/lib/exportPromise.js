// Does the ZIP we hand the operator actually run?
//
// WHY THIS EXISTS. The only user-facing way to get an app out of Morpheus was a client-side ZIP, and
// the button next to it promised *"Ready to run locally with zero platform dependency."* Nothing
// checked that, and the export made it worse: when the project had no `package.json` the export
// **invented** one containing `scripts: { start: 'node index.js' }`, and when it had no `README.md` it
// **invented** one saying `npm install && npm start`. Two independent guesses, and for a Python, static
// or compiled app — the market says Morpheus compiles to ten targets — the invented Node manifest is
// simply false. A README is only synthesised when *missing*, so an app that HAS a package.json but no
// README received a README naming a script that may not exist.
//
// The market's complaint about every builder in this category is exactly this gap: a prototype is
// exported as a pile of source, and the thing a person cannot get to is a RUNNING SYSTEM. So the export
// has two jobs here, and only two:
//
//   1. Ship what the project actually IS, and invent nothing. `exportContents` is the single place that
//      decides what goes in the ZIP, and it only ever removes.
//   2. Tell the truth about how to start it. `exportVerdict` names the command for each part, or says
//      plainly that nothing in the export says how to run it.
//
// Import-free and platform-free: the browser, `node --test` and the verify guard all run this same code.
//
// NOT the whole runnability story, deliberately. `server/src/lib/generatedAppCheck.js` decides whether the
// GENERATED app is buildable and installable (`RUNNABLE_APP_REQUIREMENTS`, `dependencyProblems`,
// `entryPointProblems`), and as of 2026-10-10 the build loop hands its findings to the REVIEWER, so they are
// raised while the app is being made rather than only here.
//
// ⚠️ THIS COMMENT USED TO CLAIM THAT CHECKER "runs where the app is made". IT DID NOT. Nothing under
// `server/src/functions` or `server/src/routes` imported it — it ran in the CI fixtures and nothing else — so an
// app that could not install or start could pass a build and be discovered at download. The claim was believed
// for as long as it took to grep for a caller. Two things fixed it: the loop now feeds the findings to the
// reviewer, and this sentence now says what is true.
//
// This module still asks the different question the export raises: does the thing the operator is about to
// download keep the promise printed on the button? Only the overlap of a start script naming a file that is not
// in the ZIP is re-checked here, because here it is the export's own lie rather than the generator's.

/**
 * Morpheus's own bookkeeping, written next to the app it describes. It ships in the export today and
 * is not part of the operator's app: the build plan is a record of how the code was made, not of what
 * it is. Never in the ZIP.
 */
export const GENERATOR_SCRATCH = [
  /(^|\/)\.plan\.json$/,
  /(^|\/)\.morpheus\/.*$/,
];

export const isScratch = (path) => GENERATOR_SCRATCH.some((re) => re.test(String(path || '')));

const CONTENT = (f) => (typeof f?.content === 'string' ? f.content : '');
const at = (files, path) => (files || []).find((f) => f.path === path);

/**
 * What the operator receives: every real file, minus Morpheus's scratch. **Adds nothing, ever.**
 *
 * This is the whole fix for the invented manifest. If a project has no `package.json`, the export does
 * not get one — it gets a verdict saying no way to start it was found. Inventing a file made the ZIP
 * *look* runnable, which is strictly worse than the operator being told what is missing, and it is the
 * same failure the security work was built to avoid: a report that claims more than it examined.
 */
export function exportContents(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && f.path.length > 0)
    .filter((f) => !isScratch(f.path))
    .map((f) => ({ path: f.path, content: CONTENT(f) }));
}

/**
 * The parts of a project, because they do not share one command.
 *
 * A backend is stored under a `backend/` prefix (the generator's own convention), so a project can be a
 * frontend at the root and a service underneath it — two programs in one ZIP, each with its own manifest.
 * The largest promise in the old copy was that one command starts the whole thing; for most projects
 * that was never true, and the honest version is one command *per part*.
 */
export function partsOf(files) {
  const list = exportContents(files);
  const parts = [];
  const root = list.filter((f) => !f.path.startsWith('backend/'));
  const backend = list.filter((f) => f.path.startsWith('backend/'));
  if (root.length) parts.push({ id: 'app', base: '', files: root });
  if (backend.length) parts.push({ id: 'backend', base: 'backend/', files: backend.map((f) => ({ ...f, path: f.path.slice('backend/'.length) })) });
  return parts;
}

const COMPOSE = /^(docker-)?compose\.ya?ml$/;
/** `node server/index.js`, `node ./src/main.mjs` — the script path, or null. */
function nodeTarget(script) {
  const m = /(?:^|\s)([^\s'"]+\.(?:js|mjs|cjs|ts))/.exec(String(script || ''));
  return m ? m[1].replace(/^\.\//, '') : null;
}

/**
 * The one command that starts a part, derived from the part's OWN files — never assumed.
 *
 * Order matters: a compose file is the most complete answer (it brings the database with it), then a
 * Node start script, then Python, then a static page that needs no runtime at all. `null` means the
 * part genuinely offers no way to start, and that is a finding rather than a default.
 */
export function startFor(part) {
  const files = part?.files || [];
  const base = part?.base ?? '';
  const has = (p) => Boolean(at(files, p));

  const compose = files.find((f) => COMPOSE.test(f.path));
  if (compose) return { kind: 'compose', command: 'docker compose up --build', evidence: `${base}${compose.path}` };

  const pkg = at(files, 'package.json');
  if (pkg) {
    const start = startScriptOf(pkg);
    if (start) {
      const target = nodeTarget(start);
      if (target && !has(target)) {
        // The manifest names a file the ZIP does not contain: `npm start` fails immediately. Reported
        // as no-start-command rather than as a command, because it is not one that works.
        return { kind: 'broken', command: null, evidence: `${base}package.json`, starts: start, missing: target };
      }
      return { kind: 'node', command: 'npm install && npm start', evidence: `${base}package.json` };
    }
  }

  if (has('requirements.txt')) {
    const entry = ['main.py', 'app.py', '__main__.py', 'run.py'].find(has);
    if (entry) return { kind: 'python', command: `pip install -r requirements.txt && python ${entry}`, evidence: `${base}${entry}` };
  }

  if (has('index.html') && !pkg) return { kind: 'static', command: `open ${base}index.html`, evidence: `${base}index.html` };

  return null;
}

function startScriptOf(pkg) {
  try {
    const data = JSON.parse(CONTENT(pkg));
    const start = data?.scripts?.start;
    return typeof start === 'string' && start.trim() ? start.trim() : null;
  } catch {
    return null;
  }
}

const CODE_BLOCK = /```[a-z]*\n([\s\S]*?)```/gi;
const INLINE = /`([^`\n]+)`/g;
const LOOKS_LIKE_A_COMMAND = /^(npm|npx|pnpm|yarn|node|python3?|pip3?|docker|docker-compose|open|make)\b/;

/**
 * The commands a README tells the operator to run.
 *
 * Read from fenced blocks and inline code spans, because that is where the instructions a person
 * actually follows live. A README is a promise in prose, and the export is the only thing that can
 * check the promise against what it is shipping.
 */
export function documentedCommands(text) {
  const src = typeof text === 'string' ? text : '';
  const found = [];
  for (const m of src.matchAll(CODE_BLOCK)) {
    for (const raw of m[1].split('\n')) found.push(raw);
  }
  for (const m of src.matchAll(INLINE)) found.push(m[1]);
  return [...new Set(found
    .map((line) => String(line).trim().replace(/^[$>]\s*/, '').trim())
    .filter((line) => LOOKS_LIKE_A_COMMAND.test(line))
    // A line that is a comment or an ellipsis placeholder is not an instruction.
    .filter((line) => !/^#/.test(line) && !/\.\.\./.test(line)))];
}

/** Is a documented command backed by something in this part? */
function commandIsBacked(command, part) {
  const files = part?.files || [];
  const has = (p) => Boolean(at(files, p));
  const parts = command.split(/\s+/);
  const [bin, sub] = parts;

  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const pkg = at(files, 'package.json');
    if (!pkg) return false;
    if (sub === 'install' || sub === 'ci' || sub === 'i') return true;
    // `npm start` / `npm run build` — the script has to exist, which is what makes it runnable.
    const scriptName = sub === 'run' ? parts[2] : sub;
    if (!scriptName) return true;
    try { return Boolean(JSON.parse(CONTENT(pkg))?.scripts?.[scriptName]); } catch { return false; }
  }
  if (bin === 'npx') return has('package.json');
  if (bin === 'node') {
    const target = nodeTarget(command);
    return !target || has(target) || files.some((f) => f.path.endsWith(`/${target}`));
  }
  if (bin === 'pip' || bin === 'pip3') {
    const i = parts.indexOf('-r');
    return i >= 0 ? has(parts[i + 1]) : has('requirements.txt');
  }
  if (bin === 'python' || bin === 'python3') {
    const target = parts[1];
    return !target || has(target) || files.some((f) => f.path.endsWith(`/${target}`));
  }
  if (bin === 'docker' || bin === 'docker-compose') {
    return files.some((f) => COMPOSE.test(f.path));
  }
  if (bin === 'open' || bin === 'make') {
    return bin === 'make' ? has('Makefile') : has(parts[1] || 'index.html');
  }
  return true;
}

const README = /^README(\.md|\.txt|\.markdown)?$/i;

/**
 * Where the export promises something it cannot deliver, in the operator's words rather than a rule name.
 *
 * Every finding is one of the ways a person ends up with a folder and no idea what to type — which is
 * the complaint this whole bet answers, so each one carries the fix and not just the complaint.
 */
export function exportProblems(files) {
  const parts = partsOf(files);
  const findings = [];
  const raw = Array.isArray(files) ? files.filter((f) => f && typeof f.path === 'string') : [];

  const scratch = raw.filter((f) => isScratch(f.path));
  if (scratch.length) {
    findings.push({
      id: 'scratch-shipped',
      severity: 'note',
      title: 'Morpheus\u2019s own build plan is inside the export',
      why: 'The plan records how the code was made, not what it is. It is Morpheus bookkeeping in the operator\u2019s project, and it names the provider and the model that wrote the code.',
      fix: 'Zip the app, not the workshop — the export drops it automatically.',
      evidence: scratch.map((f) => f.path),
    });
  }

  for (const part of parts) {
    const label = part.id === 'backend' ? 'the backend' : 'the app';
    const start = startFor(part);

    if (!start) {
      findings.push({
        id: 'no-start-command',
        severity: 'high',
        title: `Nothing in ${label} says how to start it`,
        why: 'The operator unzips it and has no first step. This is the exact gap between a prototype and a running system, and it is decided from the files rather than guessed.',
        fix: 'Add the one command that starts it: a "start" script in package.json, a docker-compose.yml, or a README that opens with the command.',
        evidence: [part.base || '.'],
      });
    } else if (start.kind === 'broken') {
      findings.push({
        id: 'start-entry-missing',
        severity: 'high',
        title: `${label}\u2019s start command runs a file that is not in the export`,
        why: `package.json says start runs "${start.starts}", but ${start.missing} is not among the files being downloaded, so the very first command fails.`,
        fix: `Include ${start.missing}, or point the "start" script at a file that ships.`,
        evidence: [start.evidence, start.missing],
      });
    }

    const readme = part.files.find((f) => README.test(f.path));
    if (readme) {
      const unbacked = documentedCommands(CONTENT(readme)).filter((c) => !commandIsBacked(c, part));
      if (unbacked.length) {
        findings.push({
          id: 'readme-command-unbacked',
          severity: 'high',
          title: `${readme.path} tells the operator to run something that cannot work`,
          why: 'A README is the only instruction most operators follow, so a command with nothing behind it is read as a broken app rather than as a missing file.',
          fix: 'Make the README name only commands this export can actually run, or add what they need.',
          evidence: [readme.path, ...unbacked],
        });
      }
    }
  }

  if (parts.length > 1) {
    findings.push({
      id: 'more-than-one-part',
      severity: 'note',
      title: 'This export holds more than one program',
      why: 'The frontend and the backend are separate programs with separate commands, so no single command starts the whole ZIP. Saying so is the difference between "it did not work" and "I had to run two things".',
      fix: 'Read the command for each part before starting; there is one for the app and one for the backend.',
      evidence: parts.map((p) => p.base || '.'),
    });
  }

  return findings;
}

const RANK = { high: 0, note: 1 };

/**
 * The sentence the operator is owed before or after the download: what to run, or what is missing.
 *
 * Deliberately a CHECKLIST and not a reassurance. "Runs anywhere" is the claim that made this feature
 * necessary, so the clean version names the command it verified instead of promising portability.
 */
export function exportVerdict(files) {
  const parts = partsOf(files);
  const problems = exportProblems(files).sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
  const blocking = problems.filter((p) => p.severity === 'high');

  const starts = parts.map((part) => ({ part: part.id, label: part.base || '.', ...(startFor(part) || { command: null, kind: 'none' }) }));
  const commands = starts.filter((s) => s.command);

  let summary;
  if (!parts.length) {
    summary = 'This project has no files yet, so there is nothing to run.';
  } else if (blocking.length) {
    summary = `Not one command away yet — ${blocking.map((p) => p.title).join('; ')}.`;
  } else if (commands.length === 1) {
    summary = `One command starts this: ${commands[0].command}`;
  } else if (commands.length > 1) {
    summary = `Two programs, two commands — ${commands.map((c) => `${c.label}: ${c.command}`).join(' · ')}`;
  } else {
    summary = 'The export does not say how to run this.';
  }

  // `ok` is "there is something here AND nothing blocking it". An empty project has no findings, so a
  // findings-only `ok` would report an empty ZIP as runnable — the same overclaim as a clean security
  // report on an app nobody examined.
  return { ok: blocking.length === 0 && parts.length > 0, parts: starts, problems, summary };
}

/** What the download flow needs in one call: the files to zip, and the truth about them. */
export function exportPlan(files) {
  return { files: exportContents(files), verdict: exportVerdict(files) };
}
