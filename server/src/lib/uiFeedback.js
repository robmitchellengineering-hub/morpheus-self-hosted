// What a generated app's screens TELL the user while they are working, and what they do not.
//
// WHY THIS EXISTS. Security was the first posture: an app that ships a secret is dangerous in a way
// nobody sees until it is too late. This is the second, and it is the same shape with the opposite
// failure mode — an app that never says what it is doing is not dangerous, it is UNTRUSTWORTHY. The
// operator clicks, the button does nothing visible, they click again, the upload silently fails, the
// typed title is gone. None of that raises an error anywhere; it just makes the app feel broken.
//
// WHAT THIS IS NOT. It is not a usability audit and it must not pretend to be one. It does not render
// anything, it does not measure a real interaction, and it cannot tell whether a spinner is in a sensible
// place. Every finding is a pattern with a named reason, so the operator can judge it.
//
// CONSERVATIVE BY DESIGN. A false "your app hides its progress" costs the operator's trust in the whole
// report, so every check prefers a miss over a false alarm: it requires a real CODE shape (a call, a
// handler, a state setter), never a keyword that prose could supply. Comments and string/template
// literals are removed before any check runs — this repo has been bitten by prose satisfying a pattern
// check at least eight times (H19), and a comment that says `fetch(` is not a network call.
//
// REPORTED, NEVER ENFORCED. Nothing here blocks a build, refuses a reply or changes whether code lands.
// The operator is told; nothing is stopped.
//
// UI APPS ONLY. A project with no UI files has nothing to check. It is reported as NOT EXAMINED rather
// than clean — "nothing was found" and "nothing was looked at" are different sentences (H17).
//
// Import-free, so the guard runs in CI's no-install job and the caller can use it anywhere.

/** Severity, worst first, so a report reads in the order a person should work. */
const SEVERITY_RANK = { high: 0, note: 1 };

/**
 * The ten rules, as data. This is the product: each is one line the planner and the coder are given, and
 * the same ten lines the guard asserts are present in the prompt block.
 *
 * The `why` is not shown to the model (it keeps the block short); it is here so a reader of a report can
 * see the reasoning without reconstructing it from the repo's history.
 */
export const UI_FEEDBACK_RULES = [
  {
    id: 'no-silent-work',
    rule: 'No silent work — any action that can take about a second shows a busy state, and the control that started it is disabled and relabelled while it runs.',
    why: 'A control that looks identical before, during and after is a control the user clicks again — the double-submit is the symptom, not the cause.',
  },
  {
    id: 'say-what-and-how-far',
    rule: 'Say what, and how far — name the work and the count where it is knowable ("Uploading 3 of 12").',
    why: 'A named step tells the user the app is doing the thing they asked for; an unlabelled spinner could be anything.',
  },
  {
    id: 'honest-time',
    rule: 'Honest time — say up front when something can take minutes, and never show a percentage that is not real.',
    why: 'An invented percentage that sticks at 90% teaches the user the bar means nothing, so the real progress stops being read either.',
  },
  {
    id: 'every-action-ends',
    rule: 'Every action ends with a verdict — done, failed, or nothing to do; never leave the user guessing.',
    why: 'The most common failure is not an error, it is silence after the work finished — the user cannot tell "done" from "never started".',
  },
  {
    id: 'failure-names-cause-and-next-step',
    rule: "Failure names the cause and the next step in the user's language, never a raw provider error.",
    why: 'A stack trace or a provider error string tells the user nothing they can act on, so the only rational response left is to retry blindly.',
  },
  {
    id: 'never-lose-input',
    rule: 'Never lose what the user typed — a failed save keeps the input on screen.',
    why: 'Retyping is the most expensive thing a form can ask of someone, and it is entirely avoidable.',
  },
  {
    id: 'confirm-the-irreversible',
    rule: 'Confirm the irreversible once, naming the thing.',
    why: 'A confirmation that names the item ("Delete report.pdf?") is a real decision; one that says "Are you sure?" is a reflex the user learns to click through.',
  },
  {
    id: 'disable-what-cannot-work',
    rule: 'Disable a control that cannot work yet, and say why — never a click that does nothing.',
    why: 'A control that is present and inert reads as a broken app; a disabled one with a reason reads as a rule.',
  },
  {
    id: 'design-the-states',
    rule: 'Design the empty, loading and error states — never a blank panel.',
    why: 'The blank panel is ambiguous in the worst way: it looks the same whether there is no data, the request is still running, or it failed.',
  },
  {
    id: 'long-wait-looks-alive',
    rule: 'A long wait must look alive — show elapsed time.',
    why: 'A frozen bar and a frozen app are indistinguishable, so the user kills a job that was running perfectly.',
  },
];

/**
 * The checklist that belongs with any UI report, because none of the ten rules can be verified from the
 * files alone. This is the one part of the posture a person has to do by hand, and it is deliberately
 * short enough to actually run before trusting an app.
 */
export const UI_FEEDBACK_ACCEPTANCE =
  'Try it before you trust it: a large upload; unplug the network mid-upload; a wrong password; an empty file; and clicking again while it is busy.';

/**
 * Strip comments and string/template literals, so a check can only ever be satisfied by CODE.
 *
 * This is the load-bearing function of the whole module. H19 records six guards this repo shipped that
 * were satisfied by the bug they existed to prevent, and two of those matched their own comment quoting
 * the forbidden thing. A `// TODO: call fetch(` must not read as a network call.
 *
 * The scanner is deliberately simple and language-agnostic: it knows `//`, `/* *\/`, and the three JS
 * string quotes (template literals included, since an interpolated string is still a string here). It
 * does NOT know regex literals, so a regex containing `//` can swallow the rest of its line. That failure
 * direction is the safe one — it can only lose a finding, never invent one.
 */
export function stripProse(source) {
  const src = typeof source === 'string' ? source : '';
  let cleaned = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      cleaned += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // A normal string cannot span a newline; a template literal can.
        if (src[i] === '\n' && quote !== '`') break;
        i++;
      }
      cleaned += '""';
      continue;
    }
    cleaned += c;
    i++;
  }
  return cleaned;
}

const UI_EXTENSIONS = ['jsx', 'tsx', 'vue', 'svelte', 'html', 'htm'];
const JS_EXTENSIONS = ['js', 'ts', 'mjs', 'cjs'];
const jsxTag = /<\/?[A-Za-z][A-Za-z0-9.]*(\s[^<>]*)?\/?>/;

/**
 * Is this a UI app at all? Decided by the FILES, so a backend-only project is never lectured about its
 * empty states.
 *
 * `.jsx/.tsx/.vue/.svelte/.html` are UI by extension. A plain `.js`/`.ts` only counts when it actually
 * contains JSX markup or a `React.createElement` call — every Express route in a generated backend is a
 * `.js` file, and treating those as screens would produce findings about a UI that does not exist.
 */
export function isUiApp(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string');
  return list.some((f) => {
    if (typeof f.content !== 'string') return false;
    const ext = (f.path.split('.').pop() || '').toLowerCase();
    if (UI_EXTENSIONS.includes(ext)) return true;
    if (JS_EXTENSIONS.includes(ext)) return jsxTag.test(f.content) || /\bReact\.createElement\b/.test(f.content);
    return false;
  });
}

/** A check's `applies` returns the file refs it found, or null for nothing. */
const hit = (path, detail) => ({ path, detail });

const PENDING_STATE = /\b(setLoading|isLoading|loading|setPending|isPending|pending|setBusy|isBusy|busy|setSaving|isSaving|saving|setSubmitting|isSubmitting|submitting|setInFlight|inFlight|disabled|setDisabled|spinner)\b/;
const FAILURE_SURFACE = /\b(setError|setErr|showError|setFailed|setFailure|onError|setMessage|setStatus|alert|toast|notify|setNotice)\b/;
const ERROR_BRANCH = /\btry\b|\bcatch\s*\(|\.catch\s*\(/;
const CLIENT_CALL = /\b(fetch\s*\(|axios\b|XMLHttpRequest\b)/;
const ASYNC = /\basync\b/;
const HANDLER = /\b(onSubmit|onClick|onChange|onPress|handleSubmit|handleClick|handleSave|handleUpload|handleDelete|handleRemove)\b/;
const DESTRUCTIVE = /\.\s*(delete|deleteMany|remove|destroy)\s*\(|\b(deleteAll|removeAll|clearAll|destroyAll|purgeAll|wipeAll)\b/;
const CONFIRMATION = /\b(confirm|Confirm|ConfirmDialog|useConfirm|confirmDelete|showConfirm|setConfirm|isConfirming|confirmOpen)\b/;
const CLEAR_TO_NON_INPUT = /^(Error|Err|Message|Status|Loading|Pending|Progress|Result|Saving|Busy|Success|Failed|Items|List|Data|Results|Files|Search|Query|Open|Show|Visible)/;
const LIST_RENDER = /\.map\s*\(/;
const EMPTY_STATE = /\.length\s*(===?|!==?|<|>)|!\s*[A-Za-z_$][\w$]*\.length|\b(isEmpty|emptyState|EmptyState|noResults|NoResults|emptyList|EmptyList)\b/;
const LONG_OPERATION = /[A-Za-z0-9_]*(upload|compile|sync|generate|deploy|convert|download|import|export)[A-Za-z0-9_]*\s*\(/i;
const PROGRESS_SURFACE = /\b(progress|percent|percentage|pct|elapsed|elapsedMs|eta|loaded|total|bytesLoaded|totalBytes|bytesTotal|onUploadProgress|onDownloadProgress|progressBar|setProgress|uploaded|remaining)\b/i;

/**
 * The checks. Each gets the whole file list and returns `{ path, detail }` records — or `null` for
 * nothing found. Every match runs against `stripProse(content)`, never the raw source.
 *
 * Severity is coarse and deliberate: `high` means "this app will feel broken in a way users report",
 * `note` is worth saying out loud and is not necessarily a defect.
 */
export const UI_FEEDBACK_CHECKS = [
  {
    id: 'silent-fetch',
    severity: 'high',
    title: 'A network call that cannot report a failure',
    why: 'When the request fails there is nothing in the code that can tell the user — no catch, no error state, no failure message — so the screen simply does not change.',
    fix: 'Wrap the call (or attach `.catch`) and put the failure somewhere visible: an error state, a toast, or an inline message with a next step.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        if (!CLIENT_CALL.test(code)) continue;
        if (ERROR_BRANCH.test(code) || FAILURE_SURFACE.test(code)) continue;
        hits.push(hit(f.path, 'a network call with no error branch and nothing that can show a failure'));
      }
      return hits.length ? hits : null;
    },
  },
  {
    id: 'no-pending-state',
    severity: 'high',
    title: 'An async action that never shows it is busy',
    why: 'An async submit or click that sets no pending, disabled or loading state leaves the control looking ready throughout, which is what produces the double submit and the "did that work?" reload.',
    fix: 'Set a pending flag when the action starts, disable and relabel the control while it runs, and clear it in a `finally`.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        if (!ASYNC.test(code) || !HANDLER.test(code)) continue;
        if (PENDING_STATE.test(code)) continue;
        hits.push(hit(f.path, 'an async handler with no pending, disabled or loading state anywhere in the file'));
      }
      return hits.length ? hits : null;
    },
  },
  {
    id: 'unconfirmed-destructive',
    severity: 'high',
    title: 'A destructive action with no confirmation',
    why: 'A delete, remove or destroy path that runs straight from the click has no step between the user and the loss — and this is the one action a mistake cannot undo.',
    fix: 'Confirm once, before the call, naming the item and the consequence; make the confirm the only thing between the click and the deletion.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        if (!DESTRUCTIVE.test(code)) continue;
        if (CONFIRMATION.test(code)) continue;
        hits.push(hit(f.path, 'a destructive call with no confirmation step in the file'));
      }
      return hits.length ? hits : null;
    },
  },
  {
    id: 'input-lost',
    severity: 'note',
    title: 'Typed input is cleared before the action has an outcome',
    why: 'A field or form reset immediately before an await or a request throws away what the user typed at exactly the moment the result is still unknown — and a failure then costs them the whole input.',
    fix: 'Clear the input only after the outcome is known to be successful, and keep it on screen when the action fails.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        const clear = /\bset([A-Z][A-Za-z0-9_]*)\s*\(\s*""\s*\)|\bset([A-Z][A-Za-z0-9_]*)\s*\(\s*\{\s*\}\s*\)|\b[A-Za-z0-9_.]*reset(Form|Fields|Inputs)?\s*\(\s*\)/g;
        let m;
        let found = null;
        while ((m = clear.exec(code))) {
          const name = m[1] || m[2] || '';
          if (name && CLEAR_TO_NON_INPUT.test(name)) continue;
          // The clear must be immediately followed, within the same statement, by the action it precedes.
          // The terminating `;` of the clear itself is skipped before splitting on the next one.
          const rest = code.slice(m.index + m[0].length).replace(/^\s*;?\s*/, '');
          const stmt = rest.split(';')[0].slice(0, 200);
          if (/\b(await|fetch\s*\(|axios\.|\.post\s*\(|\.put\s*\(|\.patch\s*\(|api\.)/.test(stmt)) { found = m[0].trim(); break; }
        }
        if (found) hits.push(hit(f.path, `input cleared by \`${found}\` immediately before the action, not after its outcome`));
      }
      return hits.length ? hits : null;
    },
  },
  {
    id: 'no-empty-state',
    severity: 'note',
    title: 'A data list with no empty state',
    why: 'A list rendered straight from fetched or state data shows an empty panel before the data arrives and after it comes back empty — the two cases the user most needs told apart.',
    fix: 'Branch on the collection being empty and render a real empty state that says what to do next.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        if (!LIST_RENDER.test(code)) continue;
        if (EMPTY_STATE.test(code)) continue;
        hits.push(hit(f.path, 'a `.map(` render path with no empty or length branch in the file'));
      }
      return hits.length ? hits : null;
    },
  },
  {
    id: 'no-progress-surface',
    severity: 'note',
    title: 'A long operation with nothing that shows progress',
    why: 'Upload, compile, sync, generate and deploy can all run for long enough that a user cannot tell a working job from a frozen one; with no count, percentage or elapsed time there is nothing on screen that changes.',
    fix: 'Surface progress: a real percentage where the transport reports one, a count where it is knowable, or an elapsed-time line where it is not.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        const code = stripProse(f.content);
        if (!LONG_OPERATION.test(code)) continue;
        if (PROGRESS_SURFACE.test(code)) continue;
        hits.push(hit(f.path, 'a long-running operation with no count, percentage or elapsed-time reference'));
      }
      return hits.length ? hits : null;
    },
  },
];

/**
 * Run every check over a generated file list, and return the findings.
 *
 * A non-UI app returns no findings because there is nothing to check — the SUMMARY is what must say so,
 * and `uiFeedbackSummary` refuses to call that clean.
 */
export function uiFeedbackFindings(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string');
  if (!isUiApp(list)) return [];
  const findings = [];
  for (const check of UI_FEEDBACK_CHECKS) {
    let result;
    try {
      result = check.applies(list);
    } catch {
      // A check that threw must never take the build down, and must never read as "clean" either:
      // an unrun check is reported as a check that did not run.
      result = [hit('(check failed to run)', 'the check threw, so it did not run')];
    }
    if (!result) continue;
    for (const ref of (Array.isArray(result) ? result : [result])) {
      findings.push({
        id: check.id,
        severity: check.severity,
        title: check.title,
        why: check.why,
        fix: check.fix,
        // `path` is the evidence, and it is a PATH — never a value, never a snippet of the file.
        path: ref.path,
        detail: ref.detail,
      });
    }
  }
  return findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

/**
 * The sentence an operator is owed, as a checklist rather than a claim.
 *
 * The two sentences that matter most are the ones about NOT having examined anything: a non-UI app and an
 * empty file list must never come back as a clean bill (H17 — a check that never ran reads as a check
 * that passed).
 */
export function uiFeedbackSummary(findings, { filesExamined = 0, uiApp = false } = {}) {
  const list = findings || [];
  if (!uiApp) {
    return 'Not a UI app, so the UI feedback rules were NOT examined — this is not a pass and says nothing about how any screen behaves.';
  }
  if (filesExamined === 0) {
    return 'Nothing was examined, so nothing is claimed about this app\'s UI feedback.';
  }
  const high = list.filter((f) => f.severity === 'high');
  const notes = list.filter((f) => f.severity === 'note');
  if (high.length > 0) {
    return `${high.length} UI feedback finding(s) worth fixing before this app feels finished: ${high.map((f) => f.title).join('; ')}.` +
      (notes.length ? ` Plus ${notes.length} note(s).` : '');
  }
  if (notes.length > 0) {
    return `No high UI feedback findings across ${filesExamined} file(s); ${notes.length} note(s) worth reading.`;
  }
  return `No UI feedback findings across ${filesExamined} file(s), from the patterns this checks — which is not the same as "usable".`;
}

/**
 * The block handed to the planner and the coder, so the same rules that are checked are also ASKED FOR.
 * A check without the corresponding instruction is a trap: it fails work the model was never told about.
 *
 * One line per rule, and a closing line that says the app is checked against exactly these — nothing more
 * is required, and nothing less is accepted.
 */
export const UI_FEEDBACK_PROMPT_BLOCK = `
UI FEEDBACK — what every screen this app generates must show the user, while it is working:
${UI_FEEDBACK_RULES.map((r, i) => `  ${i + 1}. ${r.rule}`).join('\n')}
These ten rules are the whole checklist: the app is checked against exactly these, and against no other UI requirement.`;
