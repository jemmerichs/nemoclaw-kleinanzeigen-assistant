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
    -- Physical item Jannik owns and wants to sell.
    -- Survives across multiple KA listing attempts.
    CREATE TABLE IF NOT EXISTS assets (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      listing_name        TEXT,
      description         TEXT,
      category_id         INTEGER,
      last_price_cents    INTEGER,
      has_active_listing  INTEGER NOT NULL DEFAULT 0, -- 0 | 1
      status              TEXT NOT NULL DEFAULT 'available', -- available | sold
      sold_at             TEXT,
      sold_price_cents    INTEGER,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- One row per KA listing attempt. An asset can have many (expired → re-posted → ...).
    CREATE TABLE IF NOT EXISTS ka_listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES assets(id),
      ka_id       TEXT UNIQUE,          -- KA ad ID; NULL for manually added history
      ka_link     TEXT,
      price_cents INTEGER,              -- price at time of posting
      status      TEXT NOT NULL DEFAULT 'active', -- active | expired | removed | draft
      posted_at   TEXT,
      expired_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- Price and view snapshots over a listing's lifetime.
    -- Insert one row whenever the agent reads ad data from KA.
    CREATE TABLE IF NOT EXISTS ka_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id  INTEGER NOT NULL REFERENCES ka_listings(id),
      price_cents INTEGER,
      views       INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_assets_status      ON assets(status);
    CREATE INDEX IF NOT EXISTS idx_ka_listings_asset  ON ka_listings(asset_id);
    CREATE INDEX IF NOT EXISTS idx_ka_listings_status ON ka_listings(status);
    CREATE INDEX IF NOT EXISTS idx_ka_listings_ka_id  ON ka_listings(ka_id);
    CREATE INDEX IF NOT EXISTS idx_ka_snapshots_listing ON ka_snapshots(listing_id);
  `);
  return _db;
}

/**
 * Execute any SQL.
 * SELECT / WITH → rows[]
 * INSERT / UPDATE  → { changes, lastInsertRowid }
 * DELETE / DROP / TRUNCATE → blocked
 */
function query({ sql, params = [] }) {
  const upper = sql.trimStart().toUpperCase();
  if (upper.startsWith("DELETE") || upper.startsWith("DROP") || upper.startsWith("TRUNCATE")) {
    throw new Error("DELETE/DROP/TRUNCATE not allowed — mark records inactive instead");
  }
  const db   = getDb();
  const stmt = db.prepare(sql);
  if (upper.startsWith("SELECT") || upper.startsWith("WITH")) return stmt.all(...params);
  const info = stmt.run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

module.exports = { query };
