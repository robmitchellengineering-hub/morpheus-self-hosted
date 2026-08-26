import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { GITHUB_CONNECTOR_ID, getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { ghHeaders } from '../../shared/githubPush.ts';

const GH_API = 'https://api.github.com';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ connected: false, error: 'Unauthorized' }, { status: 200 });

    let accessToken: string;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch {
      return Response.json({ connected: false }, { status: 200 });
    }

    const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(accessToken) });
    if (!res.ok) return Response.json({ connected: false }, { status: 200 });
    const ghUser = await res.json();
    return Response.json({ connected: true, login: ghUser.login });
  } catch (error) {
    return Response.json({ connected: false, error: error.message }, { status: 200 });
  }
}