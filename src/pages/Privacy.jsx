import LegalPage from '@/components/matrix/LegalPage';

export default function Privacy() {
  return (
    <LegalPage title="PRIVACY POLICY" updated="August 23, 2026">
      <p>This Policy explains what Morpheus collects, why, and how we handle it when you use the Market and the app.</p>

      <h2>1. What We Collect</h2>
      <p><strong>Account data:</strong> your email address and display name when you register.</p>
      <p><strong>Usage data:</strong> which features you use and aggregated, anonymized analytics to improve the product.</p>
      <p><strong>Listing data:</strong> the templates you publish or purchase, including titles, descriptions, and file metadata.</p>

      <h2>2. Payments</h2>
      <p>Payments are processed by Stripe. Morpheus receives a tokenized reference to the transaction but never your full card details. Card data is handled entirely by Stripe under PCI-DSS compliance.</p>

      <h2>3. How We Use Your Data</h2>
      <p>To operate the Market, process purchases and payouts, prevent fraud, provide support, and improve the platform. We do not sell your personal data.</p>

      <h2>4. Data Retention</h2>
      <p>We keep your account and listing data for as long as your account is active. Transaction records are retained as required for accounting and tax compliance, then deleted or anonymized.</p>

      <h2>5. Your Rights</h2>
      <p>You can request access to, correction of, or deletion of your personal data through the app's Settings page. You may also close your account at any time, which removes your personal data subject to legal retention requirements.</p>

      <h2>6. Cookies</h2>
      <p>The app uses essential storage to keep you signed in and remember your preferences. No third-party advertising cookies are used.</p>

      <h2>7. Sharing</h2>
      <p>We share data only with our payment processor (Stripe) and hosting infrastructure needed to run the service, and when required by law.</p>

      <h2>8. Contact</h2>
      <p>Privacy questions can be sent to Morpheus support through the app's Settings page.</p>
    </LegalPage>
  );
}