import { useState } from 'react';
import { File, FileCode, FileText, FileJson, Package, Search, X } from 'lucide-react';

function fileIcon(path) {
  if (path.startsWith('_compiled/')) return Package;
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'sh'].includes(ext)) return FileCode;
  if (ext === 'json') return FileJson;
  if (['md', 'txt'].includes(ext)) return FileText;
  return File;
}

// contextPaths/onToggleContext are optional, only passed by SelfDev.jsx. When
// present, each row gets a checkbox letting the operator pin more than one
// file's full content into the AI's context for a turn — see
// chatWithMorpheus.js's buildSelfDevContext()/focusPaths, which previously
// could only ever see the single currently-open file, blocking any change
// that touched more than one existing file at once. Ordinary Workspace.jsx
// usage (no props passed) is unaffected: no checkboxes render.
//
// The search box (2026-09-02) exists everywhere files.length is large enough
// to matter — self-dev syncs Morpheus's own ~350-file monorepo into one flat
// alphabetical list, so a specific file (e.g. src/pages/Landing.jsx) can
// require scrolling past ~100 unrelated files to reach; filtering by
// substring is a lot faster than scrolling to find it.
export default function FileTree({ files, selectedFile, onSelect, contextPaths, onToggleContext }) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const filtered = term ? sorted.filter((f) => f.path.toLowerCase().includes(term)) : sorted;
  const multiSelect = typeof onToggleContext === 'function';

  return (
    <div className="border-b border-primary/20 max-h-[40%] flex flex-col shrink-0 overflow-hidden">
      <div className="px-3 py-2 text-xs text-primary/75 uppercase tracking-wider shrink-0 bg-background">
        // files{files.length > 0 ? ` (${files.length})` : ''}
      </div>
      {files.length > 20 && (
        <div className="px-3 pb-2 shrink-0 relative">
          <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 text-primary/40 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter files…"
            className="w-full bg-transparent border border-primary/25 focus:border-primary/60 outline-none text-xs pl-6 pr-6 py-1 text-primary placeholder:text-primary/35"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/40 hover:text-primary" aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div className="overflow-y-auto scrollbar-matrix flex-1 min-h-0">
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-primary/65 text-sm italic">
            {files.length === 0 ? 'No files yet. Ask Morpheus to build something.' : 'No files match your search.'}
          </div>
        )}
        {filtered.map((f) => {
          const Icon = fileIcon(f.path);
          const active = selectedFile?.id === f.id;
          const isCompiled = f.path.startsWith('_compiled/');
          const inContext = multiSelect && contextPaths?.has(f.path);
          return (
            <div
              key={f.id}
              className={`w-full flex items-center gap-2 px-3 py-2 md:py-1.5 min-h-[44px] md:min-h-0 text-sm ${active ? 'bg-primary/10 text-primary' : isCompiled ? 'text-primary hover:bg-primary/5' : 'text-primary/60 hover:text-primary hover:bg-primary/5'}`}
            >
              {multiSelect && (
                <input
                  type="checkbox"
                  checked={!!inContext}
                  onChange={() => onToggleContext(f.path)}
                  title="Include this file's full content in the AI's context"
                  className="shrink-0 accent-current"
                />
              )}
              <button onClick={() => onSelect(f)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                <Icon size={14} className={`shrink-0 ${isCompiled ? 'text-primary neon-glow' : ''}`} />
                <span className="truncate">{f.path}</span>
                {isCompiled && <span className="ml-auto text-[9px] text-primary/75 uppercase tracking-wider shrink-0">pkg</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
