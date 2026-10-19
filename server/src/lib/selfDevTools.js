// Self-dev diagnostic tool registry — lets self-dev's own AI turn
// (chatWithMorpheus.js, isSelfDev) autonomously investigate a live
// production issue (pull logs, run a read-only query, run a real command
// in an isolated runner, look at a screenshot) before committing to a plan,
// instead of only ever reasoning from static context. See
// chatWithMorpheus.js's investigation loop for how these get called.
//
// Rob, 2026-09-15: this is not a new privilege boundary — self-dev turns
// already require user.role === 'admin' and run as that real admin's own
// user.id throughout (the same person who can already read/write the full
// DB and push to production source manually via the Admin Panel). The new
// thing is AUTONOMY (the AI deciding when to query, no human click), not
// SCOPE — which is why every tool here is deliberately MORE conservative
// than what the human Admin Panel console allows, not equally permissive:
// removing the human click removes the review step the console's own
// confirm-gated writes and "eyeball it before you paste it into chat" habit
// both rely on.
//
// Extensible by design: add a new entry to SELF_DEV_TOOLS and it's
// immediately available — selfDevToolsPromptBlock() auto-generates the
// AI-facing description text from the registry itself, so the prompt can
// never drift from what's actually implemented (the exact "prompt promises
// X, code does Y" bug class found and fixed repeatedly in the compile
// pipeline this same session).
import { getServiceLogs, isNorthflankConfigured, } from './northflank.js';
import { getGithubToken, ghHeaders, ghJson, getFileContent, createOrUpdateFile } from './github.js';
import { uploadFile } from '../storage.js';
import { prisma } from '../db.js';
import puppeteer from 'puppeteer-core';

const GH_API = 'https://api.github.com';

// ── read_production_logs ────────────────────────────────────────────────
// Caps deliberately tighter than the human Admin Panel Ops Console
// (northflank.js's own ceiling is 1000 lines / any time window) — this path
// has no human review step.
const LOG_MAX_MINUTES_BACK = 1440; // 24h
const LOG_MAX_LIMIT = 200;

// ── query_database ──────────────────────────────────────────────────────
// Same classifier regex as admin.routes.js's /ops/db-query (that file's
// lines ~355-364) — duplicated on purpose rather than imported across
// routes/ <-> lib/, kept in lockstep by this comment cross-reference. This
// tool is READ-ONLY ONLY: unlike the human console (which allows
// INSERT/UPDATE/DELETE behind a confirm flag), there is no write code path
// here at all — not disabled by a flag, the branch simply doesn't exist.
const READ_SQL = /^\s*(SELECT|WITH)\b/i;
const SQL_ROW_CAP = 200; // enforced pre-execution via subquery wrap, not a post-fetch slice

function isSingleStatement(sql) {
  return !sql.trim().replace(/;\s*$/, '').includes(';');
}

// 2026-09-17: found live — a widget-build turn hung indefinitely with zero
// server log output, and every AI provider call is already wrapped in
// ai.js's own fetchWithTimeout, so it wasn't stuck there. This raw query had
// no timeout anywhere in the stack (no statement_timeout on the Prisma
// client in db.js, nothing here) — a slow scan or a lock wait on a query the
// investigating AI decided to run could block the whole turn (and, via
// buildDeckWidget.js, the whole build) forever. Same reasoning as
// AI_FETCH_TIMEOUT_MS in ai.js: a hard wall-clock cap turns an indefinite
// hang into a clear, catchable error. This only bounds how long the CALLER
// waits — Promise.race can't cancel a raw Postgres query already in flight,
// so a genuinely long-running query keeps running server-side after this
// gives up; that's an acceptable tradeoff for unblocking the chat turn.
const QUERY_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s — it may be scanning a large table or waiting on a lock. Try a more targeted query (add a WHERE clause, or query fewer rows).`)), ms);
    }),
  ]);
}

// Prisma raw-query results can carry BigInt/Date/Decimal values that
// JSON.stringify chokes on or mangles — same normalization as
// admin.routes.js's sanitizeForJson.
function sanitizeForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (value && typeof value === 'object') {
    if (typeof value.toFixed === 'function' || value.constructor?.name === 'Decimal') return value.toString();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeForJson(v)]));
  }
  return value;
}

// ── run_command ──────────────────────────────────────────────────────────
// Running an arbitrary shell command in-process on Morpheus's own
// Northflank container (the same container serving every user) is not
// acceptable — a bad command takes down the whole platform, not just
// self-dev. Runs on an isolated, ephemeral GitHub Actions runner instead —
// the exact same trust boundary the compile pipeline already relies on.
const DIAGNOSTIC_WORKFLOW_PATH = '.github/workflows/morpheus-diagnostic.yml';
const DIAGNOSTIC_WORKFLOW_YAML = [
  'name: Morpheus Diagnostic',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      command:',
  "        description: 'Shell command to run'",
  '        required: true',
  'jobs:',
  '  run:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Run command',
  '        env:',
  '          MORPHEUS_CMD: ${{ inputs.command }}',
  // Passed via env + bash -c, not interpolated directly into `run:` —
  // GitHub's own recommended pattern, avoids template-time interpolation
  // surprises with special characters in the command string.
  '        run: bash -c "$MORPHEUS_CMD"',
  '',
].join('\n');
const COMMAND_POLL_BUDGET_MS = 90_000;
const COMMAND_LOG_TAIL_CHARS = 4000;

async function findWorkflowId(token, repoFullName, path) {
  const res = await fetch(`${GH_API}/repos/${repoFullName}/actions/workflows`, { headers: ghHeaders(token) });
  const data = await ghJson(res);
  return (data.workflows || []).find((w) => w.path === path)?.id || null;
}

async function ensureDiagnosticWorkflow(token, repoFullName, branch) {
  const [owner, repoName] = repoFullName.split('/');
  let workflowId = await findWorkflowId(token, repoFullName, DIAGNOSTIC_WORKFLOW_PATH);
  if (workflowId) return workflowId;

  const existingFile = await getFileContent(owner, repoName, DIAGNOSTIC_WORKFLOW_PATH, branch, token).catch(() => null);
  if (!existingFile) {
    await createOrUpdateFile(owner, repoName, DIAGNOSTIC_WORKFLOW_PATH, DIAGNOSTIC_WORKFLOW_YAML, branch, token, 'Add Morpheus diagnostic workflow');
  }
  // GitHub needs a short delay after a push before a new workflow file is
  // registered and gets an ID — same reason compileProject.js polls up to
  // 8x3s for its own workflow's registration.
  for (let attempt = 0; attempt < 5 && !workflowId; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    workflowId = await findWorkflowId(token, repoFullName, DIAGNOSTIC_WORKFLOW_PATH);
  }
  if (!workflowId) throw new Error('Diagnostic workflow did not register on GitHub in time — try again shortly.');
  return workflowId;
}

async function dispatchCommand(token, repoFullName, branch, command) {
  const workflowId = await ensureDiagnosticWorkflow(token, repoFullName, branch);
  const res = await fetch(`${GH_API}/repos/${repoFullName}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ ref: branch, inputs: { command } }),
  });
  if (!res.ok) {
    const data = await ghJson(res).catch(() => ({}));
    throw new Error(`Failed to dispatch command: ${data.message || res.status}`);
  }
}

async function pollCommandRun(token, repoFullName, dispatchedAtMs) {
  const h = ghHeaders(token);
  const deadline = Date.now() + COMMAND_POLL_BUDGET_MS;
  let run = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!run) {
      const res = await fetch(`${GH_API}/repos/${repoFullName}/actions/workflows/morpheus-diagnostic.yml/runs?event=workflow_dispatch&per_page=5`, { headers: h });
      const data = await ghJson(res);
      run = (data.workflow_runs || []).find((r0) => new Date(r0.created_at).getTime() >= dispatchedAtMs) || null;
      if (!run) continue;
    }
    if (run.status !== 'completed') {
      const res = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs/${run.id}`, { headers: h });
      run = await ghJson(res);
    }
    if (run.status === 'completed') break;
  }
  if (!run) {
    return { note: 'Command dispatched but no run appeared yet after 90s — check the Actions tab for the result.' };
  }
  if (run.status !== 'completed') {
    return { note: `Command dispatched but still running after 90s — check the Actions tab for ${repoFullName}.`, runUrl: run.html_url };
  }
  const jobsRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs/${run.id}/jobs`, { headers: h });
  const jobsData = await ghJson(jobsRes);
  const job = jobsData.jobs?.[0];
  let log = '';
  if (job) {
    const logRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/jobs/${job.id}/logs`, { headers: h, redirect: 'follow' });
    if (logRes.ok) log = await logRes.text();
  }
  return {
    exitOk: run.conclusion === 'success',
    log: log.length > COMMAND_LOG_TAIL_CHARS ? log.slice(-COMMAND_LOG_TAIL_CHARS) : log,
    runUrl: run.html_url,
  };
}

// ── screenshot_preview ───────────────────────────────────────────────────
// Self-dev only (this whole feature is self-dev-gated already) — screenshots
// the real, live morpheus.nz production site, not an arbitrary URL from
// outside the trust boundary already established for this feature.
const SCREENSHOT_TARGET_ORIGIN = 'https://morpheus.nz';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

export const SELF_DEV_TOOLS = {
  read_production_logs: {
    description: 'Search recent production runtime (or build) logs. Args: { search?: string, minutesBack?: number (max 1440), limit?: number (max 200), type?: "runtime"|"build" }.',
    async run(user, project, args) {
      if (!isNorthflankConfigured()) return { error: 'Northflank is not configured on this deployment — logs are unavailable.' };
      const minutesBack = Math.min(LOG_MAX_MINUTES_BACK, Math.max(1, Number(args?.minutesBack) || 60));
      const limit = Math.min(LOG_MAX_LIMIT, Math.max(1, Number(args?.limit) || 200));
      const lines = await getServiceLogs({ search: args?.search || undefined, minutesBack, limit, type: args?.type === 'build' ? 'build' : 'runtime' });
      return { lines };
    },
  },

  query_database: {
    description: 'Run a read-only SQL query (SELECT/WITH only) against the production database. Results capped at 200 rows. Args: { sql: string }.',
    async run(user, project, args) {
      const sql = String(args?.sql || '').trim();
      if (!sql) return { error: 'sql is required.' };
      if (!isSingleStatement(sql)) return { error: 'One statement only — remove the extra semicolon(s).' };
      if (!READ_SQL.test(sql)) return { error: 'Only SELECT/WITH is allowed for this tool — no writes, ever.' };
      // Subquery-wraps the caller's SQL so the row cap is enforced BEFORE
      // the DB materializes a huge result set — unlike admin.routes.js's
      // human console, which slices to 500 AFTER full retrieval.
      const wrapped = `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS _self_dev_tool_sub LIMIT ${SQL_ROW_CAP}`;
      let rows;
      try {
        rows = sanitizeForJson(await withTimeout(prisma.$queryRawUnsafe(wrapped), QUERY_TIMEOUT_MS, 'Query'));
      } catch (err) {
        await prisma.adminAuditLog.create({
          data: { admin_id: user.id, action: 'self_dev_ai_query_database', details: JSON.stringify({ sql: sql.slice(0, 2000), ok: false, error: err.message }) },
        }).catch(() => {});
        return { error: err.message };
      }
      await prisma.adminAuditLog.create({
        data: { admin_id: user.id, action: 'self_dev_ai_query_database', details: JSON.stringify({ sql: sql.slice(0, 2000), ok: true, rowCount: rows.length }) },
      }).catch(() => {});
      return { rows, rowCount: rows.length, cappedAt: SQL_ROW_CAP };
    },
  },

  run_command: {
    description: 'Run a shell command against this project\'s connected GitHub repo on an isolated GitHub Actions runner (checkout + run the command, nothing else) — e.g. "npm test", "npm run build", a linter. NOT run on the Morpheus server itself. Args: { command: string }. Takes up to ~90s to come back; may report the command is still running if it takes longer.',
    async run(user, project, args) {
      const command = String(args?.command || '').trim();
      if (!command) return { error: 'command is required.' };
      if (!project?.github_repo) return { error: 'No GitHub repo connected for this project yet — compile it or push to GitHub first.' };

      let token;
      try {
        token = await getGithubToken(user.id, { projectId: project.id });
      } catch (err) {
        return { error: err.message || 'GitHub not connected.' };
      }

      const repoRes = await fetch(`${GH_API}/repos/${project.github_repo}`, { headers: ghHeaders(token) });
      const repoData = await ghJson(repoRes);
      if (!repoRes.ok) return { error: `Could not read ${project.github_repo}: ${repoData.message || repoRes.status}` };
      const branch = repoData.default_branch || 'main';

      const dispatchedAtMs = Date.now();
      try {
        await dispatchCommand(token, project.github_repo, branch, command);
      } catch (err) {
        return { error: err.message };
      }
      return pollCommandRun(token, project.github_repo, dispatchedAtMs);
    },
  },

  screenshot_preview: {
    description: 'Take a screenshot of the live Morpheus production site (morpheus.nz) or a specific path on it, to visually check a UI change actually rendered correctly. Args: { path?: string, e.g. "/admin" }. Returns a real screenshot the AI can see in the next response.',
    async run(user, project, args) {
      const path = typeof args?.path === 'string' ? args.path : '';
      const url = SCREENSHOT_TARGET_ORIGIN + (path && !path.startsWith('/') ? '/' + path : path);
      let browser;
      try {
        browser = await puppeteer.launch({
          executablePath: CHROMIUM_PATH,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });
        const buffer = await page.screenshot({ type: 'png' });
        const { file_url } = await uploadFile({ buffer, filename: `self-dev-screenshot-${Date.now()}.png`, contentType: 'image/png' });
        return { screenshotUrl: file_url, url };
      } catch (err) {
        return { error: err.message };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    },
  },
};

// Auto-generated from the registry so the AI-facing description text can
// never drift from what's actually implemented.
export function selfDevToolsPromptBlock() {
  return Object.entries(SELF_DEV_TOOLS).map(([name, t]) => `- ${name}: ${t.description}`).join('\n');
}

// Never throws — a bad tool name, bad args, or a thrown error from any
// tool's run() all become a {tool, args, error} entry instead of
// propagating, so one bad round never takes down the whole chat turn
// (mirrors researchRepo's and verifyExternalApiCall's own per-call catch).
export async function runSelfDevToolCalls(user, project, calls) {
  return Promise.all(calls.map(async (c) => {
    const tool = SELF_DEV_TOOLS[c?.tool];
    if (!tool) return { tool: c?.tool, args: c?.args, error: `Unknown tool "${c?.tool}" — available: ${Object.keys(SELF_DEV_TOOLS).join(', ')}` };
    try {
      const result = await tool.run(user, project, c.args || {});
      return { tool: c.tool, args: c.args, ...result };
    } catch (err) {
      return { tool: c.tool, args: c.args, error: err.message };
    }
  }));
}

// Mirrors externalApiCheck.js's formatApiCheckBlock formatting style.
export function formatSelfDevToolResultsBlock(results, roundNumber) {
  if (!results.length) return '';
  const lines = results.map((r) => r.error
    ? `- ${r.tool}(${JSON.stringify(r.args || {})}) — FAILED: ${r.error}`
    : `- ${r.tool}(${JSON.stringify(r.args || {})}) — result:\n  ${JSON.stringify(r, null, 2).replace(/\n/g, '\n  ')}`);
  return `\n\nDIAGNOSTIC TOOL RESULTS (round ${roundNumber}) — these were actually run just now; real current data, not a recollection:\n${lines.join('\n')}\n`;
}

// Screenshot URLs returned across a turn's tool-call rounds, pulled out so
// the caller can feed them into the next invokeAI call's fileUrls (Morpheus's
// existing vision pipeline — ai.js already turns fileUrls into real image
// content parts, with an automatic fallback when the active model can't see
// images, so no new AI-integration code is needed here).
export function extractScreenshotUrls(results) {
  return results.filter((r) => r.screenshotUrl).map((r) => r.screenshotUrl);
}
