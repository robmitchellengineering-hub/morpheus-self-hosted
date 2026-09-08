// GitHub account-linking OAuth flow (distinct from login). The result feeds
// base44/shared/githubConnection.ts's `getCurrentAppUserConnection` — ported
// as src/lib/github.js's `getGithubToken(userId)`.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { requireAuth } from '../auth.js';
import { encrypt } from '../crypto.js';
import { brokerUrl } from '../config/hostedDefaults.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

// The OAuth scopes every GitHub connection is made with, whichever flow
// (web redirect, broker, or device) created it. `delete_repo` is carved out
// separately by GitHub even though `repo` grants "full control" of
// everything else — cleanupBuildRepos.js needs it to remove the throwaway
// morpheus-build-* repos. Keep this in one place so the flows can't drift.
const GH_SCOPE = 'repo delete_repo read:user workflow';

function thisInstanceOrigin(req) {
  return process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// See auth.routes.js's frontendUrl() for why this is its own env var rather
// than reading CORS_ORIGIN (an allow-list, not "the" canonical frontend).
function frontendUrl() {
  return process.env.FRONTEND_URL || 'https://morpheus.nz';
}

// Every connect flow (web redirect, broker, device) ends the same way: fetch
// the GitHub profile and upsert the user's single GithubConnection row.
// `expires_in`/`refresh_token` are only present when the OAuth App's "Token
// expiration" optional feature is on — see lib/github.js's
// getGithubConnection for the silent-refresh logic that consumes them.
async function persistGithubConnection(uid, { access_token, scope, refresh_token, expires_in, refresh_token_expires_in, profile }) {
  if (!profile) {
    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    profile = await profileRes.json();
  }
  const data = {
    login: profile.login,
    access_token: encrypt(access_token),
    scope: scope || GH_SCOPE,
    refresh_token: refresh_token ? encrypt(refresh_token) : null,
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    refresh_token_expires_at: refresh_token_expires_in ? new Date(Date.now() + refresh_token_expires_in * 1000) : null,
  };
  await prisma.githubConnection.upsert({
    where: { created_by_id: uid },
    create: { created_by_id: uid, ...data },
    update: data,
  });
  return profile.login;
}

router.get('/github/start', requireAuth, (req, res) => {
  // Tier 1: this deployment has its own GitHub OAuth App — use it directly.
  if (process.env.GITHUB_CLIENT_ID) {
    const state = jwt.sign({ uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: process.env.GITHUB_REDIRECT_URI,
      scope: GH_SCOPE,
      state,
    });
    return res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }

  // Tier 2: no local OAuth App — route through the Morpheus Cloud broker
  // (see hosted-broker/), which holds a shared GitHub OAuth App and hands
  // the resulting token back to /github/broker-callback below.
  const broker = brokerUrl();
  if (broker) {
    const instanceState = jwt.sign({ uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      instance_callback: `${thisInstanceOrigin(req)}/api/connections/github/broker-callback`,
      instance_state: instanceState,
    });
    return res.redirect(`${broker}/github/start?${params}`);
  }

  return res.status(501).json({
    error: 'GitHub integration not configured. Set GITHUB_CLIENT_ID/SECRET for your own OAuth App, or MORPHEUS_BROKER_URL to use the Morpheus Cloud default.',
  });
});

// Completes the broker-routed flow above: the broker already exchanged the
// GitHub code for a token using ITS OWN client secret, and is handing us a
// one-time code we redeem server-to-server (the real access_token never
// transits the browser). See hosted-broker/README.md for the protocol.
router.get('/github/broker-callback', async (req, res) => {
  try {
    const broker = brokerUrl();
    if (!broker) return res.status(501).send('Broker not configured');
    const { code, state } = req.query;
    const { uid } = jwt.verify(state, JWT_SECRET);

    const exchangeRes = await fetch(`${broker}/github/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { access_token, profile, error } = await exchangeRes.json();
    if (!access_token) throw new Error(error || 'Broker exchange failed');

    await persistGithubConnection(uid, { access_token, scope: GH_SCOPE, profile });

    res.redirect(`${frontendUrl()}/settings?github=connected`);
  } catch (err) {
    res.status(500).send(`GitHub connection failed: ${err.message}`);
  }
});

router.get('/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { uid } = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: process.env.GITHUB_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'GitHub token exchange failed');

    await persistGithubConnection(uid, {
      access_token: tokenData.access_token,
      scope: tokenData.scope,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      refresh_token_expires_in: tokenData.refresh_token_expires_in,
    });

    res.redirect(`${frontendUrl()}/settings?github=connected`);
  } catch (err) {
    res.status(500).send(`GitHub connection failed: ${err.message}`);
  }
});

// ── GitHub Device Flow ─────────────────────────────────────────────────────
// The web-redirect flow above needs a popup and a registered redirect_uri —
// both unreliable on mobile browsers and inside the webviews that compiled
// Morpheus targets run in. The device flow needs neither: we hand the user a
// short code, they approve it at github.com/login/device in any tab on any
// device, and the frontend polls until the token lands. Same OAuth Apps,
// same scopes, same GithubConnection row.
//
// The OAuth App (or the broker's) must have "Enable Device Flow" ticked in
// its settings for this to work — GitHub returns an error at /device/code
// otherwise, surfaced to the user as-is.
//
// `poll_token` is a signed JWT carrying the GitHub device_code and the user
// it belongs to, handed back to the browser and replayed on every poll. It's
// deliberately stateless — no DB row, no server-side map, so it works across
// backend replicas — and safe to expose: the device_code is single-use,
// expires GitHub-side in ~15 min, and is inert until the user actually
// approves it. Signing it just stops one user polling another's session.

router.post('/github/device/start', requireAuth, async (req, res) => {
  try {
    // Tier 1: this deployment's own OAuth App.
    if (process.env.GITHUB_CLIENT_ID) {
      const r = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, scope: GH_SCOPE }),
      });
      const d = await r.json();
      if (!d.device_code) {
        throw new Error(d.error_description || d.error || 'GitHub did not return a device code — is "Enable Device Flow" turned on for the OAuth App?');
      }
      const poll_token = jwt.sign(
        { uid: req.user.id, tier: 'local', device_code: d.device_code },
        JWT_SECRET,
        { expiresIn: `${d.expires_in || 900}s` },
      );
      return res.json({ user_code: d.user_code, verification_uri: d.verification_uri, poll_token, interval: d.interval || 5, expires_in: d.expires_in || 900 });
    }

    // Tier 2: no local OAuth App — the broker holds one. It mints the
    // device_code with its own client_id and hands us an opaque ref to poll
    // it back through (see hosted-broker/src/server.js).
    const broker = brokerUrl();
    if (broker) {
      const r = await fetch(`${broker}/github/device/start`, { method: 'POST' });
      const d = await r.json();
      if (!d.device_code_ref) throw new Error(d.error || 'Broker did not start a device flow');
      const poll_token = jwt.sign(
        { uid: req.user.id, tier: 'broker', device_code_ref: d.device_code_ref },
        JWT_SECRET,
        { expiresIn: `${d.expires_in || 900}s` },
      );
      return res.json({ user_code: d.user_code, verification_uri: d.verification_uri, poll_token, interval: d.interval || 5, expires_in: d.expires_in || 900 });
    }

    return res.status(501).json({
      error: 'GitHub integration not configured. Set GITHUB_CLIENT_ID/SECRET for your own OAuth App, or MORPHEUS_BROKER_URL to use the Morpheus Cloud default.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/github/device/poll', requireAuth, async (req, res) => {
  try {
    const { poll_token } = req.body || {};
    if (!poll_token) return res.status(400).json({ error: 'missing poll_token', status: 'error' });

    let claims;
    try {
      claims = jwt.verify(poll_token, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'This sign-in code expired. Start again.', status: 'expired' });
    }
    if (claims.uid !== req.user.id) return res.status(403).json({ error: 'not your session', status: 'error' });

    if (claims.tier === 'broker') {
      const broker = brokerUrl();
      if (!broker) return res.status(501).json({ error: 'Broker not configured', status: 'error' });
      const r = await fetch(`${broker}/github/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code_ref: claims.device_code_ref }),
      });
      const d = await r.json();
      if (d.status === 'pending' || d.status === 'slow_down') return res.json({ status: 'pending' });
      if (!d.access_token) return res.status(400).json({ error: d.error || 'Authorization failed', status: d.status || 'error' });
      const login = await persistGithubConnection(req.user.id, { access_token: d.access_token, scope: GH_SCOPE, profile: d.profile });
      return res.json({ status: 'connected', login });
    }

    // Tier 1: poll GitHub directly. Per the device-flow spec the token
    // request takes client_id + device_code + grant_type only — no secret.
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        device_code: claims.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const d = await r.json();
    if (d.error === 'authorization_pending' || d.error === 'slow_down') return res.json({ status: 'pending' });
    if (d.error === 'expired_token') return res.status(400).json({ error: 'This sign-in code expired. Start again.', status: 'expired' });
    if (d.error === 'access_denied') return res.status(400).json({ error: 'Authorization was declined on GitHub.', status: 'denied' });
    if (d.error || !d.access_token) return res.status(400).json({ error: d.error_description || d.error || 'Authorization failed', status: 'error' });

    const login = await persistGithubConnection(req.user.id, {
      access_token: d.access_token,
      scope: d.scope,
      refresh_token: d.refresh_token,
      expires_in: d.expires_in,
      refresh_token_expires_in: d.refresh_token_expires_in,
    });
    res.json({ status: 'connected', login });
  } catch (err) {
    res.status(500).json({ error: err.message, status: 'error' });
  }
});

router.delete('/github', requireAuth, async (req, res) => {
  await prisma.githubConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

export default router;
