// EMBED tab — one-tap dock setup.
//
// Installing the plugin used to end with a person carrying a credential between
// two screens: mint an embed token in WEBSITE → EMBED, then paste it into
// Settings → Morpheus → Dock by hand. That is how a live token ends up in a chat
// transcript, and it is the step that goes wrong on a phone. The app already
// holds the token at the moment it is minted and already has a signed channel to
// the site, so this pushes it instead.
//
// It does NOT replace the manual route. A site with no Morpheus pairing — the
// plugin installed but never connected — still needs the snippet, so the copyable
// snippet stays exactly where it was.
//
// OWNER-ONLY, and deliberately not a widget scope. A dock token that could
// reconfigure the dock would be privilege escalation: the token the dock acts as
// is the same credential this endpoint writes, so a leaked embed token could
// install a dock pointed at an attacker's account. `scripts/verify-dock.mjs`
// asserts the exclusion by name in `WIDGET_SCOPE_FUNCTIONS`, because the failure
// is silent — the function would simply work.
import { prisma } from '../db.js';
import { getWpConnection, wpDock } from '../lib/wpPlugin.js';

/** The wording for a site whose plugin predates the route. */
const TOO_OLD = "This site's Morpheus plugin cannot be set up from here yet (it needs 0.8.2 or newer). Update it from the SETUP tab, or paste the token into Settings → Morpheus → Dock on the site.";

const ACTIONS = ['get', 'set'];

/**
 * The site's own verdict, re-shaped rather than trusted.
 *
 * `note` is the site's one-line reason and is '' when the tag will print. It is
 * what the panel shows instead of a generic failure, so it is passed through
 * verbatim — but the flags beside it are coerced, because this response is
 * external input like any other and a site running a modified build must not be
 * able to make the panel render something other than a boolean.
 */
function verdict(data, fallbackNote) {
  return {
    ok: data?.ok === true,
    enabled: data?.enabled === true,
    configured: data?.configured === true,
    note: typeof data?.note === 'string' && data.note ? data.note : (fallbackNote || ''),
  };
}

export default async function handler({ user, body }) {
  const { projectId, action, enabled, widgetToken } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ACTIONS.includes(action)) {
    throw Object.assign(new Error(`Unknown dock action: ${action}`), { status: 400 });
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });
  }

  // The token is only ever sent when switching the dock ON. Turning it off must
  // work without one, because the app does not keep the plaintext after minting.
  const data = {};
  if (action === 'set') {
    data.enabled = enabled !== false;
    if (data.enabled && typeof widgetToken === 'string' && widgetToken) {
      data.widget_token = widgetToken;
    }
  }

  const res = await wpDock(conn, action, data);

  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }
  // 404 = the route does not exist on this build; 400 unknown_action = the route
  // exists but not this action. Both mean the same thing to an operator, and both
  // are named, because WordPress's own "rest_no_route" explains nothing.
  if (res.status === 404 || (res.status === 400 && res.data?.error === 'unknown_action')) {
    throw Object.assign(new Error(TOO_OLD), { status: 409, code: 'DOCK_UNSUPPORTED' });
  }
  // A refusal is the SITE's decision — an invalid token, a bad host — and it
  // carries its own reason. Passing that through is the point: the operator sees
  // why the site said no instead of "something went wrong".
  if (res.status !== 200 || res.data?.ok !== true) {
    const v = verdict(res.data, res.data?.message || `The site answered HTTP ${res.status}.`);
    return { ...v, ok: false };
  }

  return verdict(res.data, '');
}
