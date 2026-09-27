// What to tell the operator when a Google connection cannot be renewed.
//
// Why this is a module (2026-09-28): the deck's Google and the platform's Drive connection hit the
// same failure and said two different things about it. `checkDeckGoogleConnection` live-probes and
// reported "not connected", while the operation itself used the token it had just failed to renew
// and surfaced Google's own words — Rob saw "Doc create failed: Request had invalid authentication
// credentials. Expected OAuth 2 access token, login cookie or other valid authentication
// credential." That sentence names no cause and no action, and it arrived in a shop tool.
//
// The measured cause is not exotic: a refresh token issued by an OAuth app whose consent screen is
// in TESTING status expires after SEVEN DAYS. This connection was created 2026-09-18 04:17 and its
// access token expired 2026-09-25 04:17, and every refresh attempt since then was refused with
// "Token has been expired or revoked." Reconnecting fixes it for another seven days; publishing the
// consent screen (or setting the user type to Internal in the same Workspace) is what stops it
// recurring — that part is a Google Cloud console decision, not code.
//
// Pure and dependency-free so scripts/verify-google-reconnect.mjs can assert the wording.
export const GOOGLE_REFRESH_REASONS = ['revoked', 'not_configured', 'network'];

export function reconnectMessage(reason, where) {
  if (reason === 'not_configured') {
    return `Google cannot be refreshed: this server has no Google client credentials configured. That is a deployment problem, not something you can fix from ${where}.`;
  }
  if (reason === 'network') {
    return `Google could not be reached to refresh the connection — this is usually temporary, so try again in a moment before reconnecting.`;
  }
  return `Google access has expired or been revoked — reconnect Google in ${where}, then try again. (A refresh token lasts 7 days while the Google app is still in "Testing"; reconnecting works now but will lapse again unless the app is published.)`;
}

// Google answers a dead refresh token with `invalid_grant` and the description "Token has been
// expired or revoked." — classified in ONE place so both connections report it identically.
export function classifyRefreshFailure(data) {
  const code = String(data?.error || '');
  const description = String(data?.error_description || '');
  if (code === 'invalid_grant' || /expired or revoked|invalid_grant/i.test(description)) return 'revoked';
  return 'network';
}
