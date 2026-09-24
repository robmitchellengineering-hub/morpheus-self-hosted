// Generic dispatcher for the 34 ported Base44 functions. Mirrors the
// frontend's `base44.functions.invoke(name, body)` call — see
// src/api/base44Client.js. Each handler lives in its own file under
// server/src/functions/<name>.js and self-registers just by existing there
// (no shared registry file to edit, so ports never collide with each other).
//
// Handler contract — see PORTING_GUIDE.md:
//   export default async function handler(ctx) { ... return jsonBody; }
//   ctx = { user, body, req, res }
// A handler may also write directly to `res` (e.g. to stream a ZIP) and
// return undefined — the dispatcher only auto-sends a JSON response when
// the handler returns a plain value and hasn't already sent one.
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { requireAuth, requireAdmin } from '../auth.js';
import { widgetMayCall } from '../lib/widgetToken.js';
import { deviceMayCall } from '../lib/deviceToken.js';
import { prisma } from '../db.js';
import {
  isOperatorToken, operatorTokenConfigured, verifyOperatorToken, operatorMayCall,
  stripOperatorEscapeHatches, operatorWithinDailyCap, operatorTokenFingerprint,
  OPERATOR_DAILY_TURN_CAP,
} from '../lib/operatorToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');

const router = Router();

// Public functions that must work for unauthenticated visitors (marketplace
// browsing, Stripe webhooks). Everything else requires a logged-in user —
// each handler still re-checks ownership on the specific rows it touches.
const PUBLIC_FUNCTIONS = new Set(['browseTemplates', 'getPublicTemplate', 'downloadFreeTemplate', 'stripeWebhook', 'checkDeployHealth', 'createDonationCheckout', 'submitFeedback']);

// Functions that require the caller's User.role to be 'admin', enforced
// server-side. generateRebuildDoc used to rely solely on the frontend's
// ProtectedRoute adminOnly guard (a flagged gap from an earlier audit) — it
// dumps the full architecture blueprint (every table's field list including
// which fields hold encrypted secrets, every backend function's purpose/
// input/output, deploy/integration internals) into a stored, downloadable
// doc, which is meant to be admin-only per base44's own self-documentation
// tools. Closed here the same way synthesizeUpdatesPlan already was.
// importSelfDevRepo/pushSelfDevToGithub/generateSelfDevPrototype/
// generateSelfDevManual: self-dev (Morpheus editing its own live production
// repo) is admin-only end to end — see chatWithMorpheus.js's matching
// in-handler check for why that one can't be listed here too (it's shared by
// every project type, not self-dev-exclusive).
// buildDeckWidget: designed for any signed-in user to trigger eventually
// (it internally elevates to the self-dev actor for its own privileged
// calls — see that file's own comment) but gated here as admin-only for
// now, since chatWithJarvis.js isn't yet the real, guarded caller and this
// route is reachable directly the moment the file exists. Remove this once
// Phase 3 (the chat trigger + deckWidgets.js append-only push guard) lands.
const ADMIN_FUNCTIONS = new Set(['synthesizeUpdatesPlan', 'generateRebuildDoc', 'importSelfDevRepo', 'pushSelfDevToGithub', 'generateSelfDevPrototype', 'generateSelfDevManual', 'verifySelfDev', 'revertSelfDevPush', 'mergeSelfDevPr', 'smokeCheckSelfDev', 'applySelfDevMigrations', 'buildDeckWidget']);

router.all('/:name', async (req, res, next) => {
  const { name } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return res.status(400).json({ error: 'Invalid function name' });

  const filePath = path.join(FUNCTIONS_DIR, `${name}.js`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `Unknown function: ${name}` });

  if (!PUBLIC_FUNCTIONS.has(name)) {
    // An operator token (scripts/morpheus.mjs — a scoped, revocable credential
    // that drives self-dev without a browser) is recognised BEFORE requireAuth,
    // because it is not a JWT and requireAuth would reject it outright. It gets
    // its own, strictly narrower gate: see handleOperatorCall below for what it
    // may reach, and lib/operatorToken.js for why the shape is what it is.
    const bearer = bearerToken(req);
    if (isOperatorToken(bearer)) return handleOperatorCall(req, res, next, name, bearer);

    return requireAuth(req, res, () => {
      // An embeddable-widget token acts as the owner but is boxed in: only
      // functions in its scopes, never admin/self-dev functions (even if the
      // owner is an admin), and always pinned to its own project.
      if (req.widget) {
        if (ADMIN_FUNCTIONS.has(name) || !widgetMayCall(req.widget.scopes, name)) {
          return res.status(403).json({ error: `Widget tokens can't call ${name}` });
        }
        req.body = { ...(req.body || {}), projectId: req.widget.projectId };
      }
      if (req.device) {
        // No forced projectId — a device token (Morpheus Connect, for native/
        // compiled apps) is personal, not tied to any one project.
        if (ADMIN_FUNCTIONS.has(name) || !deviceMayCall(req.device.scopes, name)) {
          return res.status(403).json({ error: `Device tokens can't call ${name}` });
        }
      }
      if (ADMIN_FUNCTIONS.has(name)) {
        return requireAdmin(req, res, () => runFunction(name, filePath, req, res, next));
      }
      return runFunction(name, filePath, req, res, next);
    });
  }
  return runFunction(name, filePath, req, res, next);
});

/** The bearer value from the Authorization header, or '' — no parsing beyond that. */
function bearerToken(req) {
  const header = (req.get && req.get('authorization')) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/**
 * The operator path — a scoped, revocable, non-human client driving self-dev.
 *
 * Everything that makes this safe is here rather than in lib/operatorToken.js,
 * because it needs the database: the token acts as the self-dev workspace's own
 * owner (the same actor buildDeckWidget resolves), is pinned to that workspace,
 * and every call leaves an audit row.
 *
 * What it deliberately cannot do: reach any function outside
 * OPERATOR_SCOPE_FUNCTIONS, touch any project other than the self_dev singleton,
 * carry `force` / `directToMain` / `acknowledgeDrift` / `scopePolicy` into a
 * handler (stripped before dispatch, so it cannot push to main, skip the verify
 * gate, or exempt itself from the H9 drift guard), or spend an unbounded number
 * of AI turns in a day.
 */
async function handleOperatorCall(req, res, next, name, bearer) {
  if (!operatorTokenConfigured()) {
    return res.status(503).json({ error: 'Operator access is not configured on this deployment (MORPHEUS_OPERATOR_TOKEN_SHA256 is unset).' });
  }
  if (!verifyOperatorToken(bearer)) {
    // The value is deliberately not logged, here or anywhere: this workspace has
    // leaked a live API key and a live embed token into transcript logs, and a
    // near-miss is still a candidate to guess against.
    console.warn('[operator] rejected a token that did not match the configured hash');
    return res.status(401).json({ error: 'Invalid operator token.' });
  }
  if (!operatorMayCall(name)) {
    return res.status(403).json({ error: `The operator token can't call ${name}` });
  }

  let actor;
  let project;
  try {
    // Same resolver the widget-build path uses, so the operator acts as exactly
    // the same owner on exactly the same workspace — and a shadow self_dev row
    // created by a non-admin can never win (see that function's own comment).
    ({ actor, project } = await import('../functions/buildDeckWidget.js').then((m) => m.resolveSelfDevActor()));
  } catch (err) {
    return res.status(err?.status || 503).json({ error: err?.message || 'No self-dev workspace exists yet.' });
  }

  if (name === 'chatWithMorpheus') {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const turnsToday = await prisma.usageRecord.count({
      where: { project_id: project.id, action_type: { startsWith: 'chat' }, created_date: { gte: startOfDay } },
    }).catch(() => 0);
    if (!operatorWithinDailyCap(turnsToday)) {
      return res.status(429).json({ error: `Operator daily cap reached — ${OPERATOR_DAILY_TURN_CAP} self-dev turns today. Raise OPERATOR_DAILY_TURN_CAP in server/src/lib/operatorToken.js deliberately if this is intended.` });
    }
  }

  const { body, stripped } = stripOperatorEscapeHatches(req.body);

  req.user = actor;
  // Every function in the allow-list is scoped to the self-dev workspace, so the
  // project is pinned here rather than trusted from the caller.
  req.body = { ...body, projectId: project.id };

  prisma.adminAuditLog.create({
    data: {
      admin_id: actor.id,
      action: 'operator_token_call',
      details: JSON.stringify({ fn: name, projectId: project.id, stripped, token: operatorTokenFingerprint(bearer) }).slice(0, 2000),
    },
  }).catch(() => { /* auditing is best-effort, never a reason to fail the call */ });

  return runFunction(name, path.join(FUNCTIONS_DIR, `${name}.js`), req, res, next);
}

async function runFunction(name, filePath, req, res, next) {
  try {
    const mod = await import(`../functions/${name}.js`);
    const handler = mod.default;
    if (typeof handler !== 'function') return res.status(500).json({ error: `Function ${name} has no default export` });

    const result = await handler({ user: req.user || null, body: req.body || {}, query: req.query || {}, req, res });
    if (res.headersSent) return; // handler streamed its own response (e.g. a ZIP)
    res.json(result ?? { ok: true });
  } catch (err) {
    console.error(`[functions/${name}]`, err);
    const body = { error: err.message || 'Internal error' };
    // Forward a typed error's extra machine-readable fields generically
    // (duck-typed, not imported here) so the frontend can react to specific
    // failure kinds instead of just showing text — currently only
    // InsufficientCreditsError (server/src/lib/billing.js) sets these, to
    // drive the global out-of-credits popup, but any future typed error can
    // do the same without this dispatcher needing to know about it.
    if (err.code) body.code = err.code;
    if (typeof err.needed === 'number') body.needed = err.needed;
    if (typeof err.available === 'number') body.available = err.available;
    res.status(err.status || 500).json(body);
  }
}

export default router;
