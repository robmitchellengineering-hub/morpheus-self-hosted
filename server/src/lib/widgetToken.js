// Embeddable-widget access tokens. A `wgt_<hex>` token lets a slim Morpheus
// surface embedded on the owner's own site act AS the owner, but scoped to
// one project and a fixed set of actions. Only the SHA-256 is stored; the
// full token is shown once. See the "Self-Dev as a Plugin" scope doc.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { hashToken } from './tokenHash.js';

export const WIDGET_TOKEN_PREFIX = 'wgt_';
export const DEFAULT_SCOPES = ['chat', 'deploy', 'store'];

// Callable with any valid widget token, whatever its scopes — the surface
// needs these to bootstrap.
export const WIDGET_ALWAYS = ['getWidgetContext'];

// The functions a widget token is allowed to call, keyed by scope.
// Anything not listed (and not in WIDGET_ALWAYS) is owner-session-only.
export const WIDGET_SCOPE_FUNCTIONS = {
  chat: ['chatWithMorpheus', 'getChatHistory', 'getProjectFiles', 'getSelfDevFeatures', 'repoFiles'],
  // The site-operations scope. siteHealth is the read-only half of site
  // maintenance (it reports WordPress's own Site Health verdicts plus the
  // update, auto-update and host-capability picture). It belongs here rather
  // than in a new `health` scope because this scope already means "operate this
  // site" — it holds wordPressDeploy, which writes files to the site — and a
  // new scope would silently withhold Health from every existing dock token for
  // no gain in safety. The moment a fix/apply action exists it lands under the
  // same reasoning and gets its own review.
  deploy: ['wordPressDeploy', 'siteHealth'],
  store: ['getWordPressStore', 'wordPressStoreAction', 'generateProductCopy', 'analyzeProductPhoto'],
  // SEO is its own scope rather than part of `store`: an embed that only runs
  // the shop shouldn't also be able to rewrite every page's search metadata.
  // getWordPressStore is needed here because the SEO surface reads the site
  // context through it before the seo endpoint is called.
  //
  // searchConsoleAction is READ-ONLY on Google's side — it returns the account's
  // own search performance and can select which property to read.
  //
  // createSitePost is the ONE write, and it is a narrow function rather than
  // wordPressStoreAction for a reason: the SEO tab's POST flow saves its draft
  // through the store action, which lives in the `store` scope, so an SEO-only
  // embed composed a post and then got 403 at the final click. Adding the whole
  // store dispatcher here would have granted `delete_product` and `delete_page`
  // to an SEO embed; createSitePost performs exactly one plugin action and forces
  // status=draft. See server/src/functions/createSitePost.js.
  seo: [
    'getWordPressStore', 'wordPressSeoAction', 'generateSeoMeta', 'generateBlogPost',
    'suggestInternalLinks', 'researchKeywords', 'searchConsoleAction', 'createSitePost',
  ],
  // Traffic is its own scope rather than part of `seo`: submitting URLs to a
  // search engine is an outward action on the operator's live site, and an embed
  // that only manages metadata should not be able to do it.
  //
  // TWO functions, because the surface now calls two, and the list is asserted
  // against the surface's actual invokes by verify-traffic.mjs so it cannot drift:
  //   * trafficAction  — the IndexNow dispatcher (status | ledger | backfill | settings)
  //     and the tab invokes nothing else for it;
  //   * wordPressRedirects — the redirect rules and the 404 log, added 2026-10-08.
  //
  // ⚠️ THAT SECOND ONE IS A DELIBERATE WIDENING OF AN EXISTING SCOPE, and it is the
  // kind this file's own note asks to be reviewed rather than assumed: a traffic
  // token can now change how the site ANSWERS a URL, not just what it tells an index
  // about one. It belongs here because the scope already means "this site's search
  // presence", and a redirect rule is the other half of exactly that — keeping a URL
  // that search engines already know about from becoming a dead end. It is still
  // scoped to the operator's own site, and the plugin refuses the rules that could
  // lock them out. Anything that writes FILES or applies updates stays out.
  //
  // getWordPressStore is deliberately NOT here — unlike the SEO surface, which reads
  // the site's context before it can write, this tab needs no store state, and a
  // scope entry nothing invokes is privilege handed out for free.
  traffic: ['trafficAction', 'wordPressRedirects'],
};

// DELIBERATELY ABSENT FROM EVERY SCOPE ABOVE: dockAction.
//
// A dock token is the credential the dock ACTS AS. dockAction writes the token
// the site's dock will use — so a token that could call it could point the site
// at a different account, which is privilege escalation with an extra step. It is
// owner-session-only like every other function, and verify-dock.mjs asserts the
// exclusion by name here, because this failure is silent: the call would simply
// work.

export function isMissingWidgetTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021' || err?.code === 'P2022'
    || /relation\s+"?widget_tokens"?\s+does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|findFirst|create|update|delete|updateMany)/i.test(m);
}

// 2026-09-28: the hash moved to lib/tokenHash.js, shared with the per-app
// capability grants (lib/appCapability.js) — one hashing routine, not a third
// copy of the same line. Same value, same column.
const hash = hashToken;

// Create a token for a project the caller owns. Returns { token } (the full
// secret, shown once) plus the stored row's public fields.
export async function createWidgetToken(projectId, userId, { label, scopes } = {}) {
  const secret = WIDGET_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const clean = (Array.isArray(scopes) ? scopes : DEFAULT_SCOPES)
    .filter((s) => Object.prototype.hasOwnProperty.call(WIDGET_SCOPE_FUNCTIONS, s));
  const row = await prisma.widgetToken.create({
    data: {
      created_by_id: userId,
      project_id: projectId,
      token_prefix: secret.slice(0, WIDGET_TOKEN_PREFIX.length + 8),
      token_hash: hash(secret),
      label: label ? String(label).slice(0, 80) : null,
      scopes: (clean.length ? clean : DEFAULT_SCOPES).join(','),
    },
  });
  return { token: secret, id: row.id, prefix: row.token_prefix, scopes: row.scopes.split(','), label: row.label, created_date: row.created_date };
}

export async function listWidgetTokens(projectId, userId) {
  try {
    const rows = await prisma.widgetToken.findMany({
      where: { project_id: projectId, created_by_id: userId },
      orderBy: { created_date: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id, prefix: r.token_prefix, label: r.label,
      scopes: r.scopes.split(','), revoked: r.revoked,
      last_used_at: r.last_used_at, created_date: r.created_date,
    }));
  } catch (err) {
    if (isMissingWidgetTable(err)) return [];
    throw err;
  }
}

/**
 * Change an existing token's scopes, IN PLACE.
 *
 * The token string is deliberately not reissued: it is already pasted into a
 * snippet on the owner's site, so reissuing would mean a new token AND a new
 * snippet — which is exactly the friction that made "the SEO page never appears"
 * a site-editing job rather than a tick box. Same secret, new scopes.
 *
 * Two things this must not do, and does not:
 *
 *   * hand out a scope that does not exist — the list is filtered against
 *     WIDGET_SCOPE_FUNCTIONS, so an unknown name is dropped rather than stored;
 *   * revive a revoked token — revoked rows are excluded, so editing scopes
 *     cannot quietly bring a credential back to life.
 *
 * A widget token cannot reach this at all: the function is not in any scope's
 * allow-list, so `widgetMayCall` refuses it. That is the point — a token must
 * never be able to widen its own permissions.
 */
export async function updateWidgetTokenScopes(tokenId, projectId, userId, scopes) {
  const clean = (Array.isArray(scopes) ? scopes : [])
    .filter((s) => Object.prototype.hasOwnProperty.call(WIDGET_SCOPE_FUNCTIONS, s));
  if (!clean.length) {
    throw Object.assign(new Error('Pick at least one scope.'), { status: 400, code: 'NO_SCOPES' });
  }
  const res = await prisma.widgetToken.updateMany({
    where: { id: tokenId, project_id: projectId, created_by_id: userId, revoked: false },
    data: { scopes: clean.join(',') },
  });
  if (!res.count) {
    throw Object.assign(new Error("That token is not one of this project's active tokens."), { status: 404, code: 'NO_SUCH_TOKEN' });
  }
  return { id: tokenId, scopes: clean };
}

export async function revokeWidgetToken(tokenId, projectId, userId) {
  await prisma.widgetToken.updateMany({
    where: { id: tokenId, project_id: projectId, created_by_id: userId },
    data: { revoked: true },
  });
  return { revoked: true };
}

// Resolve a raw wgt_ token → { user, projectId, scopes, tokenId } or null.
// Bumps last_used_at (fire-and-forget). Called from optionalAuth.
export async function resolveWidgetToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(WIDGET_TOKEN_PREFIX)) return null;
  try {
    const row = await prisma.widgetToken.findUnique({ where: { token_hash: hash(raw) } });
    if (!row || row.revoked) return null;
    const user = await prisma.user.findUnique({ where: { id: row.created_by_id } });
    if (!user) return null;
    prisma.widgetToken.update({ where: { id: row.id }, data: { last_used_at: new Date() } }).catch(() => {});
    return { user, projectId: row.project_id, scopes: row.scopes.split(','), tokenId: row.id };
  } catch (err) {
    if (isMissingWidgetTable(err)) return null;
    throw err;
  }
}

// Is `functionName` callable with these widget scopes?
export function widgetMayCall(scopes, functionName) {
  if (WIDGET_ALWAYS.includes(functionName)) return true;
  return (scopes || []).some((s) => (WIDGET_SCOPE_FUNCTIONS[s] || []).includes(functionName));
}
