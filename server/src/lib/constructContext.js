// Auto-fetched context for a named construct/project.
// Used by chatWithMorpheus.js (self-dev branch) to give the planner real
// history + compile attempts instead of re-deriving intent from one message.
import { prisma } from '../db.js';

// In-memory TTL cache for construct context resolutions (60s). Many
// self-dev turns ask about the same construct repeatedly in one session;
// this avoids re-querying chat + compile history for every planner call.
const contextCache = new Map();

function cacheGet(key) {
  const entry = contextCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt > Date.now()) return entry.value;
  contextCache.delete(key);
  return undefined;
}

function cacheSet(key, value, ttlMs = 60_000) {
  contextCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function getConstructContext(userId, nameHint) {
  if (!nameHint || typeof nameHint !== 'string' || !nameHint.trim()) return null;
  const trimmed = nameHint.trim();
  const cacheKey = `${userId}:${trimmed}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Case-insensitive contains match on project name, scoped to the caller.
  // Limit to 5 so a broad hint (e.g. the whole message) can't flood the
  // context with dozens of matches.
  const matches = await prisma.project.findMany({
    where: {
      created_by_id: userId,
      name: { contains: trimmed, mode: 'insensitive' },
    },
    orderBy: { created_date: 'desc' },
    take: 5,
  });

  if (matches.length === 0) {
    cacheSet(cacheKey, null);
    return null;
  }

  // Ambiguous — return candidate names so the operator can pick one.
  if (matches.length > 1) {
    const ambiguous = `Multiple matching constructs found:\n${matches
      .map((m) => `- ${m.name} (${m.status})${m.compile_target ? ` — ${m.compile_target}` : ''}`)
      .join('\n')}`;
    cacheSet(cacheKey, ambiguous);
    return ambiguous;
  }

  const project = matches[0];

  // Fetch recent chat transcript and compile-related usage records in parallel,
  // each wrapped separately so one failing query doesn't kill the whole context.
  const [chatMessages, usageRecords] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { project_id: project.id, created_by_id: userId },
      orderBy: { created_date: 'desc' },
      take: 20,
    }).catch((err) => {
      console.error('[constructContext] chat history query failed:', err.message);
      return [];
    }),
    prisma.usageRecord.findMany({
      where: {
        project_id: project.id,
        action_type: { in: ['compile', 'chat_build', 'autonomous_step'] },
        created_by_id: userId,
      },
      orderBy: { created_date: 'desc' },
      take: 10,
    }).catch((err) => {
      console.error('[constructContext] compile history query failed:', err.message);
      return [];
    }),
  ]);

  const truncate = (s, max = 2000) => {
    if (!s) return s || '';
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  };

  const chatLines = chatMessages.length
    ? chatMessages.map((c) => `${c.role === 'user' ? 'Operator' : 'Morpheus'}: ${truncate(c.content)}`).join('\n')
    : '(no chat history)';

  const usageLines = usageRecords.length
    ? usageRecords.map((u) => {
        let meta = {};
        try { meta = JSON.parse(u.metadata || '{}'); } catch { meta = {}; }
        const repo = meta.repo || meta.repos || meta.repository || '';
        const target = meta.target || '';
        return `- ${u.action_type} at ${u.created_date.toISOString()}${repo ? ` (repo: ${repo})` : ''}${target ? ` [${target}]` : ''}`;
      }).join('\n')
    : '(no compile attempts recorded)';

  const context = `## Construct Context (auto-fetched)\nProject: ${project.name}\nStatus: ${project.status}\nCompile target: ${project.compile_target || 'source'}\nGitHub repo: ${project.github_repo || '(none)'}\n\n### Chat history (most recent 20)\n${chatLines}\n\n### Compile attempts (most recent 10)\n${usageLines}`;
  cacheSet(cacheKey, context);
  return context;
}
