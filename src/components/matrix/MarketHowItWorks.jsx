import { MessageSquare, CreditCard, Download } from 'lucide-react';

// Three-step explainer shown on the market page so first-time visitors
// understand the purchase flow before browsing. Presentational only.
const STEPS = [
  { icon: MessageSquare, n: '01', title: 'Describe & build', body: 'Sellers build real software with Morpheus and publish it to the market.' },
  { icon: CreditCard, n: '02', title: 'Buy securely', body: 'Pay with Stripe. Your card details never touch Morpheus.' },
  { icon: Download, n: '03', title: 'Download & own', body: 'Get the full source code instantly. It is yours to run, edit, and ship.' },
];

export default function MarketHowItWorks() {
  return (
    <div className="mb-6">
      <h2 className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-3">// HOW IT WORKS</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {STEPS.map(({ icon: Icon, n, title, body }) => (
          <div key={n} className="p-4 flex gap-3">
            <div className="font-display text-2xl text-primary/30 leading-none">{n}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-primary text-sm font-bold">
                <Icon size={14} /> {title}
              </div>
              <p className="text-ink/60 text-xs mt-1 leading-relaxed">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}