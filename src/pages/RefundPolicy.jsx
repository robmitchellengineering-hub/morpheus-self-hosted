import LegalPage from '@/components/matrix/LegalPage';

export default function RefundPolicy() {
  return (
    <LegalPage title="REFUND POLICY" updated="August 23, 2026">
      <p>Because Morpheus Market sells digital source code that is downloaded immediately, refunds work a little differently than for physical goods. This Policy explains when refunds apply and how to request one.</p>

      <h2>1. 14-Day Guarantee</h2>
      <p>If a template you purchased is materially defective — it will not run as described in the listing, contains errors that prevent its stated use, or was misdescribed — you may request a full refund within 14 days of purchase.</p>

      <h2>2. How to Request a Refund</h2>
      <p>Open the template in the Market, go to your purchase, and contact Morpheus support through the app's Settings page with your order ID and a short description of the issue. We review requests and process approved refunds via Stripe, which typically appear on your card within 5–10 business days.</p>

      <h2>3. When Refunds Are Not Available</h2>
      <p>Refunds are not available where the template works as described but you changed your mind, no longer need it, or failed to review the listing before buying. Once source code is downloaded, "buyer's remorse" alone is not grounds for a refund.</p>

      <h2>4. Fraud &amp; Abuse</h2>
      <p>Repeated refund requests on working templates may result in restricted market access. Refund abuse is treated as fraud and reported to Stripe.</p>

      <h2>5. Seller Recourse</h2>
      <p>Approved refunds are deducted from the seller's pending payouts. Sellers may dispute a refund request by providing evidence the template works as described.</p>

      <h2>6. Chargebacks</h2>
      <p>If you believe a charge is incorrect, contact support before initiating a chargeback with your bank — most issues are resolved faster directly.</p>
    </LegalPage>
  );
}