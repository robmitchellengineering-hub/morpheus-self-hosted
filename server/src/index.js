import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.routes.js';
import connectionsRoutes from './routes/connections.routes.js';
import entitiesRoutes from './routes/entities.routes.js';
import functionsRoutes from './routes/functions.routes.js';
import uploadsRoutes from './routes/uploads.routes.js';
import mediaAssetsRoutes from './routes/mediaAssets.routes.js';
import cabinetRoutes from './routes/cabinet.routes.js';
import captureRoutes from './routes/capture.routes.js';
import boardRoutes from './routes/board.routes.js';
import rigRoutes from './routes/rig.routes.js';
import adminRoutes from './routes/admin.routes.js';
import appCapabilityRoutes from './routes/appCapability.routes.js';
import brokerRoutes from './routes/broker.routes.js';
import { LOCAL_ROOT } from './storage.js';
import { startFreshnessSchedule } from './freshnessSchedule.js';
import { startDeepSeekBalanceSchedule } from './deepseekBalanceSchedule.js';
import { startDeckInsightSchedule } from './lib/deckInsightSchedule.js';
import { startSiteMaintenanceSchedule } from './siteMaintenanceSchedule.js';
import { resolveCors } from './lib/corsOrigin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1); // behind a load balancer/ingress in production — see SCALING.md

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Was: `(process.env.CORS_ORIGIN || '*')` with `credentials: true` — i.e. an
// unset CORS_ORIGIN reflected ANY origin AND allowed credentials on it.
// Now defaults to the dev frontend and never combines a wildcard with
// credentials; see lib/corsOrigin.js for why credentials are unnecessary here.
const corsPolicy = resolveCors(process.env.CORS_ORIGIN);
if (corsPolicy.wildcard) {
  console.warn('[cors] CORS_ORIGIN includes "*" — any origin is reflected. Credentials are disabled as a result, and this is intended for local development only. Set an explicit comma-separated allowlist in production.');
}
app.use(cors({ origin: corsPolicy.origin, credentials: corsPolicy.credentials }));

// Stripe webhooks need the raw body for signature verification — mount
// before the JSON body parser, scoped to that one route only.
app.use('/api/functions/stripeWebhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// Coarse global rate limit; per-route/per-user limits belong in front of
// costly AI/compile endpoints once you're scaling — see SCALING.md.
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'morpheus-server', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/entities', entitiesRoutes);
app.use('/api/functions', functionsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/media-assets', mediaAssetsRoutes);
app.use('/api/cabinet', cabinetRoutes);
app.use('/api/capture', captureRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/rig', rigRoutes);
app.use('/api/admin', adminRoutes);

// App capability grants — what a GENERATED APP's backend calls, with a bearer
// `apc_` grant and nothing else. Deliberately NOT under /api/functions: that
// dispatcher resolves a scoped token into a real Morpheus user, and an app
// capability must never be able to borrow a session surface. See the route's own
// header for why a static app cannot hold one of these at all.
app.use('/api/app-capability', appCapabilityRoutes);

// The Morpheus Cloud gateway — what a self-hosted install's broker asks before and after every
// brokered AI call, and what an install calls once to mint its own gateway token. Under /api/broker
// rather than /api/functions for the same reason as the capability grants above: verify/usage are
// authenticated by a shared broker secret, not by a user session, and must not be reachable through
// the dispatcher that turns a scoped token into a real user. See the route's own header.
app.use('/api/broker', brokerRoutes);

// Local-disk storage driver serves files from here. Swap to S3/R2 + a CDN
// in front for anything beyond a single instance — see SCALING.md.
app.use('/uploads', express.static(LOCAL_ROOT, { maxAge: '1y', immutable: true }));

// ── Local single-process mode (Portable Morpheus) ────────────────────────────
// When a built frontend sits at <repo>/dist, serve it from THIS origin. That is the point of a local
// install: one process hosting the app and every backend function, with the frontend calling the
// same-origin `/api` (see src/api/base44Client.js's default base) — no second static server for the
// operator to run, and no CORS allowlist for them to get wrong. `CORS_ORIGIN` stays untouched.
//
// On the hosted deployment this is a no-op: the backend image has no dist/ (the frontend is on
// Netlify), so neither the mount nor the fallback is registered and production behaviour is unchanged.
const PORTABLE_DIST = path.resolve(__dirname, '..', '..', 'dist');
if (existsSync(path.join(PORTABLE_DIST, 'index.html'))) {
  app.use(express.static(PORTABLE_DIST, { index: false }));
  // The Deck is its own installed app with its own manifest — public/_redirects does this on Netlify,
  // and a deep link like /deck/settings has to reach deck.html here for the same reason.
  app.get(/^\/deck(\/.*)?$/, (_req, res) => res.sendFile(path.join(PORTABLE_DIST, 'deck.html')));
  // SPA fallback: every other non-API path renders index.html so a refresh on a client route works.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(PORTABLE_DIST, 'index.html')));
  console.log('[morpheus] local mode: serving the built frontend from dist/');
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const port = process.env.PORT || 4500;
app.listen(port, () => {
  console.log(`[morpheus] server listening on :${port}`);
  startFreshnessSchedule();
  startDeepSeekBalanceSchedule();
  startDeckInsightSchedule();
  startSiteMaintenanceSchedule();
});
