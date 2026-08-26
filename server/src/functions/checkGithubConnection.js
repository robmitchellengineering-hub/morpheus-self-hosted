// Ported from base44/functions/checkGithubConnection/entry.ts
// This is the worked example in PORTING_GUIDE.md — ported verbatim from there.
import { getGithubConnection } from '../lib/github.js';

export default async function handler({ user }) {
  const connection = await getGithubConnection(user.id);
  return { connected: !!connection, login: connection?.login || null };
}
