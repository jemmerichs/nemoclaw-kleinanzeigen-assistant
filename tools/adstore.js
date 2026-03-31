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
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      description      TEXT,
      category_id      INTEGER,
      zip_code         TEXT,
      asking_price_cents INTEGER,
      status           TEXT NOT NULL DEFAULT 'available', -- available | sold
      sold_at          TEXT,
      sold_price_cents INTEGER,
      notes            TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- One row per KA listing attempt. An asset can have many listings
    -- (expired → re-posted → expired → ...).
    CREATE TABLE IF NOT EXISTS listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES assets(id),
      ka_id       TEXT UNIQUE,          -- KA ad ID; NULL for manually added history
      ka_link     TEXT,                 -- full KA URL
      price_cents INTEGER,              -- price at time of posting
      status      TEXT NOT NULL DEFAULT 'active', -- active | expired | removed | draft
      posted_at   TEXT,
      expired_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES assets(id),
      price_cents INTEGER NOT NULL,
      changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      note        TEXT
    );

    CREATE TABLE IF NOT EXISTS market_research (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id          INTEGER REFERENCES assets(id),
      query             TEXT NOT NULL,
      category_id       INTEGER,
      researched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      median_cents      INTEGER,
      recommended_cents INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_assets_status   ON assets(status);
    CREATE INDEX IF NOT EXISTS idx_listings_asset  ON listings(asset_id);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_ka_id  ON listings(ka_id);
    CREATE INDEX IF NOT EXISTS idx_ph_asset        ON price_history(asset_id);
    CREATE INDEX IF NOT EXISTS idx_mr_asset        ON market_research(asset_id);

    -- Assets with an active listing right now
    CREATE VIEW IF NOT EXISTS active_listings AS
      SELECT a.id AS asset_id, a.name, a.asking_price_cents, a.status AS asset_status,
             l.id AS listing_id, l.ka_id, l.ka_link, l.price_cents, l.posted_at
      FROM assets a
      JOIN listings l ON l.asset_id = a.id AND l.status = 'active';

    -- Available assets that have NO active listing → candidates for re-posting
    CREATE VIEW IF NOT EXISTS needs_repost AS
      SELECT a.id, a.name, a.asking_price_cents, a.notes,
             MAX(l.expired_at) AS last_expired_at
      FROM assets a
      LEFT JOIN listings l ON l.asset_id = a.id
      WHERE a.status = 'available'
        AND a.id NOT IN (SELECT asset_id FROM listings WHERE status = 'active')
      GROUP BY a.id;
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
