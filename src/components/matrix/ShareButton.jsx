import { useState } from 'react';
import { Link2, CheckCircle2 } from 'lucide-react';

// Copies a public store link to the clipboard. Works inside a <Link> card —
// preventDefault + stopPropagation so the click doesn't navigate to the store
// page. `url` defaults to the current origin + /store/:id.
export default function ShareButton({ templateId, label = 'SHARE', className = '' }) {
  const [copied, setCopied] = useState(false);

  const share = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}/store/${templateId}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Morpheus construct', url });
        return;
      }
      await navigator.clipboard?.writeText(url);
    } catch {
      // user dismissed native share sheet — no-op
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={share}
      className={`flex items-center gap-1 text-[10px] text-[#00ff41]/60 hover:text-[#00ff41] border border-[#00ff41]/30 hover:border-[#00ff41]/60 px-2 py-1 transition-colors ${className}`}
    >
      {copied ? <><CheckCircle2 size={10} /> COPIED</> : <><Link2 size={10} /> {label}</>}
    </button>
  );
}