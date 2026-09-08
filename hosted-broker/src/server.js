// Morpheus hosted broker — see README.md for what this is and why it's a
// separate service from server/ (the main Morpheus backend).
//
// Three jobs, all stateless aside from the short-lived exchange codes:
//   1. GitHub OAuth broker  (/github/start, /github/callback, /github/exchange)
//   2. Google OAuth broker  (/google/start, /google/callback, /google/exchange)
//   3. AI gateway passthrough (/v1/chat/completions)
//
// Any self-hosted Morpheus instance that hasn't configured its own OAuth
// Apps / AI key points MORPHEUS_BROKER_URL at a deployment of this service
// and gets working GitHub connect, Google login, and AI chat immediately —
// see server/src/config/hostedDefaults.js for the instance-side half of
// this protocol.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import * as exchangeStore from './exchangeStore.js';
import * as deviceStore from './deviceStore.js';
import { allow } from './rateLimit.js';

// Kept in sync with server/src/routes/connections.routes.js's GH_SCOPE.
const GH_SCOPE = 'repo delete_repo read:user workflow';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4600;
const JWT_SECRET = process.env.BROKER_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('BROKER_JWT_SECRET is required — refusing to start with an unsigned state parameter.');
  process.exit(1);
}

function brokerOrigin(req) {
  return process.env.BROKER_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// An instance_callback must be a URL the broker operator is willing to
// redirect a live OAuth code to. Require https by default; allow http only
// for local development against localhost.
function validCallback(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (process.env.BROKER_ALLOW_INSECURE_CALLBACKS === 'true' && u.protocol === 'http:') return true;
    return false;
  } catch {
    return false;
  }
}

app.get('/', (req, res) => {
  res.json({
    service: 'morpheus-hosted-broker',
    github: Boolean(process.env.BROKER_GITHUB_CLIENT_ID),
    google: Boolean(process.env.BROKER_GOOGLE_CLIENT_ID),
    aiGateway: Boolean(process.env.BROKER_AI_UPSTREAM_KEY),
  });
});

// ── GitHub broker ──────────────────────────────────────────────────
app.get('/github/start', (req, res) => {
  if (!process.env.BROKER_GITHUB_CLIENT_ID) return res.status(501).json({ error: 'Broker has no GitHub OAuth App configured' });
  const { instance_callback, instance_state } = req.query;
  if (!validCallback(instance_callback || '')) return res.status(400).json({ error: 'invalid instance_callback' });

  const state = jwt.sign({ instance_callback, instance_state: instance_state || '' }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.BROKER_GITHUB_CLIENT_ID,
    redirect_uri: `${brokerOrigin(req)}/github/callback`,
    // 2026-09-08: added delete_repo so cleanupBuildRepos.js (batch-deletes
    // the throwaway morpheus-build-* compile repos) works for
    // broker-connected instances too, not just self-hosted OAuth Apps --
    // see connections.routes.js's matching change for why `repo` alone
    // doesn't cover it.
    scope: 'repo delete_repo read:user workflow',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { instance_callback, instance_state } = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.BROKER_GITHUB_CLIENT_ID,
        client_secret: process.env.BROKER_GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${brokerOrigin(req)}/github/callback`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'GitHub token exchange failed');

    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const profile = await profileRes.json();

    const oneTimeCode = exchangeStore.put({ access_token: tokenData.access_token, profile: { id: profile.id, login: profile.login, name: profile.name, avatar_url: profile.avatar_url } });
    const redirect = new URL(instance_callback);
    redirect.searchParams.set('code', oneTimeCode);
    redirect.searchParams.set('state', instance_state);
    res.redirect(redirect.toString());
  } catch (err) {
    res.status(500).send(`Broker: GitHub connection failed: ${err.message}`);
  }
});

app.post('/github/exchange', (req, res) => {
  const { code } = req.body || {};
  const value = code ? exchangeStore.take(code) : null;
  if (!value) return res.status(400).json({ error: 'invalid or expired code' });
  res.json(value);
});

// ── GitHub device flow (broker-held OAuth App) ─────────────────────
// The instance can't run the device flow itself when it has no OAuth App —
// GitHub ties a device_code to the client_id that created it. So the broker
// mints it with BROKER_GITHUB_CLIENT_ID and hands back an opaque ref; the
// instance polls /github/device/poll with that ref and the broker does the
// GitHub token exchange with its own credentials, returning the token
// server-to-server exactly like /github/exchange.
app.post('/github/device/start', async (req, res) => {
  if (!process.env.BROKER_GITHUB_CLIENT_ID) return res.status(501).json({ error: 'Broker has no GitHub OAuth App configured' });
  try {
    const r = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: process.env.BROKER_GITHUB_CLIENT_ID, scope: GH_SCOPE }),
    });
    const d = await r.json();
    if (!d.device_code) {
      return res.status(502).json({ error: d.error_description || d.error || 'GitHub did not return a device code — is Device Flow enabled on the broker OAuth App?' });
    }
    const device_code_ref = deviceStore.put({ device_code: d.device_code });
    res.json({ device_code_ref, user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval || 5, expires_in: d.expires_in || 900 });
  } catch (err) {
    res.status(502).json({ error: `device start failed: ${err.message}` });
  }
});

app.post('/github/device/poll', async (req, res) => {
  const { device_code_ref } = req.body || {};
  const entry = device_code_ref ? deviceStore.get(device_code_ref) : null;
  if (!entry) return res.status(400).json({ status: 'expired', error: 'invalid or expired device_code_ref' });
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.BROKER_GITHUB_CLIENT_ID,
        device_code: entry.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const d = await r.json();
    if (d.error === 'authorization_pending' || d.error === 'slow_down') return res.json({ status: 'pending' });
    if (d.error === 'expired_token') { deviceStore.drop(device_code_ref); return res.status(400).json({ status: 'expired', error: 'device code expired' }); }
    if (d.error === 'access_denied') { deviceStore.drop(device_code_ref); return res.status(400).json({ status: 'denied', error: 'authorization declined' }); }
    if (d.error || !d.access_token) return res.status(400).json({ status: 'error', error: d.error_description || d.error || 'authorization failed' });

    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${d.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const profile = await profileRes.json();
    deviceStore.drop(device_code_ref);
    res.json({ status: 'connected', access_token: d.access_token, profile: { id: profile.id, login: profile.login, name: profile.name, avatar_url: profile.avatar_url } });
  } catch (err) {
    res.status(502).json({ status: 'error', error: `device poll failed: ${err.message}` });
  }
});

// ── Google broker ──────────────────────────────────────────────────
app.get('/google/start', (req, res) => {
  if (!process.env.BROKER_GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Broker has no Google OAuth App configured' });
  const { instance_callback, instance_state } = req.query;
  if (!validCallback(instance_callback || '')) return res.status(400).json({ error: 'invalid instance_callback' });

  const state = jwt.sign({ instance_callback, instance_state: instance_state || '' }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.BROKER_GOOGLE_CLIENT_ID,
    redirect_uri: `${brokerOrigin(req)}/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { instance_callback, instance_state } = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.BROKER_GOOGLE_CLIENT_ID,
        client_secret: process.env.BROKER_GOOGLE_CLIENT_SECRET,
        redirect_uri: `${brokerOrigin(req)}/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Google token exchange failed');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const oneTimeCode = exchangeStore.put({ profile: { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture } });
    const redirect = new URL(instance_callback);
    redirect.searchParams.set('code', oneTimeCode);
    redirect.searchParams.set('state', instance_state);
    res.redirect(redirect.toString());
  } catch (err) {
    res.status(500).send(`Broker: Google login failed: ${err.message}`);
  }
});

app.post('/google/exchange', (req, res) => {
  const { code } = req.body || {};
  const value = code ? exchangeStore.take(code) : null;
  if (!value) return res.status(400).json({ error: 'invalid or expired code' });
  res.json(value);
});

// ── AI gateway passthrough ───────────────────────────────────────────
// Deployment tokens are opaque bearer strings the broker operator hands out
// (BROKER_AI_ALLOWED_TOKENS, comma-separated — swap for a real per-deployment
// token table + usage metering before relying on this for paid quotas; this
// is deliberately the simplest thing that works for a first deployment).
app.post('/v1/chat/completions', async (req, res) => {
  if (!process.env.BROKER_AI_UPSTREAM_KEY) return res.status(501).json({ error: 'Broker has no upstream AI key configured' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const allowedTokens = (process.env.BROKER_AI_ALLOWED_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (allowedTokens.length > 0 && !allowedTokens.includes(token)) {
    return res.status(403).json({ error: 'unrecognized deployment token' });
  }
  if (!allow(token || req.ip, { max: Number(process.env.BROKER_AI_RATE_LIMIT_PER_MIN) || 30 })) {
    return res.status(429).json({ error: 'rate limit exceeded — this is a shared default gateway; configure your own LLM_API_KEY for dedicated capacity' });
  }

  try {
    const upstreamBase = (process.env.BROKER_AI_UPSTREAM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const upstreamRes = await fetch(`${upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BROKER_AI_UPSTREAM_KEY}` },
      body: JSON.stringify(req.body),
    });
    const data = await upstreamRes.text();
    res.status(upstreamRes.status).type('application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: `upstream AI request failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Morpheus hosted broker listening on :${PORT}`);
});
