"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const Database = require("better-sqlite3");

test("existing v2 inventory upgrades in place without losing listing history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-"));
  const dbPath = path.join(directory, "legacy.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      listing_name TEXT,
      description TEXT,
      category_id INTEGER,
      last_price_cents INTEGER,
      has_active_listing INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available',
      sold_at TEXT,
      sold_price_cents INTEGER,
      image_paths TEXT,
      ka_draft_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE ka_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      ka_id TEXT UNIQUE,
      ka_link TEXT,
      price_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      posted_at TEXT,
      expired_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE ka_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES ka_listings(id),
      price_cents INTEGER,
      views INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    INSERT INTO assets (
      id,name,listing_name,last_price_cents,has_active_listing,image_paths
    ) VALUES (
      1,'Legacy item','Legacy title',2500,1,'[]'
    );
    INSERT INTO ka_listings (
      id,asset_id,ka_id,price_cents,status,posted_at
    ) VALUES (
      1,1,'legacy-1',2500,'active','2026-07-01T10:00:00.000Z'
    );
    INSERT INTO ka_snapshots (
      listing_id,price_cents,views,recorded_at
    ) VALUES (
      1,2500,7,'2026-07-02T10:00:00.000Z'
    );
  `);
  legacy.close();

  process.env.NEMOCLAW_DB_PATH = dbPath;
  process.env.NEMOCLAW_IMAGE_DIR = path.join(directory, "images");
  const modulePath = require.resolve("../tools/adstore");
  delete require.cache[modulePath];
  const store = require("../tools/adstore");
  try {
    const bundle = store.getAssetBundle(1);
    assert.equal(bundle.asset.name, "Legacy item");
    assert.equal(bundle.listings[0].ka_id, "legacy-1");
    assert.equal(bundle.listings[0].performance.current_views, 7);
    assert.deepEqual(bundle.images, []);

    const reconciliation = store.reconcileRemoteListings([{
      id: "legacy-1",
      status: "active",
      title: "Legacy title",
      price: 25,
      views: 8,
    }], { now: "2026-07-28T10:00:00.000Z" });
    assert.equal(reconciliation.events.length, 0);
    const upgraded = store.getAssetBundle(1);
    assert.equal(upgraded.listings[0].last_seen_at, "2026-07-28T10:00:00.000Z");
    assert.equal(upgraded.listings[0].performance.current_views, 8);
    assert.equal(upgraded.listings[0].performance.view_delta, 1);
  } finally {
    store.close();
    delete require.cache[modulePath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
