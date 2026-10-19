import { Download, Package } from 'lucide-react';
import SyntaxHighlighter from './SyntaxHighlighter';

export default function FileViewer({ file }) {
  if (!file) {
    return <div className="flex-1 flex items-center justify-center text-ink text-sm italic">// select a file to inspect</div>;
  }

  // Compiled artifact — show a download card instead of trying to render binary
  if (file.file_url) {
    const fileName = file.path.split('/').pop();
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-primary/20 text-xs text-ink-strong truncate">{file.path}</div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="border border-primary/40 bg-primary/5 p-6 max-w-sm w-full text-center space-y-4">
            <Package size={48} className="mx-auto text-primary neon-glow" />
            <div>
              <div className="text-primary font-display tracking-wider neon-glow">{fileName}</div>
              <div className="text-xs text-primary/50 mt-1">COMPILED ARTIFACT</div>
            </div>
            <a href={file.file_url} download={fileName} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 w-full py-3 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold">
              <Download size={16} /> DOWNLOAD
            </a>
            <pre className="text-[10px] text-ink-max text-left whitespace-pre-wrap">{file.content || ''}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-primary/20 text-xs text-ink-strong truncate">{file.path}</div>
      <div className="flex-1 overflow-auto scrollbar-matrix">
        <pre className="text-sm p-3 leading-relaxed">
          <SyntaxHighlighter content={file.content || ''} language={file.language || 'text'} filePath={file.path} />
        </pre>
      </div>
    </div>
  );
}