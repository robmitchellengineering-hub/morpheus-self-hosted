# Marketing docs

- `morpheus-wordpress-plugin-explainer.pdf` — rendered explainer: what the Morpheus WordPress plugin is, what it lets you do, why it matters to the WordPress market, and a cost comparison against managing a site yourself / a freelancer / an agency / SaaS / managed hosting.
- `morpheus-wordpress-plugin-explainer.html` — the editable source that generated the PDF (edit this, not the PDF).
- `morpheus-wordpress-plugin-revenue.pdf` — revenue projection at 1,000 / 10,000 / 100,000 / 1,000,000 active users, built from the repo's own business model (`docs/audits/morpheus-business-model-digest.md`) with the assumptions and caveats called out.
- `morpheus-wordpress-plugin-revenue.html` — the editable source that generated the revenue PDF.

## Regenerate the PDFs

Requires Google Chrome (or Chromium). From this directory, replace `NAME` with the file's basename:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="NAME.pdf" \
  "file://$PWD/NAME.html"
```

Keep each PDF in sync with its HTML source. The explainer's cost figures are cited from published sources; the revenue figures are the repo's own (business-model digest + `server/src/lib/billing.js`) — re-check all of them before updating the numbers.
