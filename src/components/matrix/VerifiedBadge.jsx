import { BadgeCheck } from 'lucide-react';

// Small "verified seller" badge shown on market cards and the store-item
// header. Every template published through Morpheus goes through the publish
// flow (auth + Stripe connect), so all listings carry this confidence signal.
export default function VerifiedBadge({ size = 12, className = '' }) {
  return (
    <span
      title="Verified seller — published through Morpheus"
      className={`inline-flex items-center gap-1 text-[10px] text-[#00ff41]/70 border border-[#00ff41]/30 px-1.5 py-0.5 ${className}`}
    >
      <BadgeCheck size={size} /> VERIFIED
    </span>
  );
}