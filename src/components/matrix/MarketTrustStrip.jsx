import { ShieldCheck, Lock, BadgeCheck, Download } from 'lucide-react';

// Trust signals shown at the top of the market grid. Reassures buyers that
// checkout is Stripe-secured, refunds are guaranteed, sellers are verified,
// and delivery is instant. Purely presentational.
const ITEMS = [
  { icon: Lock, label: 'Stripe-secured checkout', sub: '256-bit encrypted payments' },
  { icon: ShieldCheck, label: '14-day refund guarantee', sub: 'Risk-free purchases' },
  { icon: BadgeCheck, label: 'Verified sellers', sub: 'Identity-checked publishers' },
  { icon: Download, label: 'Instant download', sub: 'Get your code immediately' },
];

export default function MarketTrustStrip() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
      {ITEMS.map(({ icon: Icon, label, sub }) => (
        <div key={label} className="p-3 flex items-start gap-2.5">
          <Icon size={18} className="text-primary shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-xs text-primary font-bold leading-tight">{label}</div>
            <div className="text-[10px] text-ink/55 leading-tight mt-0.5">{sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}