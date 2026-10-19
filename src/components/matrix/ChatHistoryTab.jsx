import { useState, useEffect, useCallback } from 'react';
import { Search, X, Copy, Check, User as UserIcon, Bot, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Searchable, perpetual chat history for a construct. Loads every ChatMessage
// ever saved to the project and lets the operator filter by text — every match
// is highlighted in-context so earlier decisions and requirements are findable
// no matter how long the project grows.

function MatchText({ content, query }) {
  if (!query) return <span>{content}</span>;
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx < 0) return <span>{content}</span>;
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 80);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return (
    <span>
      {prefix}{content.slice(start, idx)}
      <mark className="bg-primary/30 text-primary rounded-sm px-0.5">{content.slice(idx, idx + query.length)}</mark>
      {content.slice(idx + query.length, end)}{suffix}
    </span>
  );
}

export default function ChatHistoryTab({ project }) {
  const [all, setAll] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    try {
      // Descending + reverse, not ascending + limit — an ascending sort with
      // a cap fetches the OLDEST N rows once a project passes 5000 total
      // messages, silently dropping recent history from "searchable" full
      // history. See useWorkspace.js's loadMessages for the same fix.
      const data = await base44.entities.ChatMessage.filter({ project_id: project.id }, '-created_date', 5000);
      setAll(data.reverse());
    } catch (e) {
      console.error('Failed to load chat history:', e);
    } finally {
      setLoading(false);
    }
  }, [project?.id]);

  useEffect(() => { load(); }, [load]);

  const q = query.trim().toLowerCase();
  const filtered = q ? all.filter(m => m.content.toLowerCase().includes(q)) : all;

  const copy = (m) => {
    navigator.clipboard.writeText(`[${m.role === 'user' ? 'Operator' : 'Morpheus'}] ${m.content}`);
    setCopiedId(m.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-primary/10 shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-primary/50" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="search all chat history…"
            className="w-full bg-background text-ink border border-primary/30 pl-8 pr-8 py-2 text-sm outline-none placeholder:text-ink"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary">
              <X size={14} />
            </button>
          )}
        </div>
        <span className="text-xs text-ink-strong shrink-0 tabular-nums">
          {q ? `${filtered.length}/${all.length}` : `${all.length} msgs`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-matrix">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-primary/60" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-ink italic text-sm p-4">
            {q ? `No messages match "${query}".` : 'No chat history yet. Start building to populate the record.'}
          </p>
        ) : (
          <div className="divide-y divide-primary/10">
            {filtered.map(m => {
              const isUser = m.role === 'user';
              const isExpanded = expandedId === m.id;
              const Icon = isUser ? UserIcon : Bot;
              return (
                <div key={m.id} className="p-3 hover:bg-primary/5 transition-colors group">
                  <div className="flex items-start gap-2">
                    <Icon size={14} className={`mt-0.5 shrink-0 ${isUser ? 'text-[#39ff14]/80' : 'text-primary'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-xs font-bold tracking-wider ${isUser ? 'text-[#39ff14]/80' : 'text-primary'}`}>
                            {isUser ? 'OPERATOR' : 'MORPHEUS'}
                          </span>
                          <span className="text-ink-strong text-xs">{new Date(m.created_date).toLocaleString()}</span>
                        </div>
                        <button onClick={() => copy(m)} className="text-primary/65 hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0" title="Copy message">
                          {copiedId === m.id ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
                        </button>
                      </div>
                      <p
                        className={`text-ink-strong text-xs mt-1 font-mono whitespace-pre-wrap break-words ${!isExpanded && q ? 'max-h-20 overflow-hidden' : ''}`}
                        onClick={() => q && setExpandedId(isExpanded ? null : m.id)}
                      >
                        <MatchText content={m.content} query={q} />
                      </p>
                      {q && m.content.length > 200 && (
                        <button onClick={() => setExpandedId(isExpanded ? null : m.id)} className="text-primary/50 hover:text-primary text-xs mt-1">
                          {isExpanded ? '← collapse' : 'expand →'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}