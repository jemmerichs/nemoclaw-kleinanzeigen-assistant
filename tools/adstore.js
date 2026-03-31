"use strict";

const path     = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "../workspace/ads.db");
let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ka_id         TEXT UNIQUE,
      title         TEXT NOT NULL,
      description   TEXT,
      category_id   INTEGER,
      price_cents   INTEGER,
      price_type    TEXT DEFAULT 'NEGOTIABLE',
      zip_code      TEXT,
      status        TEXT NOT NULL DEFAULT 'draft',
      ka_link       TEXT,
      facts         TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      sold_at       TEXT,
      sold_price_cents INTEGER
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id       INTEGER NOT NULL REFERENCES ads(id),
      price_cents INTEGER NOT NULL,
      changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      note        TEXT
    );
    CREATE TABLE IF NOT EXISTS market_research (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      query             TEXT NOT NULL,
      category_id       INTEGER,
      researched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      median_cents      INTEGER,
      recommended_cents INTEGER,
      ad_id             INTEGER REFERENCES ads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
    CREATE INDEX IF NOT EXISTS idx_ads_ka_id  ON ads(ka_id);
    CREATE INDEX IF NOT EXISTS idx_ph_ad_id   ON price_history(ad_id);
    CREATE INDEX IF NOT EXISTS idx_mr_ad_id   ON market_research(ad_id);
  `);
  return _db;
}

/**
 * Execute any SQL. SELECT/WITH → rows[]. INSERT/UPDATE/DELETE → { changes, lastInsertRowid }.
 * params: positional array for ? placeholders.
 */
function query({ sql, params = [] }) {
  const db   = getDb();
  const stmt = db.prepare(sql);
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) return stmt.all(...params);
  const info = stmt.run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

module.exports = { query };
