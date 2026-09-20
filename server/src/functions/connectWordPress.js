// Connect a project to a Morpheus WordPress plugin on the operator's own
// site. Verifies the site is reachable and the plugin is installed, then
// stores { site URL, signing secret } (secret encrypted at rest).
//
// TWO WAYS IN, and the first is the one people should use:
//
//   pairingCode  — the code from the site's Settings → Morpheus screen. The
//                  plugin generates the secret and returns it, so nothing is
//                  invented or retyped. Single use, 20 minutes.
//   webhookSecret — the original path: a secret set by hand on both sides.
//                  Kept for existing installs and for sites whose plugin is too
//                  old to pair, so nobody is locked out by this change.
import { prisma } from '../db.js';
import { normalizeSiteUrl, wpStatus, wpPair, wpVerifySecret, upsertWpConnection, isMissingPluginTable } from '../lib/wpPlugin.js';

export default async function handler({ user, body }) {
  const { projectId, siteUrl: rawUrl, webhookSecret } = body || {};
  const pairingCode = typeof body?.pairingCode === 'string' ? body.pairingCode.trim() : '';
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const siteUrl = normalizeSiteUrl(rawUrl);
  if (!siteUrl) throw Object.assign(new Error('Enter the site URL, e.g. https://valiantmusic.com.au'), { status: 400 });

  const status = await wpStatus(siteUrl);
  if (!status.ok || !status.data || status.data.plugin !== 'morpheus') {
    throw Object.assign(
      new Error(status.error
        ? `Could not reach ${siteUrl}/wp-json/morpheus/v1/status — ${status.error}`
        : `${siteUrl} responded (${status.status}) but the Morpheus plugin isn't answering there. Install and activate it first.`),
      { status: 502 },
    );
  }

  let secret = typeof webhookSecret === 'string' ? webhookSecret.trim() : '';
  let paired = false;

  if (!secret) {
    if (!pairingCode) {
      throw Object.assign(new Error('Enter the code from Settings → Morpheus on your site.'), { status: 400 });
    }
    if (!status.data?.pairing?.available) {
      throw Object.assign(new Error('That site\'s Morpheus plugin is too old to pair. Update it from your WordPress Plugins screen, or use the shared secret instead.'), { status: 409 });
    }

    const pair = await wpPair(siteUrl, pairingCode);
    if (pair.status === 0) {
      throw Object.assign(new Error(`Could not reach ${siteUrl} to pair — ${pair.error || 'no response'}`), { status: 502 });
    }
    if (!pair.ok || !pair.data?.ok || !pair.data?.secret) {
      // The plugin's own message is the useful one ("expired", "not right"),
      // so it is passed through rather than replaced with a generic failure.
      throw Object.assign(
        new Error(pair.data?.message || pair.data?.error || `Pairing failed (HTTP ${pair.status}).`),
        { status: pair.status === 429 ? 429 : 403 },
      );
    }
    secret = String(pair.data.secret);
    paired = true;
  }

  if (secret.length < 12) throw Object.assign(new Error('The signing secret must be at least 12 characters — set the same value in the plugin.'), { status: 400 });

  // PROVE THE SECRET BEFORE STORING IT, with a real signed request. A pairing
  // code that did not take, or a hand-typed secret with a typo, otherwise fails
  // later on the operator's first real action — where the error looks like a
  // plugin problem instead of a connection problem.
  const proof = await wpVerifySecret({ siteUrl, secret });
  if (!proof.ok) {
    if (proof.reason === 'unreachable') {
      throw Object.assign(new Error(`${siteUrl} stopped answering while connecting — try again.`), { status: 502 });
    }
    throw Object.assign(
      new Error('That secret does not match the one set on your site, so the connection was not saved. Use the code from Settings → Morpheus (or check the shared secret on both sides).'),
      { status: 403 },
    );
  }

  try {
    await upsertWpConnection(projectId, user.id, {
      siteUrl,
      secret,
      repo: status.data?.deploy?.repo || null,
      meta: { connectedAt: new Date().toISOString(), version: status.data.version, store: status.data.store, paired },
    });
  } catch (err) {
    if (isMissingPluginTable(err)) {
      throw Object.assign(new Error('Plugin connections table is not migrated yet — run add-plugin-connections.sql.'), { status: 503 });
    }
    throw err;
  }

  return {
    connected: true,
    paired,
    siteUrl,
    version: status.data.version,
    store: status.data.store,
    deploy: status.data.deploy,
  };
}
