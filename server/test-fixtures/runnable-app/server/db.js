// The fixture's database module — deliberately the SHAPE a generated one should have: one factory, one
// handle, and the handle only ever reached through it. The contract check in lib/generatedAppCheck.js
// exists because the generator produced the opposite of this on 2026-09-29.
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, '..', 'data', 'app.db');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initialize() first.');
  return db;
}

function initialize() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    )`);
  });
  return db;
}

module.exports = { initialize, getDb };
