// Operator-facing "is Morpheus itself current" report. See
// server/src/freshness.js for what this checks and — importantly — what it
// deliberately does NOT do (auto-edit code or auto-upgrade dependencies).
import express from 'express';
import { requireAuth, requireAdmin, blockWidget } from '../auth.js';
import { runFreshnessCheck, runFreshnessCheckAndNotify } from '../freshness.js';
import { prisma } from '../db.js';
import { getAllPlatformSettings, getPlatformSetting, setPlatformSetting } from '../lib/platformSettings.js';
import { MODEL_PRICING } from '../lib/costEstimate.js';
import { brokerConfigured } from '../config/hostedDefaults.js';
import { getCachedStatus as getDeepSeekBalanceStatus, isDeepSeekPrimary, hasFallbackConfigured } from '../lib/deepseekBalance.js';
import { getServiceStatus as getNorthflankServiceStatus, getServiceLogs, isNorthflankConfigured, isNorthflankWriteEnabled, restartService as restartNorthflankService } from '../lib/northflank.js';
import { stripeFetch } from '../lib/stripe.js';

const router = express.Router();

router.use(requireAuth, blockWidget, requireAdmin);

// ── Owner/Admin Control Panel (Feature Backlog #8) ──────────────────
// Everything below this line is new (2026-09-01), added alongside the
// freshness report above under the same requireAuth+requireAdmin gate.
// Auth hardening decision: role-gated only for v1, same bar as the existing
// admin surfaces (freshness, self-dev, updates-plan) — no extra step-up
// auth. Access control: reuses User.role === 'admin', no separate 'owner'
// role. Audit logging: every settings/model-catalog write below logs to
// AdminAuditLog — decided to log everything, not just a subset.

const DAY_MS = 24 * 60 * 60 * 1000;

// A. Monitoring — users, usage/cost by model, and plain boolean config
// checks (no secret values ever returned, just whether something's set).
router.get('/overview', async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
    const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

    const [totalUsers, activeUserRows, usageByModel] = await Promise.all([
      prisma.user.count(),
      prisma.usageEvent.findMany({
        where: { created_date: { gte: sevenDaysAgo } },
        select: { created_by_id: true },
        distinct: ['created_by_id'],
      }),
      prisma.usageEvent.groupBy({
        by: ['model_id', 'provider'],
        where: { created_date: { gte: thirtyDaysAgo } },
        _count: { _all: true },
        _sum: { input_tokens: true, output_tokens: true, cost_usd: true },
        orderBy: { _sum: { cost_usd: 'desc' } },
      }),
    ]);

    const usageByModel30d = usageByModel.map((row) => ({
      modelId: row.model_id,
      provider: row.provider,
      calls: row._count._all,
      inputTokens: row._sum.input_tokens || 0,
      outputTokens: row._sum.output_tokens || 0,
      costUsd: row._sum.cost_usd || 0,
    }));
    const totalCost30d = usageByModel30d.reduce((sum, r) => sum + r.costUsd, 0);

    // What the provider actually charged, measured from the balance delta, next
    // to the estimate the rest of this payload reports. The estimate runs about
    // 2x the real bill (measured 2026-09-24), so the two belong side by side
    // rather than one wearing the word "cost".
    let actualProviderSpend30d = { available: false, reason: 'not measured' };
    try {
      const { spendOver, DEEPSEEK } = await import('../lib/providerSpendState.js');
      actualProviderSpend30d = await spendOver(DEEPSEEK, 24 * 30);
    } catch (err) {
      actualProviderSpend30d = { available: false, reason: String(err?.message || err) };
    }

    res.json({
      totalUsers,
      activeUsers7d: activeUserRows.length,
      usageByModel30d,
      totalCost30d,
      // Named so the consumer cannot mistake it for a bill: it is a modelled
      // figure from the static rate table, and costBasis says so in the payload
      // rather than only in a comment.
      costBasis: 'estimated-from-static-rate-table',
      actualProviderSpend30d,
      // Presence-only — never the actual secret values. This is the closest
      // thing to an "error/incident feed" this v1 ships with: no dedicated
      // error-logging pipeline exists yet, so rather than fake one, this
      // surfaces the config gaps that are actually knowable from here.
      configFlags: {
        llmApiKeyConfigured: Boolean(process.env.LLM_API_KEY),
        morpheusCloudConfigured: brokerConfigured(),
        stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
        smtpConfigured: Boolean(process.env.SMTP_HOST),
      },
      // Token System Step 6b — outage-prevention safeguard, not billing UI.
      // deepseekPrimary=false means this deployment isn't using DeepSeek as
      // its house key, so the rest of this block is inert (status.level
      // stays 'unknown', which is expected, not a problem to fix).
      deepseekBalance: {
        deepseekPrimary: isDeepSeekPrimary(),
        fallbackConfigured: hasFallbackConfigured(),
        ...getDeepSeekBalanceStatus(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. Model/routing control — current PlatformSetting overrides + the env
// vars they'd otherwise fall back to (see ai.js's resolveEndpoint), so the
// UI can show "effective value" clearly. Any key can be read/written here
// (see POST below) — default_model / default_<role>_model are the ones
// ai.js actually consumes today; anything else is inert until a future
// feature reads it, same as an unused env var.
router.get('/settings', async (req, res) => {
  try {
    const settings = await getAllPlatformSettings();
    const envDefaults = {
      base: process.env.LLM_MODEL || null,
      planner: process.env.LLM_PLANNER_MODEL || null,
      coder: process.env.LLM_CODER_MODEL || null,
      reviewer: process.env.LLM_REVIEWER_MODEL || null,
      diagnosis: process.env.LLM_DIAGNOSIS_MODEL || null,
    };
    res.json({ settings, envDefaults, knownModels: Object.keys(MODEL_PRICING).filter((m) => m !== 'automatic') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(key)) {
      return res.status(400).json({ error: 'Invalid key — letters, numbers, underscores only' });
    }
    if (value != null && typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string (or empty/null to clear)' });
    }

    const before = await getPlatformSetting(key);
    if (value == null || value === '') {
      await prisma.platformSetting.deleteMany({ where: { key } });
    } else {
      await setPlatformSetting(key, value, req.user.id);
    }

    await prisma.adminAuditLog.create({
      data: {
        admin_id: req.user.id,
        action: 'update_setting',
        details: JSON.stringify({ key, before: before || null, after: value || null }),
      },
    });

    res.json({ ok: true, key, value: value || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Margin visibility — admin-editable pricing/markup per model. Existing
// ModelCatalogEntry table (Token System Step 1) already covers this; this
// is the UI to actually edit it, which didn't exist before. Underlying
// $/M-token cost x markup_multiplier is the same margin math
// lib/modelPricing.js already uses for real per-call cost logging.
router.get('/model-catalog', async (req, res) => {
  try {
    const entries = await prisma.modelCatalogEntry.findMany({ orderBy: { model_id: 'asc' } });
    res.json({ entries, staticFallback: MODEL_PRICING });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/model-catalog', async (req, res) => {
  try {
    const { model_id, provider, input_price_per_m, output_price_per_m, markup_multiplier, active } = req.body || {};
    if (!model_id || typeof model_id !== 'string') return res.status(400).json({ error: 'model_id required' });

    const before = await prisma.modelCatalogEntry.findUnique({ where: { model_id } });
    const entry = await prisma.modelCatalogEntry.upsert({
      where: { model_id },
      update: {
        ...(provider !== undefined ? { provider: provider || null } : {}),
        ...(input_price_per_m !== undefined ? { input_price_per_m: input_price_per_m === null ? null : Number(input_price_per_m) } : {}),
        ...(output_price_per_m !== undefined ? { output_price_per_m: output_price_per_m === null ? null : Number(output_price_per_m) } : {}),
        ...(markup_multiplier !== undefined ? { markup_multiplier: Number(markup_multiplier) } : {}),
        ...(active !== undefined ? { active: Boolean(active) } : {}),
      },
      create: {
        model_id,
        provider: provider || null,
        input_price_per_m: input_price_per_m != null ? Number(input_price_per_m) : null,
        output_price_per_m: output_price_per_m != null ? Number(output_price_per_m) : null,
        markup_multiplier: markup_multiplier != null ? Number(markup_multiplier) : 2.0,
        active: active !== undefined ? Boolean(active) : true,
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        admin_id: req.user.id,
        action: 'update_model_catalog',
        details: JSON.stringify({ model_id, before: before || null, after: entry }),
      },
    });

    res.json({ entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only — never exposed through the generic entity CRUD engine
// (server/src/entities.js) on purpose, see schema.prisma's AdminAuditLog
// comment for why.
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await prisma.adminAuditLog.findMany({
      orderBy: { created_date: 'desc' },
      take: limit,
      include: { admin: { select: { email: true, full_name: true } } },
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cheap read: last computed report, refreshing in the background if stale.
// Kept simple (module-level, resets on restart) since this is advisory
// data, not something anything else depends on being perfectly fresh.
let lastReport = null;
let lastCheckedAt = 0;
const REPORT_TTL_MS = 60 * 60 * 1000; // 1h

router.get('/freshness', async (_req, res) => {
  try {
    if (!lastReport || Date.now() - lastCheckedAt > REPORT_TTL_MS) {
      lastReport = await runFreshnessCheck();
      lastCheckedAt = Date.now();
    }
    res.json(lastReport);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force a fresh run (bypasses the 1h cache above) — e.g. a "Check now"
// button in the admin UI. Also triggers the same notify-on-change email
// logic as the scheduled job, so this doubles as "test my SMTP config".
router.post('/freshness/refresh', async (req, res) => {
  try {
    const wantsEmail = req.body?.notify && process.env.SMTP_HOST;
    const notifyEmail = wantsEmail ? req.user.email : null;
    const { report, summary, changedSinceLastRun } = await runFreshnessCheckAndNotify(notifyEmail);
    lastReport = report;
    lastCheckedAt = Date.now();
    res.json({ ...report, summary, changedSinceLastRun });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── C. Ops Console (2026-09-02) ──────────────────────────────────────
// Built after a live incident (2026-09-02, see MORPHEUS-STATUS docs) where
// diagnosing "chat is broken" required an external engineer manually
// switching between a Northflank logs tab, a Supabase table editor, and a
// GitHub browser-upload workflow to ship the fix — none of which Rob could
// do himself from inside Morpheus. This section gives the same three
// capabilities a real in-app home:
//   - Northflank status/logs: read-only (lib/northflank.js) — see that
//     file's header for why write/deploy-trigger capability isn't exposed.
//   - DB console: direct SQL against this deployment's own database.
//     Decided scope (Rob, 2026-09-02): "read + guarded writes" — SELECT/WITH
//     run immediately, INSERT/UPDATE/DELETE require an explicit confirm flag
//     (the frontend's confirmation dialog sets it) and are capped to one
//     statement each. Schema-level statements (DROP/ALTER/CREATE/TRUNCATE/
//     GRANT/...) are rejected outright — nothing about the actual use case
//     (inspecting/fixing bad rows, e.g. the default_model mixup that started
//     this whole incident) needs them, and a quick console has no business
//     running migrations. Every call is audit-logged whether it succeeds or
//     fails, same bar as every other write in this file.
//   - Billing health: reuses the existing lib/stripe.js fetch wrapper —
//     nothing new to configure, just new visibility into it.
// GitHub push deliberately gets nothing new here: SelfDev's PUSH TO
// PRODUCTION (pushSelfDevToGithub.js) already pushes for real, per-user
// OAuth token, no static PAT needed — that path was already working.

function isNorthflankLogSearchSafe(value) {
  // Not a security boundary (this is a read-only GET against Northflank,
  // server-side textIncludes filter) — just a sane length cap so a runaway
  // query string can't be built.
  return typeof value === 'string' && value.length <= 200;
}

router.get('/ops/northflank/status', async (req, res) => {
  if (!isNorthflankConfigured()) return res.json({ configured: false, writeEnabled: false });
  try {
    res.json({ configured: true, writeEnabled: isNorthflankWriteEnabled(), service: await getNorthflankServiceStatus() });
  } catch (err) {
    res.status(502).json({ configured: true, writeEnabled: isNorthflankWriteEnabled(), error: err.message });
  }
});

// Rolling restart of the production backend. Write-gated (NORTHFLANK_WRITE_ENABLED)
// and requires an explicit confirm flag from the caller's dialog. Audit-logged
// whether it succeeds or fails — same bar as the DB-console writes above.
router.post('/ops/northflank/restart', async (req, res) => {
  if (!isNorthflankWriteEnabled()) {
    return res.status(400).json({ error: 'Northflank restart is not enabled — set NORTHFLANK_WRITE_ENABLED=true and give the token Services > Update scope.' });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Restart requires confirmation.' });
  }
  let error = null;
  try {
    await restartNorthflankService();
  } catch (err) {
    error = err.message;
  }
  await prisma.adminAuditLog.create({
    data: {
      admin_id: req.user.id,
      action: 'ops_northflank_restart',
      details: JSON.stringify({ ok: !error, error }),
    },
  }).catch(() => {});
  if (error) return res.status(502).json({ error });
  res.json({ ok: true });
});

router.get('/ops/northflank/logs', async (req, res) => {
  if (!isNorthflankConfigured()) return res.json({ configured: false, lines: [] });
  try {
    const { search, minutes, limit, type } = req.query;
    if (search && !isNorthflankLogSearchSafe(search)) {
      return res.status(400).json({ error: 'search too long' });
    }
    const lines = await getServiceLogs({
      search: search || undefined,
      minutesBack: minutes ? Number(minutes) : 60,
      limit: limit ? Number(limit) : 200,
      type: type === 'build' ? 'build' : 'runtime',
    });
    res.json({ configured: true, lines });
  } catch (err) {
    res.status(502).json({ configured: true, error: err.message });
  }
});

// Prisma raw-query results can carry BigInt (e.g. count(*)) and Date values
// that JSON.stringify/res.json() choke on or mangle — normalize both before
// they ever reach a response or an audit-log JSON.stringify call.
function sanitizeForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (value && typeof value === 'object') {
    // Prisma Decimal (and similar numeric wrappers) — a raw query returns
    // these as class instances that JSON.stringify turns into "{}". They
    // carry a real toString(); use it instead of walking their internals.
    if (typeof value.toFixed === 'function' || value.constructor?.name === 'Decimal') return value.toString();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeForJson(v)]));
  }
  return value;
}

const READ_SQL = /^\s*(SELECT|WITH)\b/i;
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE)\b/i;

function isSingleStatement(sql) {
  // Strip one trailing semicolon, then reject if any semicolon remains —
  // that's statement-stacking (e.g. "UPDATE ...; DROP TABLE ..."), which a
  // regex-based read/write classifier on the *first* keyword alone wouldn't
  // catch.
  return !sql.trim().replace(/;\s*$/, '').includes(';');
}

router.post('/ops/db-query', async (req, res) => {
  const sql = String(req.body?.sql || '').trim();
  const confirm = req.body?.confirm === true;
  if (!sql) return res.status(400).json({ error: 'sql required' });
  if (!isSingleStatement(sql)) {
    return res.status(400).json({ error: 'One statement at a time — remove the extra semicolon(s).' });
  }

  const isRead = READ_SQL.test(sql);
  const isWrite = WRITE_SQL.test(sql);
  if (!isRead && !isWrite) {
    return res.status(400).json({
      error: 'Only SELECT/WITH (read) and INSERT/UPDATE/DELETE (write, with confirm) are allowed here. Schema changes (DROP/ALTER/CREATE/TRUNCATE/GRANT/...) need a real migration, not this console.',
    });
  }
  if (isWrite && !confirm) {
    return res.status(400).json({ error: 'Write statement requires confirmation.' });
  }

  let result = null;
  let error = null;
  // A statement classified as a read can still turn out to modify data (below),
  // and the audit trail should record what actually happened, not what the
  // first keyword suggested.
  let wasWrite = isWrite;
  try {
    if (isRead) {
      // A data-modifying CTE — `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`
      // — starts with WITH, so it matched READ_SQL above and ran with NO confirm
      // gate at all. Confirmed against Postgres: it deleted rows unconfirmed and
      // was audited as a read.
      //
      // Spotting that textually is a losing game, so let the database enforce it:
      // reads run inside a READ ONLY transaction, where Postgres refuses any data
      // modification itself (SQLSTATE 25006).
      const rows = sanitizeForJson(await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return tx.$queryRawUnsafe(sql);
      }));
      const rowCount = rows?.length || 0;
      result = { rows: (rows || []).slice(0, 500), rowCount, truncated: rowCount > 500 };
    } else {
      const rowsAffected = await prisma.$executeRawUnsafe(sql);
      result = { rowsAffected };
    }
  } catch (err) {
    const pgCode = err?.meta?.code || err?.code;
    if (pgCode === '25006' || /read-only transaction/i.test(err?.message || '')) {
      // Postgres refused a modification inside the read-only transaction: this
      // was a write wearing a read's clothing.
      wasWrite = true;
      error = 'This statement modifies data, so it counts as a write — send it again with confirm: true. (Reads run inside a read-only transaction, which is what caught it.)';
    } else {
      error = err.message;
    }
  }

  // Logged regardless of outcome — a failed write attempt is still worth a
  // trail, same reasoning as every other admin action in this file.
  await prisma.adminAuditLog.create({
    data: {
      admin_id: req.user.id,
      action: wasWrite ? 'ops_db_write' : 'ops_db_read',
      details: JSON.stringify({
        sql: sql.slice(0, 2000),
        ok: !error,
        error,
        ...(error ? {} : isWrite ? result : { rowCount: result.rowCount }),
      }),
    },
  });

  if (error) return res.status(400).json({ error });
  res.json(result);
});

router.get('/ops/stripe-health', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ configured: false });
  try {
    const [balance, events] = await Promise.all([
      stripeFetch('/balance'),
      stripeFetch('/events?limit=25'),
    ]);
    const recentEvents = (events?.data || []).map((e) => ({
      id: e.id,
      type: e.type,
      created: e.created,
      failed: /failed|dispute|declined/i.test(e.type),
    }));
    res.json({
      configured: true,
      balance: { available: balance?.available || [], pending: balance?.pending || [] },
      recentEvents,
      failedCount: recentEvents.filter((e) => e.failed).length,
    });
  } catch (err) {
    res.status(502).json({ configured: true, error: err.message });
  }
});

// D. Free usage grants — billing exemption for a specific account without
// handing out the rest of what role === 'admin' unlocks (Admin Panel, ops
// console, etc.). See schema.prisma's `billing_exempt` column and
// server/src/ai.js's isExempt check. Audit-logged like every other write
// on this router.
router.get('/users/billing-exempt', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { billing_exempt: true },
      select: { id: true, email: true, full_name: true, role: true, created_date: true },
      orderBy: { created_date: 'desc' },
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/billing-exempt', async (req, res) => {
  try {
    const { email, exempt } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    if (typeof exempt !== 'boolean') return res.status(400).json({ error: 'exempt must be true or false' });

    const target = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!target) return res.status(404).json({ error: `No account found for ${email}` });

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { billing_exempt: exempt },
      select: { id: true, email: true, full_name: true, role: true, billing_exempt: true },
    });

    await prisma.adminAuditLog.create({
      data: {
        admin_id: req.user.id,
        action: 'set_billing_exempt',
        details: JSON.stringify({ email: updated.email, exempt }),
      },
    });

    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
