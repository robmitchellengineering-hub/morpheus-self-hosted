import { useState, cloneElement, Children } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { useHelpMode } from '@/contexts/HelpModeContext';

// Wraps a trigger element. When help mode is ON and this hint hasn't been
// seen yet, the first click is intercepted to show an instructional overlay
// instead of firing the action. Dismiss it ("Got it") and the next click
// works normally. When help mode is OFF (or the hint was already seen) the
// child renders and behaves exactly as before — zero overhead, no wrapper.
//
// Usage:  <HelpHint id="github-connect" title="Connect GitHub" body="..."> <button .../> </HelpHint>
export default function HelpHint({ id, title, body, children }) {
  const { helpMode, seenHints, markSeen } = useHelpMode();
  const [show, setShow] = useState(false);
  const active = helpMode && !seenHints.has(id);

  // Help off or already seen — pass through untouched.
  if (!active) return children;

  const child = Children.only(children);

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setShow(true);
  };

  const handleClose = () => {
    markSeen(id);
    setShow(false);
  };

  const enhanced = cloneElement(child, {
    onClick: handleClick,
    className: `${child.props.className ?? ''} ring-2 ring-yellow-400/70 ring-offset-1 ring-offset-black`,
  });

  return (
    <>
      {enhanced}
      {show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80" onClick={handleClose}>
          <div className="relative max-w-sm w-full border border-yellow-400/50 bg-black p-5 shadow-[0_0_24px_rgba(250,204,21,0.15)]" onClick={e => e.stopPropagation()}>
            <button onClick={handleClose} className="absolute top-2 right-2 text-yellow-400/50 hover:text-yellow-400">
              <X size={14} />
            </button>
            <div className="flex items-center gap-2 mb-2">
              <HelpCircle size={16} className="text-yellow-400 shrink-0" />
              <h3 className="text-sm font-display tracking-wider text-yellow-400">{title}</h3>
            </div>
            <p className="text-xs text-primary/70 leading-relaxed whitespace-pre-wrap">{body}</p>
            <button onClick={handleClose} className="mt-4 w-full py-2 border border-yellow-400/60 text-yellow-400 hover:bg-yellow-400 hover:text-black transition-colors text-xs font-bold tracking-wider">
              GOT IT — LET ME TRY
            </button>
          </div>
        </div>
      )}
    </>
  );
}