import { HelpCircle, X } from 'lucide-react';
import { useHelpMode } from '@/contexts/HelpModeContext';

// Global help-mode switch. When ON, features show a yellow ring and
// explain themselves on first tap. When OFF, everything behaves normally.
export default function HelpToggle() {
  const { helpMode, toggleHelpMode } = useHelpMode();
  return (
    <button
      onClick={toggleHelpMode}
      className={`flex items-center gap-1 text-xs px-2.5 py-1.5 border transition-colors shrink-0 ${
        helpMode
          ? 'border-yellow-400 text-yellow-400 bg-yellow-400/10 animate-pulse'
          : 'border-[#00ff41]/30 text-[#00ff41]/60 hover:text-[#00ff41] hover:border-[#00ff41]/60'
      }`}
      title={helpMode ? 'Turn off help mode' : 'Turn on help mode — tap any feature for instructions'}
    >
      {helpMode ? <X size={14} /> : <HelpCircle size={14} />}
      <span className="hidden sm:inline">{helpMode ? 'HELP ON' : 'HELP'}</span>
    </button>
  );
}