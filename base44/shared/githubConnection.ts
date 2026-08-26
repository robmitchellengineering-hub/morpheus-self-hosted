import { ghHeaders } from './githubPush.ts';

export const GITHUB_CONNECTOR_ID = '6a8785ad122b26c1461f0f6c';

const GH_API = 'https://api.github.com';

// Returns the current app user's GitHub access token, or throws a friendly
// error if they haven't connected their GitHub account yet.
export async function getAppUserGithubToken(base44: any): Promise<string> {
  const { accessToken } = await base44.asServiceRole.connectors.getCurrentAppUserConnection(GITHUB_CONNECTOR_ID);
  if (!accessToken) {
    throw new Error('GitHub not connected. Click CONNECT GITHUB to link your account.');
  }
  return accessToken;
}

// Returns the current app user's GitHub login name, or null if not connected.
export async function getAppUserGithubLogin(base44: any): Promise<string | null> {
  let accessToken: string;
  try {
    accessToken = await getAppUserGithubToken(base44);
  } catch {
    return null;
  }
  const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(accessToken) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.login || null;
}