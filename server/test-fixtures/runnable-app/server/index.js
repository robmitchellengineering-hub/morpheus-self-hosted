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

app.listen(PORT, () => {
  // One line, no secrets, so a smoke test can wait for the port rather than guess at a delay.
  console.log(`[runnable-app] listening on http://localhost:${PORT}`);
});
