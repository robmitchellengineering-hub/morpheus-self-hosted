import LegalPage from '@/components/matrix/LegalPage';

export default function Terms() {
  return (
    <LegalPage title="TERMS OF SERVICE" updated="August 23, 2026">
      <p>These Terms govern your use of the Morpheus Market and the software templates bought and sold through it. By browsing, buying, or publishing on the Market, you agree to these Terms.</p>

      <h2>1. Accounts</h2>
      <p>To publish or purchase a template you need a Morpheus account. You are responsible for keeping your credentials secure and for all activity under your account. You must be at least the age of digital consent in your jurisdiction to use the Market.</p>

      <h2>2. The Marketplace</h2>
      <p>Morpheus provides a platform for sellers to list software templates and for buyers to purchase and download them. Morpheus is the marketplace operator, not the seller of record for individual listings. Each listing is sold by its publisher, and Morpheus facilitates the transaction.</p>

      <h2>3. Purchases &amp; Payments</h2>
      <p>All payments are processed by Stripe. Morpheus never receives or stores your full card number. When you purchase a template, you receive a non-exclusive, perpetual license to use, modify, and deploy the source code for your own purposes. You may not resell or redistribute the template as-is.</p>

      <h2>4. Seller Obligations</h2>
      <p>By publishing a template you confirm that you own or have the rights to all code and assets in the listing, that the software does what the listing describes, and that it is free of malware, backdoors, or malicious telemetry. Sellers agree to the Morpheus Marketplace Seller Agreement and to remit the platform fee on each sale.</p>

      <h2>5. Prohibited Content</h2>
      <p>Listings containing malware, stolen code, infringing material, or software designed to harm users are prohibited and will be removed. Sellers may be permanently banned and pending payouts forfeited for violations.</p>

      <h2>6. Disclaimers</h2>
      <p>Templates are provided "as is" by their sellers. Morpheus does not guarantee that any template will be bug-free, compatible with your environment, or fit for a particular purpose. You are responsible for reviewing code before deploying it.</p>

      <h2>7. Limitation of Liability</h2>
      <p>To the maximum extent permitted by law, Morpheus is not liable for indirect, incidental, or consequential damages arising from your use of the Market or any template purchased through it. Our total liability is limited to the amount you paid for the template in question.</p>

      <h2>8. Changes</h2>
      <p>We may update these Terms as the Market evolves. Material changes will be announced; continued use after the effective date constitutes acceptance.</p>

      <h2>9. Contact</h2>
      <p>Questions about these Terms can be directed to Morpheus support through the app's Settings page.</p>
    </LegalPage>
  );
}