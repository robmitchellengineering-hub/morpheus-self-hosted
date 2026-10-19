const express = require('express');
const db = require('../db');

const router = express.Router();

// Note the shape: the MODULE is a factory, so the handle comes from getDb(). Calling db.prepare() here
// is precisely the defect the checker looks for, and this file is the fixture's demonstration of the
// correct form.
router.get('/', (req, res) => {
  db.getDb().all('SELECT id, title, done FROM tasks ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tasks: rows || [] });
  });
});

router.post('/', (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  db.getDb().run('INSERT INTO tasks (title, done) VALUES (?, 0)', [title], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, title, done: 0 });
  });
});

module.exports = router;
