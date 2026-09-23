import { Link } from 'react-router-dom';
import { Store } from 'lucide-react';

// Footer shown on the market and store-item pages. Links to the legal pages
// and states the seller agreement, so buyers and sellers see the compliance
// surface from anywhere in the marketplace.
export default function MarketFooter() {
  return (
    <footer className="border-t border-primary/20 mt-10 pt-6 pb-8">
      <div className="max-w-6xl mx-auto px-4 space-y-4">
        <div className="flex items-center gap-2 text-ink/60">
          <Store size={14} />
          <span className="font-display tracking-wider text-xs">MORPHEUS MARKET</span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink/55">
          <Link to="/terms" className="hover:text-primary">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-primary">Privacy Policy</Link>
          <Link to="/refund-policy" className="hover:text-primary">Refund Policy</Link>
          <Link to="/market" className="hover:text-primary">Browse Market</Link>
          <Link to="/" className="hover:text-primary">Home</Link>
        </div>
        <p className="text-[10px] text-ink/45 leading-relaxed max-w-2xl">
          // Sellers agree to the Morpheus Marketplace Seller Agreement when publishing. Payments are processed by Stripe. Morpheus acts as the marketplace platform and is not the seller of record for individual listings.
        </p>
        <p className="text-[10px] text-ink/40">© {new Date().getFullYear()} Morpheus. All transactions secured by Stripe.</p>
      </div>
    </footer>
  );
}