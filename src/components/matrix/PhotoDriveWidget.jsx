// The photo widget at the top of the Alice Stats page.
//
// Take a photo → it lands in the signed-in user's OWN Google Drive folder.
// Nothing is stored by Morpheus: no S3, no media route. That is the product's
// "ownership, not rental" promise, so the copy says it plainly rather than
// leaving the user to assume where their photo went.
//
// The server (functions/photoDrive.js) owns every judgement — is this a folder,
// is this file an acceptable photo, did Drive refuse and why. This component
// only presents those answers, which is why the failure messages here are
// rendered verbatim instead of being re-worded locally: two copies of "what
// went wrong" is how a 403 starts reading like a 404.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ExternalLink, FolderPlus, Loader2, Upload, Check, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const call = (body) => base44.functions.invoke('photoDrive', body).then((r) => r.data);

export default function PhotoDriveWidget() {
  const [status, setStatus] = useState(null); // the server's status answer
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null); // 'folder' | 'create' | 'upload'
  const [incoming, setIncoming] = useState(null); // { file, previewUrl }
  const [saved, setSaved] = useState(null); // { file, folder }
  const [folderInput, setFolderInput] = useState('');
  const fileRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setStatus(await call({ action: 'status' }));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Object URLs are revoked on replace/unmount; a phone camera roll can be
  // large and holding a few of these alive is how a page starts to crawl.
  useEffect(() => () => { if (incoming?.previewUrl) URL.revokeObjectURL(incoming.previewUrl); }, [incoming]);

  const pick = (file) => {
    if (!file) return;
    setErr(null); setNote(null); setSaved(null);
    setIncoming({ file, previewUrl: URL.createObjectURL(file) });
  };

  const saveFolder = async () => {
    setBusy('folder'); setErr(null); setNote(null);
    try {
      const r = await call({ action: 'set_folder', input: folderInput });
      setNote(`Folder set: ${r.folder.name}`);
      setFolderInput('');
      await refresh();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const createFolder = async () => {
    setBusy('create'); setErr(null); setNote(null);
    try {
      const r = await call({ action: 'create_folder', name: status?.suggestedFolderName });
      setNote(`Created “${r.folder.name}” in your Drive.`);
      await refresh();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const upload = async () => {
    if (!incoming?.file) return;
    setBusy('upload'); setErr(null); setNote(null);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('Could not read that file — try taking the photo again.'));
        fr.readAsDataURL(incoming.file);
      });
      const dataBase64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      const r = await call({
        action: 'upload',
        name: incoming.file.name,
        mimeType: incoming.file.type,
        dataBase64,
      });
      setSaved({ file: r.file, folder: r.folder });
      setIncoming(null);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const box = 'border border-primary/20 bg-primary/5 px-4 py-3';
  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors disabled:opacity-40';

  return (
    <div className={`${box} mb-8`}>
      <div className="flex items-center gap-2 mb-2">
        <Camera size={16} className="text-primary" />
        <h2 className="text-sm font-display tracking-widest text-heading">TAKE A PHOTO → YOUR GOOGLE DRIVE</h2>
      </div>
      <p className="text-ink-max text-[11px] mb-3">
        The photo is uploaded to <strong className="text-primary/70">your own</strong> Google Drive folder — Morpheus never stores it.
        It uses the Google account you have already connected — Command Deck or Drive, whichever you granted — never a second one.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-ink-strong text-xs py-2">
          <Loader2 size={13} className="animate-spin" /> Checking your Drive connection…
        </div>
      )}

      {err && (
        <div className="flex items-start gap-2 text-danger text-xs border border-danger/30 px-3 py-2 mb-3">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{err}</span>
        </div>
      )}
      {note && <div className="text-ink-strong text-xs border border-primary/30 px-3 py-2 mb-3">{note}</div>}

      {/* Not connected: say exactly what is missing and where to fix it. */}
      {!loading && status && status.connected === false && (
        <div className="space-y-2">
          <p className="text-ink-strong text-xs">{status.message}</p>
          <a href={status.connectPath || '/settings'} className={btn}>
            <ExternalLink size={12} /> OPEN SETTINGS → GOOGLE DRIVE
          </a>
        </div>
      )}

      {/* Connected but no usable folder: offer to make one, or take a link. */}
      {!loading && status?.connected && !status.folder && (
        <div className="space-y-3">
          {status.message && <p className="text-ink-strong text-xs">{status.message}</p>}
          <button onClick={createFolder} disabled={busy === 'create'} className={btn}>
            {busy === 'create' ? <Loader2 size={12} className="animate-spin" /> : <FolderPlus size={12} />}
            CREATE “{(status.suggestedFolderName || 'Morpheus Photos').toUpperCase()}” IN MY DRIVE
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              placeholder="…or paste a Drive folder link"
              className="flex-1 min-w-[220px] bg-black/30 border border-primary/20 px-2.5 py-1.5 text-[11px] text-ink-max focus:outline-none focus:border-primary/50"
            />
            <button onClick={saveFolder} disabled={busy === 'folder' || !folderInput.trim()} className={btn}>
              {busy === 'folder' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} USE THIS FOLDER
            </button>
          </div>
          <p className="text-ink-max text-[10px]">
            A folder made here always works. A folder from elsewhere in your Drive may be refused — this connection is scoped to
            files Morpheus created, so the error will say so rather than pretending the folder is missing.
          </p>
        </div>
      )}

      {/* Ready: camera first on a phone, file picker everywhere else. */}
      {!loading && status?.folder && (
        <div className="space-y-3">
          <div className="text-[11px] text-ink-max">
            Saving to{' '}
            <a href={status.folder.link} target="_blank" rel="noreferrer" className="underline hover:text-primary">
              {status.folder.name}
            </a>
            {status.email ? (
              <span className="text-ink-max">
                {' · '}{status.email}
                {status.sourceLabel ? ` (${status.sourceLabel})` : ''}
              </span>
            ) : null}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <button onClick={() => fileRef.current?.click()} disabled={busy === 'upload'} className={btn}>
            <Camera size={12} /> TAKE OR CHOOSE A PHOTO
          </button>

          {incoming && (
            <div className="flex items-start gap-3">
              <img src={incoming.previewUrl} alt="The photo you are about to upload" className="w-24 h-24 object-cover border border-primary/30" />
              <div className="space-y-2">
                <div className="text-[11px] text-primary/60">{incoming.file.name} · {(incoming.file.size / 1024 / 1024).toFixed(1)}MB</div>
                <button onClick={upload} disabled={busy === 'upload'} className={btn}>
                  {busy === 'upload' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  {busy === 'upload' ? 'UPLOADING…' : 'UPLOAD TO MY DRIVE'}
                </button>
              </div>
            </div>
          )}

          {saved && (
            <div className="text-[11px] border border-primary/30 px-3 py-2">
              <span className="text-ink-max">Saved to Drive</span>
              {saved.folder?.name ? <span className="text-ink-max"> → {saved.folder.name}</span> : null}
              <a href={saved.file.link} target="_blank" rel="noreferrer" className="ml-2 underline hover:text-primary inline-flex items-center gap-1">
                OPEN PHOTO <ExternalLink size={10} />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
