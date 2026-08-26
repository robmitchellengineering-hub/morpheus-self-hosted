import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

// Responsive bottom-sheet selection drawer (vaul). Replaces native <select>
// with a mobile-first picker that also works on desktop (centered sheet).
// Preserves the dark cyberpunk theme. No functionality change vs a select.
export default function SheetSelect({ value, onChange, options, triggerClassName = '', label = 'SELECT' }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  const handleSelect = (v) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center justify-between gap-2 bg-black text-[#00ff41] border border-[#00ff41]/30 px-3 py-2 text-sm outline-none cursor-pointer hover:border-[#00ff41]/60 transition-colors ${triggerClassName}`}
      >
        <span className="truncate text-left">{current?.label ?? value ?? '—'}</span>
        <ChevronDown size={14} className="text-[#00ff41]/50 shrink-0" />
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="bg-black border-[#00ff41]/40 text-[#00ff41] max-h-[75vh] sm:max-w-md sm:mx-auto">
          <DrawerHeader className="text-left pb-2">
            <DrawerTitle className="text-[#00ff41] font-display tracking-wider text-sm">{label}</DrawerTitle>
          </DrawerHeader>
          <div className="px-2 pb-[max(1rem,env(safe-area-inset-bottom))] overflow-y-auto scrollbar-matrix max-h-[60vh]">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => handleSelect(o.value)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-3 text-sm text-left border-b border-[#00ff41]/10 hover:bg-[#00ff41]/5 transition-colors ${o.value === value ? 'text-[#00ff41]' : 'text-[#00ff41]/60'}`}
              >
                <span className="flex-1 min-w-0">{o.label}</span>
                {o.value === value && <Check size={14} className="text-[#00ff41] shrink-0" />}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}