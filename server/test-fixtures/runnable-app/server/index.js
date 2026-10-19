// The fixture's entry point. It creates its own database, applies its schema on boot, and serves one
// route — the smallest thing that can prove "one command starts the whole app" is true of a shape.
const express = require('express');
const db = require('./db');
const tasks = require('./routes/tasks');

const PORT = process.env.PORT || 3010;

// Schema on boot, not "now go and set up a database".
db.initialize();

const app = express();
app.use(express.json());
app.use('/api/tasks', tasks);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// Chrome asks for /favicon.ico unprompted, and a real app the operator runs should not answer its own icon with
// a 404. The browser tier keeps the RESPONSE check (a same-origin 4xx is a broken asset) while allowlisting
// Chrome's console message for it, so the honest fix is to serve one rather than to filter the failure away.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/** Titles arrive from user input, so they are escaped rather than interpolated raw. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── A PAGE, because an API answering 200 is not evidence that a person sees anything ───────────────────────
// This is the whole reason the browser tier exists (MORPHEUS-BIG-PICTURE.md, "Self-dev should render what it
// builds"): a bundle check passes, an HTTP 200 says only that a shell was served, and meanwhile the page is
// blank or the console is throwing. Without a page here there is nothing for a browser to have an opinion about,
// which is why this app served JSON only until now.
//
// Server-rendered ON PURPOSE. The assertion that matters is that a real browser finds visible content, with a
// clean console and nothing thrown — a client-rendered SPA is a different and larger fixture, and pretending this
// one is that would make a green result mean less than it appears to.
app.get('/', (_req, res) => {
  db.getDb().all('SELECT id, title, done FROM tasks ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).type('html').send('<!doctype html><title>error</title><h1>database error</h1>');
    const list = (rows || []).map((t) => `      <li data-task="${t.id}">${escapeHtml(t.title)}${t.done ? ' \u2713' : ''}</li>`);
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Runnable app fixture</title></head>
  <body>
    <h1 data-page="fixture-home">Runnable app fixture</h1>
    <p data-count="${(rows || []).length}">${(rows || []).length} task(s)</p>
    <ul data-tasks>
${list.length ? list.join('\n') : '      <li data-empty>No tasks yet</li>'}
    </ul>
  </body>
</html>`);
  });
});

app.listen(PORT, () => {
  // One line, no secrets, so a smoke test can wait for the port rather than guess at a delay.
  console.log(`[runnable-app] listening on http://localhost:${PORT}`);
});
