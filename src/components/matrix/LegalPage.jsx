import { Link } from 'react-router-dom';
import { ArrowLeft, Store } from 'lucide-react';
import MarketFooter from '@/components/matrix/MarketFooter';

// Shared layout for the legal pages (Terms, Privacy, Refund Policy). Renders
// the market header, a titled prose container, and the market footer so every
// legal page is consistent and navigable.
export default function LegalPage({ title, updated, children }) {
  return (
    <div className="min-h-screen bg-black text-[#00ff41] flex flex-col">
      <header className="border-b border-[#00ff41]/20 sticky top-0 z-10 bg-black/95 backdrop-blur-sm safe-top">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link to="/market" className="text-xs text-[#00ff41]/60 hover:text-[#00ff41] flex items-center gap-1 shrink-0">
            <ArrowLeft size={12} /> MARKET
          </Link>
          <Link to="/" className="text-xs text-[#00ff41]/60 hover:text-[#00ff41] flex items-center gap-1 shrink-0">
            <Store size={12} /> APP
          </Link>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 flex-1 w-full">
        <h1 className="text-2xl font-display tracking-wide neon-glow mb-1">{title}</h1>
        {updated && <p className="text-xs text-[#00ff41]/45 mb-6">Last updated: {updated}</p>}
        <div className="text-[#00ff41]/75 text-sm leading-relaxed space-y-4 [&_h2]:text-[#00ff41] [&_h2]:font-display [&_h2]:tracking-wider [&_h2]:text-sm [&_h2]:mt-6 [&_h2]:mb-2 [&_a]:text-[#00ff41] [&_a]:underline [&_strong]:text-[#00ff41]">
          {children}
        </div>
      </div>

      <MarketFooter />
    </div>
  );
}