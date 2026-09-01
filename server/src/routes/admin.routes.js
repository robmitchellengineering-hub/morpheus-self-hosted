// Operator-facing "is Morpheus itself current" report. See
// server/src/freshness.js for what this checks and — importantly — what it
// deliberately does NOT do (auto-edit code or auto-upgrade dependencies).
import express from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { runFreshnessCheck, runFreshnessCheckAndNotify } from '../freshness.js';
import { prisma } from '../db.js';
import { getAllPlatformSettings, getPlatformSetting, setPlatformSetting } from '../lib/platformSettings.js';
import { MODEL_PRICING } from '../lib/costEstimate.js';
import { brokerConfigured } from '../config/hostedDefaults.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

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

    res.json({
      totalUsers,
      activeUsers7d: activeUserRows.length,
      usageByModel30d,
      totalCost30d,
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

export default router;
