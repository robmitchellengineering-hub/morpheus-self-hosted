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

function thisInstanceOrigin(req) {
  return process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// See auth.routes.js's frontendUrl() for why this is its own env var rather
// than reading CORS_ORIGIN (an allow-list, not "the" canonical frontend).
function frontendUrl() {
  return process.env.FRONTEND_URL || 'https://morpheus.nz';
}

router.get('/github/start', requireAuth, (req, res) => {
  // Tier 1: this deployment has its own GitHub OAuth App — use it directly.
  if (process.env.GITHUB_CLIENT_ID) {
    const state = jwt.sign({ uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: process.env.GITHUB_REDIRECT_URI,
      scope: 'repo read:user workflow',
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

    await prisma.githubConnection.upsert({
      where: { created_by_id: uid },
      create: { created_by_id: uid, login: profile?.login, access_token: encrypt(access_token), scope: 'repo read:user workflow' },
      update: { login: profile?.login, access_token: encrypt(access_token), scope: 'repo read:user workflow' },
    });

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

    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const profile = await profileRes.json();

    // Present only when the OAuth App's "Token expiration" optional feature
    // is on — see lib/github.js's getGithubConnection for how these are used
    // to silently refresh instead of the token just dying in ~8 hours.
    const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;
    const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000)
      : null;

    await prisma.githubConnection.upsert({
      where: { created_by_id: uid },
      create: {
        created_by_id: uid, login: profile.login, access_token: encrypt(tokenData.access_token), scope: tokenData.scope,
        refresh_token: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        expires_at: expiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
      },
      update: {
        login: profile.login, access_token: encrypt(tokenData.access_token), scope: tokenData.scope,
        refresh_token: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        expires_at: expiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
      },
    });

    res.redirect(`${frontendUrl()}/settings?github=connected`);
  } catch (err) {
    res.status(500).send(`GitHub connection failed: ${err.message}`);
  }
});

router.delete('/github', requireAuth, async (req, res) => {
  await prisma.githubConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

export default router;
