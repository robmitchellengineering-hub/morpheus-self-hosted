// What to tell the operator when a GitHub connection cannot be renewed.
//
// WHY THIS EXISTS (2026-09-28). `getGithubConnection` refreshed an expiring GitHub token, and when
// the refresh failed it FELL THROUGH and handed back the access token it had just failed to renew —
// with a comment defending it ("the caller's own GitHub API call will surface a clear error"). That
// is the exact defect fixed for Google the same day: a credential KNOWN to be dead must not be tried
// anyway. The difference is only who writes the error the user sees — GitHub's own 401 text, deep
// inside a compile or a push, naming no cause and no action, instead of "reconnect GitHub".
//
// The three outcomes are not the same problem and must not share a sentence:
//   revoked        — the grant is gone (the refresh token expired or was revoked). The operator can
//                    fix this by reconnecting, and only by reconnecting.
//   not_configured — this server has no GitHub client credentials, so no refresh is possible at all.
//                    A deployment problem; telling the operator to reconnect would waste their time.
//   network        — we could not reach GitHub. Usually transient, and the one case where falling
//                    through to the stored token is right: a blip must not lock anyone out.
//
// Pure and dependency-free so scripts/verify-github-reconnect.mjs can assert the wording and the
// classification without a database or a network.
export const GITHUB_REFRESH_REASONS = ['revoked', 'not_configured', 'network'];

export function reconnectMessage(reason, where = 'Morpheus Settings → Connections → GitHub') {
  if (reason === 'not_configured') {
    return `GitHub cannot be refreshed: this server has no GitHub client credentials configured. That is a deployment problem, not something you can fix from ${where}.`;
  }
  if (reason === 'network') {
    return 'GitHub could not be reached to refresh the connection — this is usually temporary, so try again in a moment before reconnecting.';
  }
  return `GitHub access has expired or been revoked — reconnect GitHub in ${where}, then try again.`;
}

/**
 * Which kind of failure is this? GitHub answers a dead refresh token with an OAuth error code
 * (`bad_refresh_token`, `invalid_grant`, …). Classified in ONE place so every caller reports it
 * identically, and deliberately conservative in the operator's favour: an error code we do not
 * recognise is treated as OUR problem (network), never as "your connection is dead" — the wrong
 * direction here tells someone to redo work that was never broken.
 */
export function classifyRefreshFailure(data) {
  const code = String(data?.error || '');
  if (!code) return 'network';
  if (code === 'incorrect_client_credentials') return 'not_configured';
  const description = String(data?.error_description || '');
  if (code === 'bad_refresh_token' || code === 'invalid_grant' || /expired|revoked|invalid/i.test(description)) {
    return 'revoked';
  }
  return 'network';
}
