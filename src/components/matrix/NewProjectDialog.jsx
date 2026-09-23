import { useState } from 'react';
import { X } from 'lucide-react';
import SheetSelect from '@/components/matrix/SheetSelect';

export default function NewProjectDialog({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [target, setTarget] = useState('source');
  if (!open) return null;

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), desc.trim(), target);
    setName('');
    setDesc('');
    setTarget('source');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md border border-primary/40 bg-background p-6 neon-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-primary font-display tracking-wider">INITIALIZE CONSTRUCT</h2>
          <button onClick={onClose} className="text-primary/50 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-primary/50 uppercase tracking-wider">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="my-construct" className="w-full mt-1 bg-transparent border border-primary/30 text-ink px-3 py-2 outline-none focus:border-primary text-sm" autoFocus />
          </div>
          <div>
            <label className="text-xs text-primary/50 uppercase tracking-wider">Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="This is the core vision of your app and helps Morpheus stay on track when coding" rows={3} className="w-full mt-1 bg-transparent border border-primary/30 text-ink px-3 py-2 outline-none focus:border-primary text-sm resize-none" />
          </div>
          <div>
            <label className="text-xs text-primary/50 uppercase tracking-wider">Compile Target</label>
            <SheetSelect
              value={target}
              onChange={setTarget}
              label="COMPILE TARGET"
              triggerClassName="w-full mt-1"
              options={[
                { value: 'source', label: 'Source code only' },
                { value: 'windows-exe', label: 'Windows .exe (build locally)' },
                { value: 'mac-app', label: 'macOS .app (build locally)' },
                { value: 'linux-binary', label: 'Linux binary (build locally)' },
                { value: 'android-apk', label: 'Android APK (build locally)' },
                { value: 'ios-app', label: 'iOS app (build locally)' },
                { value: 'python-package', label: 'Python package (build locally)' },
                { value: 'web-app', label: 'Web app (build locally)' },
                { value: 'rpi-distro', label: 'Raspberry Pi distro (build locally)' },
                { value: 'arduino-firmware', label: 'Arduino firmware (build locally)' },
              ]}
            />
          </div>
          <button onClick={handleCreate} disabled={!name.trim()} className="w-full py-2 border border-primary text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider">
            JACK IN
          </button>
        </div>
      </div>
    </div>
  );
}