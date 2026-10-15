# Marketing docs

- `morpheus-wordpress-plugin-explainer.pdf` — rendered explainer: what the Morpheus WordPress plugin is, what it lets you do, why it matters to the WordPress market, and a cost comparison against managing a site yourself / a freelancer / an agency / SaaS / managed hosting.
- `morpheus-wordpress-plugin-explainer.html` — the editable source that generated the PDF (edit this, not the PDF).

## Regenerate the PDF

Requires Google Chrome (or Chromium). From this directory:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="morpheus-wordpress-plugin-explainer.pdf" \
  "file://$PWD/morpheus-wordpress-plugin-explainer.html"
```

Keep the two files in sync when the HTML changes. Cost figures are cited from published sources; Morpheus pricing is taken from `server/src/lib/billing.js` — re-check both before updating the numbers.
