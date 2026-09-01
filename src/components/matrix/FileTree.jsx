import { File, FileCode, FileText, FileJson, Package } from 'lucide-react';

function fileIcon(path) {
  if (path.startsWith('_compiled/')) return Package;
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'sh'].includes(ext)) return FileCode;
  if (ext === 'json') return FileJson;
  if (['md', 'txt'].includes(ext)) return FileText;
  return File;
}

export default function FileTree({ files, selectedFile, onSelect }) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <div className="border-b border-primary/20 max-h-[40%] overflow-y-auto scrollbar-matrix">
      <div className="px-3 py-2 text-xs text-primary/75 uppercase tracking-wider sticky top-0 bg-background">// files</div>
      {sorted.length === 0 && <div className="px-3 py-2 text-primary/65 text-sm italic">No files yet. Ask Morpheus to build something.</div>}
      {sorted.map(f => {
        const Icon = fileIcon(f.path);
        const active = selectedFile?.id === f.id;
        const isCompiled = f.path.startsWith('_compiled/');
        return (
          <button key={f.id} onClick={() => onSelect(f)} className={`w-full text-left flex items-center gap-2 px-3 py-2 md:py-1.5 min-h-[44px] md:min-h-0 text-sm ${active ? 'bg-primary/10 text-primary' : isCompiled ? 'text-primary hover:bg-primary/5' : 'text-primary/60 hover:text-primary hover:bg-primary/5'}`}>
            <Icon size={14} className={`shrink-0 ${isCompiled ? 'text-primary neon-glow' : ''}`} />
            <span className="truncate">{f.path}</span>
            {isCompiled && <span className="ml-auto text-[9px] text-primary/75 uppercase tracking-wider shrink-0">pkg</span>}
          </button>
        );
      })}
    </div>
  );
}