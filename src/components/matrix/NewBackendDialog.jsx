import { useState, useRef } from 'react';
import { Server, X, Upload, Plus, Trash2, FileCode, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

function detectLanguage(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    html: 'html', css: 'css', json: 'json', py: 'python', java: 'java',
    go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
    php: 'php', swift: 'swift', kt: 'kotlin', sql: 'sql', sh: 'bash',
    yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown', txt: 'text', env: 'bash'
  };
  return map[ext] || 'text';
}

export default function NewBackendDialog({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const fileInputRef = useRef(null);

  if (!open) return null;

  const handleFileUpload = async (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;
    setUploading(true);
    try {
      const newFiles = [];
      for (const file of selected) {
        if (file.size > MAX_FILE_SIZE) continue;
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        const preview = await file.slice(0, 10240).text();
        newFiles.push({ path: file.name, content: preview, file_url, language: detectLanguage(file.name) });
      }
      setFiles(prev => [...prev, ...newFiles]);
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = () => {
    if (!pasteName.trim() || !pasteContent.trim()) return;
    setFiles(prev => [...prev, { path: pasteName.trim(), content: pasteContent, language: detectLanguage(pasteName) }]);
    setPasteName('');
    setPasteContent('');
    setShowPaste(false);
  };

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), description.trim(), files);
    setName('');
    setDescription('');
    setFiles([]);
    setShowPaste(false);
    setPasteName('');
    setPasteContent('');
  };

  const handleClose = () => {
    setName('');
    setDescription('');
    setFiles([]);
    setShowPaste(false);
    setPasteName('');
    setPasteContent('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={handleClose}>
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Server size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">NEW BACKEND CONSTRUCT</span>
          </div>
          <button onClick={handleClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-primary/50 uppercase mb-1 block">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-api"
              className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-primary/50 uppercase mb-1 block">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this backend do?"
              rows={3}
              className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20 resize-y"
            />
          </div>

          {/* File upload section */}
          <div>
            <label className="text-xs text-primary/50 uppercase mb-1 block">Source Files (optional)</label>
            <p className="text-xs text-ink/65 mb-2">Upload your existing app or files — Morpheus will analyze them to plan the backend.</p>
            <div className="flex items-center gap-1.5 mb-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1.5 transition-colors disabled:opacity-30"
              >
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} UPLOAD
              </button>
              <button
                onClick={() => setShowPaste(!showPaste)}
                className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1.5 transition-colors"
              >
                <Plus size={12} /> PASTE
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileUpload}
              className="hidden"
              accept=".js,.ts,.jsx,.tsx,.html,.css,.json,.py,.java,.go,.rs,.c,.cpp,.cs,.rb,.php,.swift,.kt,.sql,.sh,.yml,.yaml,.xml,.md,.txt,.env"
            />
            {showPaste && (
              <div className="mb-2 space-y-2 border border-primary/20 p-2">
                <input
                  value={pasteName}
                  onChange={e => setPasteName(e.target.value)}
                  placeholder="filename.js"
                  className="w-full bg-background text-primary border border-primary/30 px-2 py-1.5 text-xs outline-none placeholder:text-primary/20"
                />
                <textarea
                  value={pasteContent}
                  onChange={e => setPasteContent(e.target.value)}
                  placeholder="// paste code here..."
                  rows={4}
                  className="w-full bg-background text-primary border border-primary/30 px-2 py-1.5 text-xs outline-none placeholder:text-primary/20 font-mono resize-y"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePaste}
                    disabled={!pasteName.trim() || !pasteContent.trim()}
                    className="text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1 disabled:opacity-30 font-bold"
                  >
                    ADD FILE
                  </button>
                  <button onClick={() => setShowPaste(false)} className="text-xs text-primary/60 hover:text-primary px-2 py-1">CANCEL</button>
                </div>
              </div>
            )}
            {files.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-matrix">
                {files.map((f, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs border border-primary/10 px-2 py-1.5">
                    <FileCode size={12} className="text-primary/60 shrink-0" />
                    <span className="text-ink/80 truncate flex-1">{f.path}</span>
                    <button onClick={() => removeFile(idx)} className="text-primary/65 hover:text-red-500 shrink-0">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            className="w-full text-primary border border-primary hover:bg-primary hover:text-black transition-colors py-2 text-sm font-bold disabled:opacity-30"
          >
            CREATE BACKEND
          </button>
        </div>
      </div>
    </div>
  );
}