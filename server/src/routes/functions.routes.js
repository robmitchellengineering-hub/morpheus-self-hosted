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
const ADMIN_FUNCTIONS = new Set(['synthesizeUpdatesPlan', 'generateRebuildDoc', 'importSelfDevRepo', 'pushSelfDevToGithub', 'generateSelfDevPrototype', 'generateSelfDevManual', 'verifySelfDev', 'revertSelfDevPush', 'mergeSelfDevPr', 'smokeCheckSelfDev']);

router.all('/:name', async (req, res, next) => {
  const { name } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return res.status(400).json({ error: 'Invalid function name' });

  const filePath = path.join(FUNCTIONS_DIR, `${name}.js`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `Unknown function: ${name}` });

  if (!PUBLIC_FUNCTIONS.has(name)) {
    return requireAuth(req, res, () => {
      if (ADMIN_FUNCTIONS.has(name)) {
        return requireAdmin(req, res, () => runFunction(name, filePath, req, res, next));
      }
      return runFunction(name, filePath, req, res, next);
    });
  }
  return runFunction(name, filePath, req, res, next);
});

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
