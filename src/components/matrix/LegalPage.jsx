import { Link } from 'react-router-dom';
import { ArrowLeft, Store } from 'lucide-react';
import MarketFooter from '@/components/matrix/MarketFooter';

// Shared layout for the legal pages (Terms, Privacy, Refund Policy). Renders
// the market header, a titled prose container, and the market footer so every
// legal page is consistent and navigable.
export default function LegalPage({ title, updated, children }) {
  return (
    <div className="min-h-screen bg-black text-primary flex flex-col">
      <header className="border-b border-primary/20 sticky top-0 z-10 bg-black/95 backdrop-blur-sm safe-top">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link to="/market" className="text-xs text-primary/60 hover:text-primary flex items-center gap-1 shrink-0">
            <ArrowLeft size={12} /> MARKET
          </Link>
          <Link to="/" className="text-xs text-primary/60 hover:text-primary flex items-center gap-1 shrink-0">
            <Store size={12} /> APP
          </Link>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 flex-1 w-full">
        <h1 className="text-2xl font-display tracking-wide neon-glow mb-1 text-heading">{title}</h1>
        {updated && <p className="text-xs text-primary/45 mb-6">Last updated: {updated}</p>}
        <div className="text-primary/75 text-sm leading-relaxed space-y-4 [&_h2]:text-primary [&_h2]:font-display [&_h2]:tracking-wider [&_h2]:text-sm [&_h2]:mt-6 [&_h2]:mb-2 [&_a]:text-primary [&_a]:underline [&_strong]:text-primary">
          {children}
        </div>
      </div>

      <MarketFooter />
    </div>
  );
}