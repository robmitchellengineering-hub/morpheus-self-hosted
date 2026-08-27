// Ported from base44/functions/checkGithubConnection/entry.ts
//
// The original does a LIVE `GET /user` call to GitHub on every check and
// only reports connected:true if that call actually succeeds, so a revoked
// or otherwise-dead token is caught immediately. An earlier pass here
// (following PORTING_GUIDE.md's worked example too literally) simplified
// this to just checking whether a GithubConnection row exists in our own
// DB — which never verifies the token still works. That's a real
// regression: if a user revokes Morpheus's GitHub OAuth access (or a token
// dies for a reason our own expires_at tracking doesn't catch), Settings
// keeps showing "GitHub Connected ✓" until the user actually tries to push
// and hits a 401 — the exact class of confusing, silent-until-it-breaks
// state this connection has already caused problems around this session.
// Restored to match the original: probe GitHub live, not just our DB.
import { getGithubConnection, ghHeaders, ghJson } from '../lib/github.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user }) {
  const connection = await getGithubConnection(user.id);
  if (!connection?.token) return { connected: false, login: null };

  try {
    const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(connection.token) });
    if (!res.ok) return { connected: false, login: null };
    const ghUser = await ghJson(res);
    return { connected: true, login: ghUser.login || connection.login };
  } catch (error) {
    return { connected: false, login: null, error: error.message };
  }
}
