// "What happens when I paste my site URL?" — answered before the operator is
// asked for anything else.
//
// The old SETUP panel showed four steps at once and let you attempt a connect
// with a secret you had not set yet, so the common failure ("Connection failed"
// with no explanation) could not distinguish a typo'd URL from a missing plugin
// from a plugin that is too old to pair. This probe does the looking, server
// side, because a browser cannot read a cross-origin WordPress REST response
// without CORS headers that WordPress does not send.
//
// It only reports; it never writes a connection.
import { normalizeSiteUrl, wpStatus } from '../lib/wpPlugin.js';
import { isNewer } from '../lib/version.js';

// The version that first accepts a pairing code (class-pairing.php).
const PAIRING_VERSION = '0.5.4';

/**
 * Which step the wizard should show, from facts rather than from the operator's
 * description of their own site.
 *
 * `step` is the whole contract with the UI:
 *   'install' — WordPress answered, the Morpheus plugin did not: show the
 *               install steps (with links to THIS domain)
 *   'update'  — plugin present but too old to pair: one-click update if the
 *               build can do it, manual otherwise
 *   'pair'    — ready: ask for the code from wp-admin
 *   'ready'   — already paired on the site AND we are connected: nothing to do
 *   'unreachable' — nothing answered at that URL
 */
export default async function handler({ user, body }) {
  const raw = String(body?.siteUrl || '').trim();
  const siteUrl = normalizeSiteUrl(raw);
  if (!siteUrl) {
    throw Object.assign(new Error('Enter your site address, for example yoursite.com'), { status: 400 });
  }

  const status = await wpStatus(siteUrl);

  // A login wall or a redirect loop are the two common real answers, and both
  // are visible in where the request ended up. Reporting "unreachable" for a
  // site that is plainly online sends the operator to check their spelling.
  const chain = status.redirects || [];
  // A redirect to the SAME address is the signature of a cookie wall: WordPress
  // (or a coming-soon plugin) sets a cookie and sends the client back to where
  // it came from, which a cookie-less API client can never satisfy. Seen for
  // real on a Playground site in auto-login mode.
  const repeats = chain.some((u, i) => chain.indexOf(u) !== i);
  const landedOnLogin = chain.some((u) => /wp-login\.php|\/login(\?|$)/i.test(u))
    || /wp-login\.php/i.test(String(status.finalUrl || ''))
    || repeats;

  if (landedOnLogin) {
    return {
      siteUrl,
      step: 'behind_login',
      reachable: true,
      login_url: status.finalUrl,
      redirects: chain,
      guidance: repeats
        ? 'Your site sends every request back to the same address, which is what a password-protected site or a "coming soon" mode does — it wants a login cookie Morpheus cannot hold. Turn that protection off and check again: the endpoint Morpheus calls only reports the plugin\'s version, so nothing private is exposed.'
        : 'Your site sent Morpheus to a login page, so it is either password-protected or in a "coming soon" mode. Morpheus talks to a public REST endpoint (/wp-json/morpheus/v1/status) — turn that protection off and check again.',
    };
  }

  if (status.status === 0) {
    return {
      siteUrl,
      step: 'unreachable',
      reachable: false,
      detail: status.error || 'no response',
      redirects: status.redirects || [],
      guidance: /too many redirects/.test(String(status.error))
        ? 'That address kept redirecting and never arrived — usually an http/https or www/non-www mismatch. Visit it in a browser and use the address it finally settles on.'
        // Morpheus assumes https, so a site that only serves plain http looks
        // like nothing is there. Say so rather than sending someone to check
        // their spelling when the spelling is fine.
        : /^www\.|^[^/]+$/i.test(raw)
          ? `Nothing answered at ${siteUrl}. Check the spelling and that the site is online — and if this site only serves http:// (some self-hosted and staging sites do), type it with http:// at the front.`
          : 'Nothing answered at that address. Check the spelling, and that the site is online.',
    };
  }

  const data = status.data;
  const isMorpheus = status.ok && data && data.plugin === 'morpheus';

  if (!isMorpheus) {
    // Is this WordPress at all? The REST discovery header is the reliable
    // signature — WordPress sends `Link: <…/wp-json/>; rel="https://api.w.org/"`
    // on every REST response, including the 404 for a route that is not there,
    // which is exactly the case for a site without the Morpheus plugin. The
    // first version of this guessed from the body instead and told real
    // WordPress sites they were "not a WordPress site Morpheus recognises".
    const apiLink = /rel="https:\/\/api\.w\.org\/"/i.test(String(status.link || ''));
    const looksWordPress = apiLink || !!(data && (data.namespaces || data.name));
    const isWordPress = status.ok ? looksWordPress : (apiLink || looksWordPress);
    return {
      siteUrl,
      step: 'install',
      reachable: true,
      is_wordpress: isWordPress,
      wordpress_evidence: apiLink ? 'rest-discovery-header' : (looksWordPress ? 'rest-index' : null),
      http_status: status.status,
      detail: status.ok ? 'WordPress answered, but not the Morpheus plugin' : `HTTP ${status.status}`,
      final_url: status.finalUrl || siteUrl,
      // The links the operator actually needs, built from their own domain so
      // there is nothing to translate or mistype on a phone.
      install_url: `${siteUrl}/wp-admin/plugin-install.php?tab=upload`,
      settings_url: `${siteUrl}/wp-admin/options-general.php?page=morpheus`,
      plugin_zip: 'https://morpheus.nz/morpheus-wordpress-plugin.zip',
      guidance: 'Install the Morpheus plugin on your site (one upload), then come back here. Your connection is not stored anywhere on Morpheus until you connect.',
    };
  }

  const version = String(data.version || '');
  const pairingAvailable = !!data?.pairing?.available;
  const sitePaired = !!data?.pairing?.paired;

  if (!pairingAvailable || isNewer(PAIRING_VERSION, version)) {
    const canSelfUpdate = !isNewer('0.5.3', version); // has the update channel
    return {
      siteUrl,
      step: 'update',
      reachable: true,
      is_wordpress: true,
      version,
      latest: null,
      self_update: canSelfUpdate,
      plugins_url: `${siteUrl}/wp-admin/plugins.php`,
      install_url: `${siteUrl}/wp-admin/plugin-install.php?tab=upload`,
      plugin_zip: 'https://morpheus.nz/morpheus-wordpress-plugin.zip',
      guidance: canSelfUpdate
        ? 'Your plugin is older than the pairing flow. Update it from your WordPress Plugins screen — one tap, nothing to download — then come back.'
        : 'Your plugin is older than the pairing flow, and too old to update itself. Download the zip and upload it once (Plugins → Add New → Upload Plugin → Replace current with uploaded); after that WordPress updates it for you.',
    };
  }

  return {
    siteUrl,
    step: 'pair',
    reachable: true,
    is_wordpress: true,
    version,
    site_paired: sitePaired,
    // Where the operator gets the code — a direct link saves them hunting for
    // the settings page, which is the part people get stuck on.
    settings_url: `${siteUrl}/wp-admin/options-general.php?page=morpheus`,
    guidance: sitePaired
      ? 'This site already has a secret set. Open Settings → Morpheus and either use the code shown there (it replaces the secret when you connect) or paste the existing secret instead.'
      : 'Open Settings → Morpheus on your site, copy the code it shows, and paste it below. It is good for 20 minutes and works once.',
  };
}
