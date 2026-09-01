import { useState, useRef } from 'react';
import { Upload, Plus, Trash2, FileCode, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

function detectLanguage(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    html: 'html', css: 'css', json: 'json', py: 'python', java: 'java',
    go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
    php: 'php', swift: 'swift', kt: 'kotlin', sql: 'sql', sh: 'bash',
    yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown', txt: 'text'
  };
  return map[ext] || 'text';
}

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export default function ExternalSources({ projectId, externalFiles, onRefresh }) {
  const [showPaste, setShowPaste] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileUpload = async (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;
    setUploading(true);
    try {
      for (const file of selected) {
        if (file.size > MAX_FILE_SIZE) continue;
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        const preview = await file.slice(0, 10240).text();
        await base44.entities.ProjectFile.create({
          project_id: projectId,
          path: `external/${file.name}`,
          content: preview,
          file_url,
          language: detectLanguage(file.name),
        });
      }
      onRefresh();
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = async () => {
    if (!pasteName.trim() || !pasteContent.trim()) return;
    setSaving(true);
    try {
      const path = pasteName.startsWith('external/') ? pasteName : `external/${pasteName.replace(/^\/+/, '')}`;
      await base44.entities.ProjectFile.create({
        project_id: projectId,
        path,
        content: pasteContent,
        language: detectLanguage(pasteName),
      });
      setPasteName('');
      setPasteContent('');
      setShowPaste(false);
      onRefresh();
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (file) => {
    await base44.entities.ProjectFile.delete(file.id);
    onRefresh();
  };

  return (
    <div className="border border-primary/20 p-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="text-xs text-primary/75 uppercase shrink-0">// external sources ({externalFiles.length})</div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1 transition-colors disabled:opacity-30"
          >
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} UPLOAD
          </button>
          <button
            onClick={() => setShowPaste(!showPaste)}
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1 transition-colors"
          >
            <Plus size={12} /> PASTE
          </button>
        </div>
      </div>
      <p className="text-xs text-primary/65 mb-2">Add external apps, files, or programs to include in backend planning.</p>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileUpload}
        className="hidden"
        accept=".js,.ts,.jsx,.tsx,.html,.css,.json,.py,.java,.go,.rs,.c,.cpp,.cs,.rb,.php,.swift,.kt,.sql,.sh,.yml,.yaml,.xml,.md,.txt,.env"
      />
      {showPaste && (
        <div className="mb-3 space-y-2 border border-primary/20 p-2">
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
            rows={5}
            className="w-full bg-background text-primary border border-primary/30 px-2 py-1.5 text-xs outline-none placeholder:text-primary/20 font-mono resize-y"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handlePaste}
              disabled={saving || !pasteName.trim() || !pasteContent.trim()}
              className="text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1 disabled:opacity-30 font-bold"
            >
              ADD FILE
            </button>
            <button onClick={() => setShowPaste(false)} className="text-xs text-primary/60 hover:text-primary px-2 py-1">CANCEL</button>
          </div>
        </div>
      )}
      {externalFiles.length > 0 && (
        <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-matrix">
          {externalFiles.map(f => (
            <div key={f.id} className="flex items-center gap-2 text-xs border border-primary/10 px-2 py-1.5">
              <FileCode size={12} className="text-primary/60 shrink-0" />
              <span className="text-primary/80 truncate flex-1">{f.path.replace('external/', '')}</span>
              <button onClick={() => handleDelete(f)} className="text-primary/65 hover:text-red-500 shrink-0">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}