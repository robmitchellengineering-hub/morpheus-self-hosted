// What a generated app does about security, and what it does not.
//
// WHY THIS EXISTS. The market evidence for "it ships" is that security is the industry's worst number and
// nobody's feature: **~45% of AI-generated code samples fail security tests**, and **~380,000 AI-built
// apps are publicly accessible, ~5,000 holding sensitive data**. Morpheus had the principle — the
// reviewer's prompt already lists `eval`, hardcoded secrets, SQL injection, `innerHTML` and command
// injection — but a PROMPT IS NOT A CHECK. Nothing examined the generated artifact, and the operator was
// told nothing about what they had received.
//
// WHAT THIS IS NOT. It is not a security audit and it must not pretend to be one. It does not taint-track,
// it does not resolve imports, and it cannot tell whether an authorisation check is CORRECT — only whether
// one is even present. Every finding is a pattern with a named danger, so a reader can judge it.
//
// The rule that matters most is the one about DEFAULTS. An app that ships `.env`, or that reaches its data
// with no auth middleware in front of it, is dangerous because of what it does when nobody is looking —
// and those are exactly the failures that are decidable from the files without running anything.
//
// Import-free, so the guard runs in CI's no-install job and the caller can use it anywhere.

/**
 * Severity, worst first, so a report reads in the order a person should work.
 *
 * Deliberately its own ranking rather than a lifecycle bucket: the first version mapped three severities
 * onto two buckets that did not match the list they were compared against, so the sort did nothing.
 */
const SEVERITY_RANK = { critical: 0, high: 1, note: 2 };

/**
 * The checks. Each gets the file list and returns `{ path }` records — or `null` for nothing found. The
 * finding built from it is `{ id, severity, title, why, fix, evidence }`; `evidence` is the list of paths
 * (or, when the finding is about the app as a whole, the thing that is missing) rather than file contents,
 * because a report must never quote the secret it found.
 * Severity is deliberate and coarse: `critical` means "do not ship this", `high` means "this is a real
 * hole unless something else covers it", `note` is worth saying out loud and is not a hole.
 */
export const SECURITY_CHECKS = [
  {
    id: 'env-committed',
    severity: 'critical',
    title: 'A .env file is part of the generated app',
    why: 'A committed .env is the single most common way a secret becomes public — it is the file the app reads its keys from, and it ships with the code.',
    applies: (files) => files.some((f) => /(^|\/)\.env$/.test(f.path)),
    fix: 'Delete the .env from the output and ship `.env.example` instead. The app should generate its own secrets on first run, or read them from the host.',
  },
  {
    id: 'no-gitignore',
    severity: 'high',
    title: 'No .gitignore, so nothing stops secrets or the database being committed',
    why: 'The operator will put this in a git repository. Without a .gitignore, the first `git add -A` commits .env and the database file.',
    applies: (files) => !files.some((f) => /(^|\/)\.gitignore$/.test(f.path)),
    fix: 'Add a .gitignore covering `.env`, the database file, and `node_modules/`.',
  },
  {
    id: 'hardcoded-secret',
    severity: 'critical',
    title: 'A secret is written into the source',
    why: 'A key that is in the code is in the repository, the backups and every copy — and rotating it means editing code rather than the environment.',
    applies: (files) => {
      const hits = [];
      for (const f of files) {
        if (typeof f.content !== 'string') continue;
        if (/\.(md|json|example|lock)$/i.test(f.path) || /(^|\/)\.env\.example$/.test(f.path)) continue;
        // A long, high-entropy-looking literal assigned to a secret-ish name. Deliberately narrow: a
        // false "you have a hardcoded secret" on every placeholder teaches an operator to ignore this.
        const m = f.content.match(/(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*['"`]([A-Za-z0-9_\-/+]{20,})['"`]/i);
        if (m && !/^(process\.env|your|changeme|example|placeholder|xxx|test)/i.test(m[1])) hits.push({ path: f.path, sample: `${m[1].slice(0, 4)}…` });
      }
      return hits.length ? hits : null;
    },
    fix: 'Read it from the environment (`process.env.…`) and ship a placeholder in `.env.example`.',
  },
  {
    id: 'no-auth-on-data-routes',
    severity: 'high',
    title: 'There are data routes and no authentication anywhere',
    why: 'A route that reads or writes stored data with nothing in front of it is open to anyone who finds the URL — this is the shape of the ~380,000 exposed apps.',
    applies: (files) => {
      const app = files.filter((f) => typeof f.content === 'string');
      const hasDataRoutes = app.some((f) => /router\.(get|post|put|patch|delete)\s*\(|app\.(get|post|put|patch|delete)\s*\(/.test(f.content) && /(tasks|items|users|orders|notes|posts|records)/i.test(f.content));
      if (!hasDataRoutes) return null;
      const hasAuth = app.some((f) => /jsonwebtoken|express-session|passport|requireAuth|authenticate|verifyToken|isAuthenticated/i.test(f.content));
      return hasAuth ? null : [{ path: '(whole app)' }];
    },
    fix: 'Add an auth check in front of the data routes, or say in the README that the app is deliberately open and must not be exposed publicly.',
  },
  {
    id: 'permissive-cors',
    severity: 'high',
    title: 'CORS accepts every origin',
    why: 'A wildcard origin with credentials lets any site a signed-in user visits make authenticated requests on their behalf.',
    applies: (files) => {
      const hits = files.filter((f) => typeof f.content === 'string'
        && /origin\s*:\s*(true|['"`]\*['"`])/.test(f.content)
        && /credentials\s*:\s*true/.test(f.content));
      return hits.length ? hits.map((f) => ({ path: f.path })) : null;
    },
    fix: 'List the origins the app is actually served from, or drop `credentials` when the origin is a wildcard.',
  },
  {
    id: 'no-security-headers-or-limits',
    severity: 'note',
    title: 'No security headers and no request-size limit',
    why: 'Not a hole on its own, but these are the two things every generated service forgets, and they are one line each.',
    applies: (files) => {
      const app = files.filter((f) => typeof f.content === 'string');
      const hasHelmet = app.some((f) => /\bhelmet\b/.test(f.content));
      const hasLimit = app.some((f) => /express\.json\(\s*\{[^}]*limit|bodyParser\.json\(\s*\{[^}]*limit/.test(f.content));
      if (hasHelmet && hasLimit) return null;
      const missing = [!hasHelmet && 'security headers (helmet)', !hasLimit && 'a body-size limit'].filter(Boolean);
      return missing.map((what) => ({ path: what }));
    },
    fix: 'Add `helmet()` and give `express.json()` an explicit `limit`.',
  },
  {
    id: 'accept-data-loss',
    severity: 'note',
    title: 'A schema push is run with --accept-data-loss',
    why: 'That flag lets a migration drop columns silently. Acceptable on a throwaway database, destructive on one holding real rows.',
    applies: (files) => {
      const hits = files.filter((f) => typeof f.content === 'string' && /--accept-data-loss/.test(f.content));
      return hits.length ? hits.map((f) => ({ path: f.path })) : null;
    },
    fix: 'Keep it in the first-run bootstrap if the database is disposable, and say so; never in a documented upgrade path.',
  },
];

/**
 * Run every check over a generated file list.
 *
 * Returns findings in lifecycle order — secrets first, because that is the one that leaks while everything
 * else is merely wrong — plus a one-line summary an operator can read without opening anything.
 */
export function securityFindings(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string');
  const findings = [];
  for (const check of SECURITY_CHECKS) {
    let result;
    try {
      result = check.applies(list);
    } catch {
      // A check that threw must never take the build down, and must never read as "clean" either:
      // an unrun check is reported as a check that did not run.
      result = [{ path: '(check failed to run)' }];
    }
    if (!result) continue;
    const refs = Array.isArray(result) ? result : [result];
    findings.push({
      id: check.id,
      severity: check.severity,
      title: check.title,
      why: check.why,
      fix: check.fix,
      // `path` doubles as a note when the finding is about the app as a whole or about something missing.
      evidence: refs.map((r) => r.path).filter(Boolean),
    });
  }
  return findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

/** Just the findings an operator must not ship without addressing. */
export function blockingFindings(findings) {
  return (findings || []).filter((f) => f.severity === 'critical');
}

/**
 * The sentence an operator is owed, as a checklist rather than a claim.
 *
 * A security report that says only "no issues found" is the thing this repo keeps having to correct — a
 * check that examined nothing reads as a pass. So the summary always names what WAS examined, and the
 * server is where the prompt-defined checks already live.
 */
export function securitySummary(findings, { filesExamined = 0 } = {}) {
  const list = findings || [];
  const critical = list.filter((f) => f.severity === 'critical');
  const high = list.filter((f) => f.severity === 'high');
  const notes = list.filter((f) => f.severity === 'note');
  if (filesExamined === 0) {
    return 'Nothing was examined, so nothing is claimed about this app\'s security.';
  }
  if (critical.length > 0) {
    return `DO NOT SHIP AS IS — ${critical.length} critical finding(s): ${critical.map((f) => f.title).join('; ')}. ` +
      `${high.length} other finding(s).`;
  }
  if (high.length > 0) {
    return `${high.length} security finding(s) worth fixing: ${high.map((f) => f.title).join('; ')}.` +
      (notes.length ? ` Plus ${notes.length} note(s).` : '');
  }
  if (notes.length > 0) {
    return `No critical or high findings across ${filesExamined} file(s); ${notes.length} note(s) worth reading.`;
  }
  return `No findings across ${filesExamined} file(s), from the patterns this checks — which is not the same as "audited".`;
}

/**
 * The block handed to the reviewer and the coder, so the same rules that are checked are also ASKED FOR.
 * A check without the corresponding instruction is a trap: it fails work the model was never told about.
 */
export const SECURITY_PROMPT_BLOCK = `
SECURITY DEFAULTS — a generated app must not create these situations, and the build is checked for them:
${SECURITY_CHECKS.map((c) => `  - [${c.severity}] ${c.title}\n      ${c.why}\n      Do this instead: ${c.fix}`).join('\n')}
`;
