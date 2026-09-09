import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.routes.js';
import connectionsRoutes from './routes/connections.routes.js';
import entitiesRoutes from './routes/entities.routes.js';
import functionsRoutes from './routes/functions.routes.js';
import uploadsRoutes from './routes/uploads.routes.js';
import mediaAssetsRoutes from './routes/mediaAssets.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { LOCAL_ROOT } from './storage.js';
import { startFreshnessSchedule } from './freshnessSchedule.js';
import { startDeepSeekBalanceSchedule } from './deepseekBalanceSchedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1); // behind a load balancer/ingress in production — see SCALING.md

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
}));

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
app.use('/api/admin', adminRoutes);

// Local-disk storage driver serves files from here. Swap to S3/R2 + a CDN
// in front for anything beyond a single instance — see SCALING.md.
app.use('/uploads', express.static(LOCAL_ROOT, { maxAge: '1y', immutable: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const port = process.env.PORT || 4500;
app.listen(port, () => {
  console.log(`[morpheus] server listening on :${port}`);
  startFreshnessSchedule();
  startDeepSeekBalanceSchedule();
});
