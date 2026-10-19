// The app capability endpoint — what a GENERATED APP's backend calls.
//
// WHY THIS IS ITS OWN ROUTE AND NOT A FUNCTION
//
// Every other non-session credential here (a `wgt_` widget token, a `dvc_` device
// token) reaches Morpheus through routes/functions.routes.js, which resolves it in
// auth.js's optionalAuth into `req.user` plus a scope object and then narrows what
// it may call. Doing that for an app capability would mean a generated app's token
// resolved to a real Morpheus USER on a surface built to accept Morpheus sessions —
// and "is this still safe?" would then depend on every future edit to that
// dispatcher, the admin list and the scope maps.
//
// So this endpoint accepts EXACTLY ONE credential: a bearer `apc_` grant. There is
// no session path through it at all — `optionalAuth` is never mounted here, so a
// valid Morpheus JWT presented at this URL is just an unknown token and gets a 401.
// That is the property scripts/verify-app-capability-creds.mjs asserts, because it
// is the property that decays silently: adding a session fallback here would be a
// one-line change that looks like a convenience and would hand every logged-in
// Morpheus account a way to act through someone else's grant.
//
// THE TOKEN IS FOR A BACKEND, NEVER FOR A PAGE
//
// A capability token can write to a user's Drive. A static app has nowhere to keep
// one — its whole program is public — so a token shipped in a page would be
// readable and usable by anyone who opened that page. This endpoint is therefore
// server-to-server, and the build-time honesty text says so: an app with no server
// takes its own-OAuth-client route instead, with the steps written out. That is a
// design decision, not a limitation accepted to make a demo work.
//
// WHICH CONNECTION IT SPENDS
//
// lib/googleDrive.js — the PLATFORM connection, scope `drive.file`, made in
// Settings → Google Drive. Deliberately NOT lib/deckGoogle.js (the Command Deck's
// connection, which also carries gmail.readonly, gmail.send, documents and
// calendar.events): functions/photoDrive.js prefers the Deck connection when one
// exists, which is right for a Deck widget, but using it here would silently make
// every generated app require a Command Deck connection and spend a far wider
// scope than the app asked for.
import { Router } from 'express';
import { prisma } from '../db.js';
import {
  APP_CAPABILITY_PREFIX, APP_CAPABILITIES, resolveCapabilityGrant,
} from '../lib/appCapability.js';
import { findCapabilityGrantsByToken, grantOwner, isMissingGrantTable, GRANTS_TABLE_MISSING_MESSAGE } from '../lib/appCapabilityGrants.js';
import { getGoogleDriveConnection, createDriveFile, createDriveFolder, getDriveFileMeta } from '../lib/googleDrive.js';
import { encodeConnections, decodeConnections } from '../lib/connectionSecrets.js';
import { invokeAI } from '../ai.js';
import { CONNECTIONS_KEY, DEFAULT_FOLDER_NAME, driveFileLink, driveFolderLink, classifyDriveError, photoFilename, validatePhoto } from '../lib/photoDrive.js';

const router = Router();

const ACTIONS = ['status', 'upload', 'generate'];

/** The bearer value, or ''. No parsing beyond the one header. */
function bearerToken(req) {
  const header = (req.get && req.get('authorization')) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/**
 * Resolve the presented grant, or answer and return null.
 *
 * Deliberately one helper so the failure wording is in one place and cannot drift
 * between the two actions. Errors name what the APP's developer must do — this
 * response is read from a server log, not by the operator.
 */
async function authorize(req, res) {
  const presented = bearerToken(req);
  if (!presented.startsWith(APP_CAPABILITY_PREFIX)) {
    res.status(401).json({
      error: 'App capability token required.',
      hint: 'Send `Authorization: Bearer apc_…`. A Morpheus session token cannot be used here — this endpoint accepts app capability grants only.',
    });
    return null;
  }

  let rows;
  try {
    rows = await findCapabilityGrantsByToken(presented);
  } catch (err) {
    if (isMissingGrantTable(err)) {
      res.status(503).json({ error: GRANTS_TABLE_MISSING_MESSAGE, code: 'GRANTS_NOT_MIGRATED' });
      return null;
    }
    throw err;
  }

  const decision = resolveCapabilityGrant(rows, {
    appId: req.body?.appId,
    capability: req.body?.capability,
  });
  if (!decision.ok) {
    // 404 for an unknown token, 403 for a real grant used wrongly. Both carry the
    // same body shape as a success would not, and neither echoes the token.
    const status = decision.reason === 'unknown-token' ? 401 : 403;
    res.status(status).json({
      error: {
        'unknown-token': 'That app capability token is not valid.',
        revoked: 'That app capability token has been revoked. The operator must approve this app again.',
        expired: 'That app capability token has expired. The operator must approve this app again.',
        'wrong-app': 'That token was issued to a different app. Use the token issued to this app, or ask the operator to approve this app.',
        'not-granted': 'That capability was not granted to this app.',
      }[decision.reason] || 'That app capability token cannot be used here.',
      code: decision.reason,
      capability: String(req.body?.capability ?? ''),
      appId: String(req.body?.appId ?? ''),
    });
    return null;
  }

  // The user's row is read FRESH on every call, so a grant whose owner has since
  // been deleted, or who has disconnected Google, fails here rather than acting on
  // stale credentials — and, critically, the connection is looked up by the
  // GRANT's owner, never by anything the caller supplied. There is no `userId` a
  // request can name: cross-user use is impossible by construction, not by a check.
  const owner = await grantOwner(decision.grant);
  if (!owner) {
    res.status(403).json({ error: 'The account that approved this app no longer exists.', code: 'no-owner' });
    return null;
  }
  return { grant: decision.grant, owner };
}

/** The operator's chosen Drive folder, or null.
 *
 * Read through the SHARED decoder, never JSON.parse: `user_settings.connections`
 * became encrypted at rest on 2026-09-28 (#397), so parsing the stored value
 * directly throws on a ciphertext row and a local catch turns that into "no folder
 * set" for a folder the operator just chose. `decodeConnections` handles the
 * encrypted form, the legacy plaintext form and the malformed case. */
async function readFolderId(userId) {
  const row = await prisma.userSettings.findUnique({
    where: { created_by_id: userId },
    select: { connections: true },
  });
  return decodeConnections(row?.connections)?.[CONNECTIONS_KEY] ?? null;
}

/** Write it back, preserving every other key in that existing blob — and through
 *  the shared encoder, so the row is stored encrypted rather than reverting it to
 *  plaintext the moment an app uploads a file. */
async function writeFolderId(userId, folderId) {
  const row = await prisma.userSettings.findUnique({
    where: { created_by_id: userId },
    select: { connections: true },
  });
  const all = decodeConnections(row?.connections);
  all[CONNECTIONS_KEY] = folderId;
  const connections = encodeConnections(all);
  await prisma.userSettings.upsert({
    where: { created_by_id: userId },
    create: { created_by_id: userId, connections },
    update: { connections },
  });
}

/**
 * The user's Drive token, or a response and null.
 *
 * A 403 here is the operator's to fix, and the app's developer can say so exactly:
 * `drive.file` is why a folder the user picked by hand will not work.
 */
async function driveTokenFor(res, owner) {
  const connection = await getGoogleDriveConnection(owner.id).catch(() => null);
  if (!connection?.token) {
    res.status(409).json({
      error: 'Google Drive is not connected for the account that approved this app.',
      code: 'no-drive-connection',
      fix: 'The operator connects it in Morpheus → Settings → Google Drive. The app needs no OAuth client of its own once that is done.',
    });
    return null;
  }
  return connection;
}

router.post('/', async (req, res, next) => {
  try {
    const action = String(req.body?.action ?? '');
    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${ACTIONS.join(', ')}.` });
    }
    if (!Object.prototype.hasOwnProperty.call(APP_CAPABILITIES, String(req.body?.capability ?? ''))) {
      return res.status(400).json({ error: `Unknown capability "${req.body?.capability}". Known: ${Object.keys(APP_CAPABILITIES).join(', ')}.` });
    }

    const auth = await authorize(req, res);
    if (!auth) return undefined;

    const { owner } = auth;

    // The AI capability has no provider connection to fetch, so it is handled before the Drive
    // lookup rather than after it — the one place where "one registry, two shapes" has to be said.
    if (req.body.capability === 'ai_generate') {
      return await handleAiGenerate(req, res, owner);
    }

    const connection = await driveTokenFor(res, owner);
    if (!connection) return undefined;

    if (action === 'status') {
      const folderId = await readFolderId(owner.id);
      let folder = null;
      if (folderId) {
        try {
          const meta = await getDriveFileMeta(connection.token, folderId);
          folder = { id: meta.id, name: meta.name, link: driveFolderLink(meta.id) };
        } catch {
          // A folder that has gone is not a failure of the grant — the app can
          // still create one, and saying so precisely is the whole point.
          folder = null;
        }
      }
      return res.json({
        ok: true,
        capability: req.body.capability,
        appId: req.body.appId,
        connected: true,
        email: connection.email,
        // Named so a reader never has to trace a fallback chain to learn which
        // credential the app just spent.
        connection: 'google-drive',
        connectionLabel: 'the operator\'s Morpheus Google Drive connection (drive.file)',
        folder,
      });
    }

    // upload
    let folderId = await readFolderId(owner.id);
    if (!folderId) {
      try {
        folderId = await createDriveFolder(connection.token, DEFAULT_FOLDER_NAME);
        await writeFolderId(owner.id, folderId);
      } catch (err) {
        const { kind, message } = classifyDriveError(err?.status, err?.driveMessage || err?.message);
        return res.status(err?.status || 502).json({ error: message, code: kind });
      }
    }

    const base64 = String(req.body?.dataBase64 || '');
    const mimeType = String(req.body?.mimeType || '').toLowerCase().split(';')[0].trim();
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'dataBase64 could not be decoded.' });
    }

    // Size is checked on the DECODED bytes — the limit that matters is the file,
    // not its base64 overhead. Same validator, and the same limits, as the photo
    // widget: one rule about what we will send to Drive, not two.
    const verdict = validatePhoto({ size: buffer.length, mime: mimeType });
    if (!verdict.ok) return res.status(400).json({ error: verdict.reason, code: 'invalid-file' });

    const name = photoFilename(req.body?.name, mimeType);
    try {
      const created = await createDriveFile(connection.token, { name, parentId: folderId, content: buffer, mimeType });
      return res.json({
        ok: true,
        capability: req.body.capability,
        appId: req.body.appId,
        connection: 'google-drive',
        file: { id: created.id, name, link: driveFileLink(created.id), mimeType, bytes: buffer.length },
        folder: { id: folderId, link: driveFolderLink(folderId) },
        storedBy: 'google-drive',
        email: connection.email,
      });
    } catch (err) {
      const { kind, message } = classifyDriveError(err?.status, err?.driveMessage || err?.message);
      return res.status(err?.status || 502).json({ error: message, code: kind });
    }
  } catch (err) {
    return next(err);
  }
});


// ── The AI capability, which is NOT a provider capability ────────────────────
//
// It branches BEFORE the Drive token lookup because there is nothing to look up: no provider
// connection, no OAuth scope. What it spends is the GRANT OWNER's Morpheus credits, through the same
// `invokeAI` every other call uses — so it is metered, refunded on failure and recorded in
// usage_events exactly like the rest of the platform, with no second ledger to keep honest.
//
// Bounded on both ends deliberately. The prompt is capped before it reaches a model, the answer is
// capped by maxTokens, and the role is `draft` (flash @ 0.4) because this is an app's mechanical
// generation, not Morpheus's persona — an app's AI call must not inherit pro @ 0.7 by saying nothing.
//
// The no-credits case gets its own code (402 / INSUFFICIENT_CREDITS) rather than a provider error,
// because an app's user has to be told "this app needs Morpheus credits" and not handed whatever
// the gateway said. Rob's words, 2026-09-28: there is no free path, so this must be sayable plainly.
const AI_PROMPT_MAX_CHARS = 4000;
const AI_MAX_TOKENS = 2000;

async function handleAiGenerate(req, res, owner) {
  const action = String(req.body?.action ?? '');
  if (action !== 'generate') {
    return res.status(400).json({ error: "ai_generate supports the action 'generate'.", code: 'UNSUPPORTED_ACTION' });
  }

  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required.', code: 'PROMPT_REQUIRED' });
  if (prompt.length > AI_PROMPT_MAX_CHARS) {
    return res.status(400).json({ error: `prompt is too long (${AI_PROMPT_MAX_CHARS} characters max).`, code: 'PROMPT_TOO_LONG' });
  }

  try {
    const { result, provider, model, usage } = await invokeAI({
      userId: owner.id,
      prompt,
      role: 'draft',
      maxTokens: AI_MAX_TOKENS,
      task: 'app_ai_generate',
    });
    return res.json({
      ok: true,
      capability: 'ai_generate',
      appId: req.body?.appId,
      text: String(result ?? ''),
      provider,
      model,
      // Which account paid, said out loud. The app's operator is spending their own credits and
      // should be able to see that from the response rather than infer it.
      spentBy: 'morpheus-credits',
      usage: { input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null },
    });
  } catch (err) {
    if (err?.status === 402 || err?.name === 'InsufficientCreditsError') {
      return res.status(402).json({
        error: 'This app needs Morpheus credits to use AI, and the account has run out. Top up in Morpheus → Settings → Usage.',
        code: 'INSUFFICIENT_CREDITS',
      });
    }
    return res.status(502).json({ error: err?.message || 'The AI call failed.', code: 'AI_CALL_FAILED' });
  }
}

export default router;
