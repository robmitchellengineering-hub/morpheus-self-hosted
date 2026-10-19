// Is the URL we just deployed actually readable by the public?
//
// WHY THIS EXISTS (2026-09-28). The first successful end-to-end run deployed a site, Netlify
// reported the deploy `ready`, Morpheus recorded it and said **YOUR SITE IS LIVE** — and the URL
// answered **HTTP 401 Login Redirect**. The site was behind Netlify's visitor access (Edge Access),
// which is a default on that account for new sites: Morpheus's own deploy previews answer 401 too,
// while the older production site answers 200. So the claim was false in the only sense a user
// cares about, and nothing in the pipeline could tell — the deploy genuinely succeeded.
//
// That is the same class as the six defects found by reading this chain: a failure that reads as a
// success. The difference is that this one can only be seen by asking the URL, which is what this
// classifier is for.
//
// Pure and import-free so scripts/verify-frontend-deploy.mjs can test every branch without a
// network.
export const SITE_ACCESS = ['public', 'login-required', 'blocked', 'unknown'];

/**
 * Classify what the deployed URL answered.
 *
 * `login-required` is deliberately narrow: it needs a 401/403 AND Netlify's own edge-access
 * signature in the body. A bare 401 is `blocked` — still not public, but we do not know why, and
 * telling someone to change a Netlify setting they may not have would send them somewhere useless.
 *
 * `unknown` is the honest default for anything else, including a probe that never got an answer.
 * It is NOT treated as failure: an unreachable probe must not read as a broken deploy.
 */
export function classifySiteAccess({ status, body } = {}) {
  const code = Number(status);
  if (!Number.isFinite(code) || code === 0) return { access: 'unknown', status: 0 };
  if (code === 401 || code === 403) {
    const text = String(body || '');
    // Netlify's wall is an HTML page whose script sends the visitor to app.netlify.com/edge-access.
    if (/edge-access|login redirect/i.test(text)) return { access: 'login-required', status: code };
    return { access: 'blocked', status: code };
  }
  if (code >= 200 && code < 400) return { access: 'public', status: code };
  return { access: 'unknown', status: code };
}

/** Is this a state where the public cannot see the site? Used by the UI and the record. */
export function isNotPublic(access) {
  return access === 'login-required' || access === 'blocked';
}
