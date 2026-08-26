import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword, issueToken, requireAuth, publicUser, generateOtp } from '../auth.js';
import { sendMail } from '../lib/mailer.js';
import { brokerUrl } from '../config/hostedDefaults.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

function frontendUrl() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0];
}

function thisInstanceOrigin(req) {
  return process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

async function completeGoogleLogin(profile, returnTo) {
  let user = await prisma.user.findFirst({ where: { OR: [{ google_id: profile.id }, { email: profile.email?.toLowerCase() }] } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: profile.email.toLowerCase(), password_hash: '', full_name: profile.name || null, google_id: profile.id, email_verified: true },
    });
    await prisma.userSettings.create({ data: { created_by_id: user.id, ai_mode: 'default' } });
  } else if (!user.google_id) {
    user = await prisma.user.update({ where: { id: user.id }, data: { google_id: profile.id, email_verified: true } });
  }
  const token = issueToken(user);
  return `${frontendUrl()}/auth/callback?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const password_hash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), password_hash, full_name: full_name || null, role: 'user' },
    });
    await prisma.userSettings.create({ data: { created_by_id: user.id, ai_mode: 'default' } });

    const otp = generateOtp();
    await prisma.user.update({ where: { id: user.id }, data: { otp_code: otp, otp_expires: new Date(Date.now() + 15 * 60 * 1000) } });
    sendMail({ to: user.email, subject: 'Verify your Morpheus account', text: `Your verification code is ${otp}. It expires in 15 minutes.` }).catch(() => {});

    const token = issueToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify-otp', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    const user = req.user;
    if (!user.otp_code || !user.otp_expires || user.otp_expires < new Date()) {
      return res.status(400).json({ error: 'No pending verification code, or it expired' });
    }
    if (String(code) !== String(user.otp_code)) return res.status(400).json({ error: 'Incorrect code' });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { email_verified: true, otp_code: null, otp_expires: null },
    });
    res.json({ user: publicUser(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/resend-otp', requireAuth, async (req, res) => {
  try {
    const otp = generateOtp();
    await prisma.user.update({ where: { id: req.user.id }, data: { otp_code: otp, otp_expires: new Date(Date.now() + 15 * 60 * 1000) } });
    await sendMail({ to: req.user.email, subject: 'Your Morpheus verification code', text: `Your verification code is ${otp}. It expires in 15 minutes.` });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/logout', (_req, res) => res.json({ ok: true })); // stateless JWT — client discards the token

// Link-based reset (matches the frontend: ForgotPassword emails a link,
// ResetPassword reads ?token= with no email field). The token is a
// short-lived, single-purpose JWT — no server-side state needed beyond the
// user's current password_hash, which we fold into the signature so the
// link is invalidated the moment the password actually changes.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const user = await prisma.user.findUnique({ where: { email: String(email || '').toLowerCase() } });
    // Always 200 — don't leak whether an email is registered.
    if (user) {
      const resetToken = jwt.sign({ uid: user.id, purpose: 'pwreset', pwv: user.password_hash.slice(-8) }, JWT_SECRET, { expiresIn: '30m' });
      const link = `${frontendUrl()}/reset-password?token=${encodeURIComponent(resetToken)}`;
      sendMail({ to: user.email, subject: 'Reset your Morpheus password', text: `Reset your password:\n${link}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email.` }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    if (!resetToken || !newPassword) return res.status(400).json({ error: 'resetToken and newPassword required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    let payload;
    try {
      payload = jwt.verify(resetToken, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    if (payload.purpose !== 'pwreset') return res.status(400).json({ error: 'Invalid reset token' });

    const user = await prisma.user.findUnique({ where: { id: payload.uid } });
    if (!user || user.password_hash.slice(-8) !== payload.pwv) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const password_hash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { password_hash } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google OAuth login ──────────────────────────────────────────────
// Tier 1: this deployment's own GOOGLE_CLIENT_ID/SECRET, if set.
// Tier 2: no local OAuth App — route through the Morpheus Cloud broker
// (MORPHEUS_BROKER_URL, see hosted-broker/), same pattern as GitHub in
// connections.routes.js.
router.get('/google/start', (req, res) => {
  // returnTo was already sanitized client-side (safeReturnTo()) before
  // reaching here; sign it into `state` so the callback can trust it without
  // re-deriving it from a query param an attacker could tamper with.
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') && !req.query.returnTo.startsWith('//') ? req.query.returnTo : '/';

  if (process.env.GOOGLE_CLIENT_ID) {
    const state = jwt.sign({ returnTo }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  const broker = brokerUrl();
  if (broker) {
    const instanceState = jwt.sign({ returnTo }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      instance_callback: `${thisInstanceOrigin(req)}/api/auth/google/broker-callback`,
      instance_state: instanceState,
    });
    return res.redirect(`${broker}/google/start?${params}`);
  }

  return res.status(501).json({ error: 'Google login not configured. Set GOOGLE_CLIENT_ID/SECRET, or MORPHEUS_BROKER_URL to use the Morpheus Cloud default.' });
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    let returnTo = '/';
    try { returnTo = jwt.verify(state, JWT_SECRET).returnTo || '/'; } catch { /* fall back to '/' */ }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Google token exchange failed');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    res.redirect(await completeGoogleLogin(profile, returnTo));
  } catch (err) {
    res.status(500).send(`Google login failed: ${err.message}`);
  }
});

// Completes the broker-routed flow: the broker already exchanged the
// Google code for a token+profile using ITS OWN client secret and is
// handing us a one-time code we redeem server-to-server. See
// hosted-broker/README.md for the protocol (mirrors the GitHub broker flow
// in connections.routes.js).
router.get('/google/broker-callback', async (req, res) => {
  try {
    const broker = brokerUrl();
    if (!broker) return res.status(501).send('Broker not configured');
    const { code, state } = req.query;
    let returnTo = '/';
    try { returnTo = jwt.verify(state, JWT_SECRET).returnTo || '/'; } catch { /* fall back to '/' */ }

    const exchangeRes = await fetch(`${broker}/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { profile, error } = await exchangeRes.json();
    if (!profile) throw new Error(error || 'Broker exchange failed');

    res.redirect(await completeGoogleLogin(profile, returnTo));
  } catch (err) {
    res.status(500).send(`Google login failed: ${err.message}`);
  }
});

export default router;
