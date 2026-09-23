import { useState, useEffect } from 'react';
import { X, Wifi, Copy, Check, Loader2, Download } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Network transfer dialog for the Raspberry Pi distro target.
// After a build, the compiled morpheus-os.img.gz lives in _compiled/ with a
// public file_url. The user enters their SSH details here and Morpheus builds a
// ready-to-run command that, executed from their own machine, SSHes into the Pi
// and has it pull the image straight from storage and write it to the device.
//
// (True cloud-initiated SSH isn't possible on this platform — the function
// sandbox has no raw TCP / native SSH client — so the command runs from the
// user's machine, which is the part that already has SSH + network access.)

export default function NetworkFlashDialog({ open, onClose, projectId, target }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  // Default SSH user matches the first user each distro target bakes in.
  const [username, setUsername] = useState(target === 'linux-distro' ? 'morpheus' : 'pi');
  const [targetDevice, setTargetDevice] = useState('/dev/sda');
  const [fileUrl, setFileUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    base44.entities.ProjectFile.filter({ project_id: projectId })
      .then(files => {
        if (cancelled) return;
        const img = files.find(f => f.path.startsWith('_compiled/') && /\.img/i.test(f.path) && f.file_url);
        if (!img) {
          setError('No compiled .img found. Build the distro first.');
        } else {
          setFileUrl(img.file_url);
        }
      })
      .catch(e => !cancelled && setError(e.message || String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, projectId]);

  if (!open) return null;

  const ready = host && username && targetDevice && fileUrl;
  const command = ready
    ? `ssh -p ${port || 22} ${username}@${host} "curl -fsSL '${fileUrl}' | gunzip -c | sudo dd of=${targetDevice} bs=4M conv=fsync status=progress && sync"`
    : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const downloadScript = () => {
    const script = [
      '#!/bin/bash',
      '# Morpheus OS network transfer — run this from a machine with SSH access',
      '# to the target Pi. The Pi pulls the image from storage and writes itself.',
      'set -e',
      `HOST="${username}@${host}"`,
      `PORT="${port || 22}"`,
      `DEV="${targetDevice}"`,
      `URL="${fileUrl}"`,
      'echo "Transferring Morpheus OS to $HOST:$DEV ..."',
      `ssh -p "$PORT" "$HOST" "curl -fsSL '$URL' | gunzip -c | sudo dd of=$DEV bs=4M conv=fsync status=progress && sync"`,
      'echo "Done. Reboot $HOST to boot from $DEV."',
      ''
    ].join('\n');
    const blob = new Blob([script], { type: 'text/x-shellscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flash-network.sh';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <Wifi size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">NETWORK TRANSFER</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-ink-strong">
            // Enter the SSH details of a device already on your network. Morpheus builds a command
            you run from <b className="text-primary">your own machine</b> (not the cloud — the
            sandbox can't open SSH) — the remote pulls the image from storage and writes it to the
            target device. No disk swapping.
          </p>
          {loading && (
            <div className="flex items-center gap-2 text-ink text-sm">
              <Loader2 size={14} className="animate-spin" /> Locating compiled image...
            </div>
          )}
          {error && <p className="text-xs text-red-500">// {error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Host / IP</label>
              <input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.50" className="w-full bg-background text-ink border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-ink" />
            </div>
            <div>
              <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">User</label>
              <input value={username} onChange={e => setUsername(e.target.value)} placeholder="pi" className="w-full bg-background text-ink border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-ink" />
            </div>
            <div>
              <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Port</label>
              <input value={port} onChange={e => setPort(e.target.value)} placeholder="22" className="w-full bg-background text-ink border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-ink" />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Target device on remote</label>
              <input value={targetDevice} onChange={e => setTargetDevice(e.target.value)} placeholder="/dev/sda" className="w-full bg-background text-ink border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-ink" />
              <p className="text-[10px] text-ink-max mt-1">// The block device to overwrite on the Pi. The SSH user needs passwordless sudo (or connect as root).</p>
            </div>
          </div>
          {ready && (
            <>
              <div className="border border-primary/30 bg-primary/5 p-2.5">
                <div className="text-[10px] text-ink-max mb-1">// RUN THIS FROM YOUR OWN MACHINE (not the Pi, not the cloud):</div>
                <pre className="text-[10px] text-ink-max overflow-x-auto scrollbar-matrix whitespace-pre-wrap break-all">{command}</pre>
              </div>
              <div className="flex gap-2">
                <button onClick={copy} className="flex-1 flex items-center justify-center gap-2 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-xs font-bold">
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'COPIED' : 'COPY COMMAND'}
                </button>
                <button onClick={downloadScript} className="flex items-center justify-center gap-2 py-2 px-3 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-xs">
                  <Download size={14} /> .sh
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}