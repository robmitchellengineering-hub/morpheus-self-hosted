// GitHub account-linking OAuth flow (distinct from login). The result feeds
// base44/shared/githubConnection.ts's `getCurrentAppUserConnection` — ported
// as src/lib/github.js's `getGithubToken(userId)`.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { requireAuth, blockWidget } from '../auth.js';
import { encrypt } from '../crypto.js';
import { brokerUrl } from '../config/hostedDefaults.js';
import { GSC_SCOPE } from '../lib/searchConsole.js';
import { safeReturnTo } from '../lib/safeRedirect.js';

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

router.get('/github/start', requireAuth, blockWidget, (req, res) => {
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

router.post('/github/device/start', requireAuth, blockWidget, async (req, res) => {
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

router.post('/github/device/poll', requireAuth, blockWidget, async (req, res) => {
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

router.delete('/github', requireAuth, blockWidget, async (req, res) => {
  await prisma.githubConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

// ── Google Drive connection (User-Choice Cloud Storage, Feature Backlog
// #12, Phase 1) ──────────────────────────────────────────────────────────
// Deliberately its own connect flow, not piggybacked on Google sign-in
// (auth.routes.js's /google/start): login never requests a refresh token,
// and on the shared-broker (Tier 2) path other self-hosted deployments use,
// the broker discards the access/refresh token entirely after reading the
// profile (see hosted-broker/src/server.js) — there's nothing to hand back.
// So this only works for a deployment with its own GOOGLE_CLIENT_ID/SECRET
// (same credentials login already uses, since sign-in works here) plus a
// separate GOOGLE_DRIVE_REDIRECT_URI so the two callbacks never collide.
// No broker path, no device flow — matches this feature's Phase 1 scope.
// `email` is required alongside drive.file — without it, Google's
// /oauth2/v2/userinfo returns no email field, and persistGoogleDriveConnection
// below fails on drive_email (a required column) with no such scope granted.
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file email';

async function persistGoogleDriveConnection(uid, { access_token, refresh_token, scope, expires_in, profile }) {
  if (!profile) {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    profile = await profileRes.json();
  }
  const data = {
    drive_email: profile.email,
    access_token: encrypt(access_token),
    scope: scope || GOOGLE_DRIVE_SCOPE,
    refresh_token: encrypt(refresh_token),
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
  };
  await prisma.googleDriveConnection.upsert({
    where: { created_by_id: uid },
    create: { created_by_id: uid, ...data },
    update: data,
  });
  return profile.email;
}

router.get('/google-drive/start', requireAuth, blockWidget, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(501).json({
      error: 'Google Drive storage requires this deployment\'s own GOOGLE_CLIENT_ID/SECRET (the same ones Google sign-in uses) plus GOOGLE_DRIVE_REDIRECT_URI — not available via the shared broker.',
    });
  }
  const state = jwt.sign({ uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_DRIVE_SCOPE,
    // Login's own /google/start uses prompt=select_account and never sets
    // access_type — that combination never returns a refresh_token. Both
    // of these are required here specifically to get one: access_type=
    // offline asks for a refresh_token at all, and prompt=consent forces
    // Google to re-show the consent screen (and re-issue a refresh_token)
    // even for a user who's already granted this exact scope before —
    // without it, a reconnect after a revoke could silently come back with
    // no refresh_token and an access-only connection that dies in an hour.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google-drive/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { uid, purpose, returnTo } = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'Google token exchange failed');
    if (!tokenData.refresh_token) {
      throw new Error(purpose === 'search_console'
        ? 'Google did not return a refresh token — remove Morpheus\'s existing access at https://myaccount.google.com/permissions, then connect Search Console again.'
        : 'Google did not return a refresh token — disconnect any prior Drive connection and try again.');
    }

    // This callback serves more than one Google purpose — see /search-console/start
    // for why they share a redirect URI. `purpose` comes from the SIGNED state, so
    // it cannot be set by whoever holds the callback URL.
    if (purpose === 'search_console') {
      await persistSearchConsoleConnection(uid, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        scope: tokenData.scope,
        expires_in: tokenData.expires_in,
      });
      return res.redirect(`${frontendUrl()}${safeReturnTo(returnTo, '/settings')}?searchConsole=connected`);
    }

    await persistGoogleDriveConnection(uid, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      scope: tokenData.scope,
      expires_in: tokenData.expires_in,
    });

    res.redirect(`${frontendUrl()}/settings?googleDrive=connected`);
  } catch (err) {
    res.status(500).send(`Google Drive connection failed: ${err.message}`);
  }
});

router.delete('/google-drive', requireAuth, blockWidget, async (req, res) => {
  await prisma.googleDriveConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

// ── Google Search Console (read-only: the account's own search performance) ──
//
// Same consent screen and client as the Drive connection above, and deliberately
// its own row (schema.prisma's SearchConsoleConnection): the scope is unrelated
// to file storage, it is useful to someone with no Drive connection at all, and
// folding it in would make every Drive user re-consent for a scope their feature
// does not use.
//
// IT REUSES GOOGLE_DRIVE_REDIRECT_URI ON PURPOSE. Google requires an exact match
// between the redirect_uri sent here and one registered on the OAuth client, so a
// third URI would mean a manual trip to the Cloud Console — for the operator, a
// step with no benefit. Instead the signed `state` carries `purpose`, and the
// shared callback dispatches on it. If GOOGLE_SEARCH_CONSOLE_REDIRECT_URI is ever
// set, it is preferred, so a deployment can separate them without a code change.
function searchConsoleRedirectUri() {
  return process.env.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI || process.env.GOOGLE_DRIVE_REDIRECT_URI;
}

// Where the browser lands after consent. The rule itself lives in
// lib/safeRedirect.js — pure and directly asserted, because an open redirect is a
// real vulnerability and this value arrives in a query string.

async function persistSearchConsoleConnection(uid, { access_token, refresh_token, scope, expires_in }) {
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const profile = await profileRes.json();
  // `email` is requested alongside the Search Console scope for the same reason
  // the Drive flow needs it: without it Google's userinfo returns no email, and
  // gsc_email is a required column — which is how that bug announced itself on
  // the Drive connection (a silent upsert failure, no row ever created).
  if (!profile?.email) {
    throw new Error('Google returned no email for this account — the connection cannot be identified without it.');
  }
  const data = {
    gsc_email: profile.email,
    access_token: encrypt(access_token),
    scope: scope || GSC_SCOPE,
    refresh_token: encrypt(refresh_token),
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
  };
  // `property` is deliberately not touched: reconnecting must not silently
  // discard a property the operator already chose.
  await prisma.searchConsoleConnection.upsert({
    where: { created_by_id: uid },
    create: { created_by_id: uid, ...data },
    update: data,
  });
  return profile.email;
}

router.get('/search-console/start', requireAuth, blockWidget, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(501).json({
      error: 'Search Console requires this deployment\'s own GOOGLE_CLIENT_ID/SECRET (the same ones Google sign-in uses) plus GOOGLE_DRIVE_REDIRECT_URI — not available via the shared broker.',
    });
  }
  const state = jwt.sign(
    { uid: req.user.id, purpose: 'search_console', returnTo: safeReturnTo(req.query.returnTo) },
    JWT_SECRET,
    { expiresIn: '10m' },
  );
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: searchConsoleRedirectUri(),
    response_type: 'code',
    scope: GSC_SCOPE,
    // Identical reasoning to the Drive flow: access_type=offline is what returns
    // a refresh token at all, and prompt=consent is what returns one for someone
    // who has already granted this scope — search performance is read long after
    // the connect, so an access-only connection would die within the hour.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.delete('/search-console', requireAuth, blockWidget, async (req, res) => {
  await prisma.searchConsoleConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

// ── Command Deck's own Google connection (Gmail + Calendar + Drive backup +
// Docs) ──────────────────────────────────────────────────────────────────
// Deliberately separate from google-drive/* above — see schema.prisma's
// comment above DeckGoogleConnection for why. Structurally identical flow
// (state JWT, access_type=offline&prompt=consent, its own redirect URI env
// var so callbacks never collide).
const DECK_GOOGLE_SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'email',
].join(' ');

async function persistDeckGoogleConnection(uid, { access_token, refresh_token, scope, expires_in, profile }) {
  if (!profile) {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    profile = await profileRes.json();
  }
  const data = {
    google_email: profile.email,
    access_token: encrypt(access_token),
    scope: scope || DECK_GOOGLE_SCOPE,
    refresh_token: encrypt(refresh_token),
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
  };
  await prisma.deckGoogleConnection.upsert({
    where: { created_by_id: uid },
    create: { created_by_id: uid, ...data },
    update: data,
  });
  return profile.email;
}

router.get('/deck-google/start', requireAuth, blockWidget, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(501).json({
      error: 'Command Deck\'s Google connection requires this deployment\'s own GOOGLE_CLIENT_ID/SECRET plus GOOGLE_DECK_REDIRECT_URI — not available via the shared broker.',
    });
  }
  const state = jwt.sign({ uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_DECK_REDIRECT_URI,
    response_type: 'code',
    scope: DECK_GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/deck-google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { uid } = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_DECK_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'Google token exchange failed');
    if (!tokenData.refresh_token) throw new Error('Google did not return a refresh token — disconnect any prior connection and try again.');

    await persistDeckGoogleConnection(uid, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      scope: tokenData.scope,
      expires_in: tokenData.expires_in,
    });

    res.redirect(`${frontendUrl()}/deck/settings?deckGoogle=connected`);
  } catch (err) {
    res.status(500).send(`Command Deck Google connection failed: ${err.message}`);
  }
});

router.delete('/deck-google', requireAuth, blockWidget, async (req, res) => {
  await prisma.deckGoogleConnection.deleteMany({ where: { created_by_id: req.user.id } });
  res.json({ ok: true });
});

export default router;
