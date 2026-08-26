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
    <div className="border-b border-[#00ff41]/20 max-h-[40%] overflow-y-auto scrollbar-matrix">
      <div className="px-3 py-2 text-xs text-[#00ff41]/75 uppercase tracking-wider sticky top-0 bg-black">// files</div>
      {sorted.length === 0 && <div className="px-3 py-2 text-[#00ff41]/65 text-sm italic">No files yet. Ask Morpheus to build something.</div>}
      {sorted.map(f => {
        const Icon = fileIcon(f.path);
        const active = selectedFile?.id === f.id;
        const isCompiled = f.path.startsWith('_compiled/');
        return (
          <button key={f.id} onClick={() => onSelect(f)} className={`w-full text-left flex items-center gap-2 px-3 py-2 md:py-1.5 min-h-[44px] md:min-h-0 text-sm ${active ? 'bg-[#00ff41]/10 text-[#00ff41]' : isCompiled ? 'text-[#00ff41] hover:bg-[#00ff41]/5' : 'text-[#00ff41]/60 hover:text-[#00ff41] hover:bg-[#00ff41]/5'}`}>
            <Icon size={14} className={`shrink-0 ${isCompiled ? 'text-[#00ff41] neon-glow' : ''}`} />
            <span className="truncate">{f.path}</span>
            {isCompiled && <span className="ml-auto text-[9px] text-[#00ff41]/75 uppercase tracking-wider shrink-0">pkg</span>}
          </button>
        );
      })}
    </div>
  );
}