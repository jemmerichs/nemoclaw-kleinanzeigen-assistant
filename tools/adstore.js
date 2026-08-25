"use strict";

const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");
const Database = require("better-sqlite3");
const { readProvenance } = require("./image");

const DB_PATH = process.env.NEMOCLAW_DB_PATH || path.join(__dirname, "../workspace/ads.db");
let _db = null;

function addMissingColumns(database, table, definitions) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Ungültiger Tabellenname in Migration: ${table}`);
  }
  const existing = new Set(
    database.pragma(`table_info(${table})`).map(column => String(column.name))
  );
  for (const [column, definition] of Object.entries(definitions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Ungültiger Spaltenname in Migration: ${column}`);
    }
    if (existing.has(column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    existing.add(column);
  }
}

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
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
      image_paths         TEXT,
      ka_draft_id         TEXT,
      vinted_draft_id     TEXT,
      last_listing_payload_json TEXT,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- One row per KA listing attempt. An asset can have many (expired → re-posted → ...).
    CREATE TABLE IF NOT EXISTS ka_listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES assets(id),
      ka_id       TEXT UNIQUE,          -- KA ad ID; NULL for manually added history
      external_id TEXT,                 -- Marketplace-native ID (KA mirrors ka_id)
      ka_link     TEXT,
      price_cents INTEGER,              -- price at time of posting
      status      TEXT NOT NULL DEFAULT 'active', -- active | expired | removed | draft
      posted_at   TEXT,
      expired_at  TEXT,
      payload_json TEXT,
      last_seen_at TEXT,
      missing_checks INTEGER NOT NULL DEFAULT 0,
      remote_status TEXT,
      alerted_state TEXT,
      pending_event_json TEXT,
      marketplace TEXT NOT NULL DEFAULT 'kleinanzeigen',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- Ordered image selection and immutable edit provenance used for the latest
    -- canonical listing payload of an asset.
    CREATE TABLE IF NOT EXISTS asset_images (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      image_path    TEXT NOT NULL,
      source_path   TEXT NOT NULL,
      kind          TEXT NOT NULL,
      input_sha256  TEXT,
      output_sha256 TEXT NOT NULL,
      operations_json TEXT,
      media_id       TEXT REFERENCES media_assets(media_id),
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(asset_id, position)
    );

    -- Host-local, opaque media identity. managed_path is deliberately never
    -- exposed through an agent-facing tool result.
    CREATE TABLE IF NOT EXISTS media_assets (
      media_id       TEXT PRIMARY KEY,
      managed_path   TEXT NOT NULL UNIQUE,
      sha256         TEXT NOT NULL,
      byte_size      INTEGER NOT NULL,
      mime_type      TEXT NOT NULL,
      source         TEXT NOT NULL,
      availability   TEXT NOT NULL DEFAULT 'available',
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      checked_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- The marketplace broker is the only module allowed to mutate this
    -- journal. It is intentionally domain-specific rather than a task runner.
    CREATE TABLE IF NOT EXISTS external_operations (
      operation_id          TEXT PRIMARY KEY,
      chat_id               TEXT NOT NULL,
      payload_fingerprint   TEXT NOT NULL,
      provider              TEXT NOT NULL,
      action                TEXT NOT NULL,
      account               TEXT NOT NULL,
      policy_mode           TEXT NOT NULL,
      status                TEXT NOT NULL,
      phase                 TEXT NOT NULL,
      write_certainty       TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      media_hashes_json     TEXT NOT NULL,
      preparation_version   INTEGER NOT NULL,
      session_revision      TEXT NOT NULL,
      form_fingerprint      TEXT NOT NULL,
      remote_id             TEXT,
      reconciliation_json   TEXT,
      cancel_reason         TEXT,
      expires_at            TEXT NOT NULL,
      request_started_at    TEXT,
      completed_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
    CREATE INDEX IF NOT EXISTS idx_asset_images_asset ON asset_images(asset_id);
    CREATE INDEX IF NOT EXISTS idx_media_assets_sha256 ON media_assets(sha256);
    CREATE INDEX IF NOT EXISTS idx_external_operations_chat_status
      ON external_operations(chat_id,status);
    CREATE INDEX IF NOT EXISTS idx_external_operations_fingerprint
      ON external_operations(payload_fingerprint,status);
  `);
  // Inspect the schema explicitly so only genuinely missing columns are added.
  // Unexpected SQLite errors must abort startup instead of leaving a partial schema hidden.
  const migrateColumns = _db.transaction(() => {
    addMissingColumns(_db, "assets", {
      image_paths: "TEXT",
      ka_draft_id: "TEXT",
      vinted_draft_id: "TEXT",
      last_listing_payload_json: "TEXT",
    });
    addMissingColumns(_db, "ka_listings", {
      payload_json: "TEXT",
      last_seen_at: "TEXT",
      missing_checks: "INTEGER NOT NULL DEFAULT 0",
      remote_status: "TEXT",
      alerted_state: "TEXT",
      pending_event_json: "TEXT",
      marketplace: "TEXT NOT NULL DEFAULT 'kleinanzeigen'",
      external_id: "TEXT",
    });
    addMissingColumns(_db, "asset_images", {
      media_id: "TEXT REFERENCES media_assets(media_id)",
    });
  });
  migrateColumns();
  _db.exec(`
    UPDATE ka_listings
    SET external_id=ka_id
    WHERE external_id IS NULL AND ka_id IS NOT NULL
  `);
  _db.exec("CREATE INDEX IF NOT EXISTS idx_ka_listings_marketplace ON ka_listings(marketplace)");
  _db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_listings_marketplace_external_id
    ON ka_listings(marketplace,external_id)
    WHERE external_id IS NOT NULL
  `);
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
  return _db;
}

function validateSql(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("SQL fehlt.");
  if (sql.length > 20000) throw new Error("SQL ist zu lang.");
  if (/\0|--|\/\*/.test(sql)) throw new Error("SQL-Kommentare sind nicht erlaubt.");

  const normalized = sql.trim().replace(/;\s*$/, "");
  if (normalized.includes(";")) throw new Error("Es ist nur ein SQL-Statement erlaubt.");
  const operation = normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (!["SELECT", "WITH", "INSERT", "UPDATE"].includes(operation)) {
    throw new Error("Nur SELECT, WITH, INSERT und UPDATE sind erlaubt.");
  }
  if (/\b(?:DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(normalized)) {
    throw new Error("Destruktive oder administrative SQL-Befehle sind nicht erlaubt.");
  }
  if (operation === "UPDATE" && !/\bWHERE\b/i.test(normalized)) {
    throw new Error("UPDATE ohne WHERE ist nicht erlaubt.");
  }
  if (["INSERT", "UPDATE"].includes(operation)) {
    const match = normalized.match(
      operation === "INSERT"
        ? /^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i
        : /^UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\b/i
    );
    const table = match?.[1]?.toLowerCase();
    if (!["assets", "ka_listings", "ka_snapshots", "asset_images"].includes(table)) {
      throw new Error("Schreibzugriffe sind nur auf die Inventar-Tabellen erlaubt.");
    }
  }
  return { normalized, operation };
}

/**
 * Execute any SQL.
 * SELECT / WITH → rows[]
 * INSERT / UPDATE  → { changes, lastInsertRowid }
 * DELETE / DROP / TRUNCATE → blocked
 */
function query({ sql, params = [] }) {
  if (!Array.isArray(params)) throw new Error("SQL-Parameter müssen als Liste übergeben werden.");
  const { normalized, operation } = validateSql(sql);
  const db   = getDb();
  const stmt = db.prepare(normalized);
  if (operation === "SELECT" || operation === "WITH") {
    if (!stmt.reader) throw new Error("WITH ist nur für lesende Abfragen erlaubt.");
    return stmt.all(...params);
  }
  const info = stmt.run(...params);
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}

function deleteUnlinkedAsset(assetId) {
  const id = Number(assetId);
  if (!Number.isInteger(id) || id < 1) throw new Error("assetId ist ungültig.");
  const db = getDb();
  return db.transaction(() => {
    const asset = db.prepare(
      "SELECT id,name,has_active_listing,ka_draft_id,vinted_draft_id FROM assets WHERE id=?"
    ).get(id);
    if (!asset) throw new Error(`Asset ${id} nicht gefunden.`);
    const listingCount = Number(db.prepare(
      "SELECT COUNT(*) AS count FROM ka_listings WHERE asset_id=?"
    ).get(id)?.count || 0);
    if (asset.has_active_listing || asset.ka_draft_id || asset.vinted_draft_id || listingCount) {
      throw new Error(
        `Asset ${id} ist mit einem Entwurf oder einer Anzeigenhistorie verknüpft und wird nicht gelöscht.`
      );
    }
    const result = db.prepare("DELETE FROM assets WHERE id=?").run(id);
    return { deletedAssetId: id, name: asset.name, changes: result.changes };
  })();
}

function replaceAssetImages(assetId, imagePaths) {
  const id = Number(assetId);
  if (!Number.isInteger(id) || id < 1) throw new Error("assetId ist ungültig.");
  if (!Array.isArray(imagePaths)) throw new Error("imagePaths muss eine Liste sein.");
  const mediaStore = require("./media-store");
  const provenance = imagePaths.map((imagePath, position) => {
    const details = readProvenance(imagePath);
    const media = mediaStore.registerManagedMedia(details.outputPath, { source: "asset-image" });
    return { position, mediaId: media.mediaId, ...details };
  });
  const db = getDb();
  return db.transaction(() => {
    if (!db.prepare("SELECT id FROM assets WHERE id=?").get(id)) {
      throw new Error(`Asset ${id} nicht gefunden.`);
    }
    db.prepare("DELETE FROM asset_images WHERE asset_id=?").run(id);
    const insert = db.prepare(`
      INSERT INTO asset_images (
        asset_id, position, image_path, source_path, kind,
        input_sha256, output_sha256, operations_json, media_id
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const item of provenance) {
      insert.run(
        id,
        item.position,
        item.outputPath,
        item.sourcePath,
        item.kind,
        item.inputSha256 || null,
        item.outputSha256,
        item.operations ? JSON.stringify(item.operations) : null,
        item.mediaId
      );
    }
    return provenance;
  })();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function summarizeListingPerformance(listing, snapshots) {
  if (!snapshots.length) {
    return {
      snapshot_count: 0,
      first_observed_at: null,
      last_metric_change_at: null,
      last_checked_at: listing.last_seen_at || null,
      initial_price_cents: null,
      current_price_cents: listing.price_cents ?? null,
      price_delta_cents: null,
      initial_views: null,
      current_views: null,
      view_delta: null,
      last_price_change_at: null,
      last_view_change_at: null,
    };
  }

  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  let lastPriceChangeAt = first.price_cents === null ? null : first.recorded_at;
  let lastViewChangeAt = first.views === null ? null : first.recorded_at;
  for (let index = 1; index < snapshots.length; index++) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    if (current.price_cents !== previous.price_cents && current.price_cents !== null) {
      lastPriceChangeAt = current.recorded_at;
    }
    if (current.views !== previous.views && current.views !== null) {
      lastViewChangeAt = current.recorded_at;
    }
  }

  const priceDelta = first.price_cents === null || latest.price_cents === null
    ? null
    : latest.price_cents - first.price_cents;
  const viewDelta = first.views === null || latest.views === null
    ? null
    : latest.views - first.views;
  return {
    snapshot_count: snapshots.length,
    first_observed_at: first.recorded_at,
    last_metric_change_at: latest.recorded_at,
    last_checked_at: listing.last_seen_at || latest.recorded_at,
    initial_price_cents: first.price_cents,
    current_price_cents: latest.price_cents ?? listing.price_cents ?? null,
    price_delta_cents: priceDelta,
    initial_views: first.views,
    current_views: latest.views,
    view_delta: viewDelta,
    last_price_change_at: lastPriceChangeAt,
    last_view_change_at: lastViewChangeAt,
  };
}

function getAssetBundle(assetId) {
  const id = Number(assetId);
  if (!Number.isInteger(id) || id < 1) throw new Error("assetId ist ungültig.");
  const db = getDb();
  const asset = db.prepare(`
    SELECT id,name,listing_name,description,category_id,last_price_cents,
           has_active_listing,status,sold_at,sold_price_cents,image_paths,
           ka_draft_id,vinted_draft_id,last_listing_payload_json,created_at,updated_at
    FROM assets WHERE id=?
  `).get(id);
  if (!asset) throw new Error(`Asset ${id} nicht gefunden.`);
  const images = db.prepare(`
    SELECT position,image_path,source_path,kind,input_sha256,output_sha256,media_id,
           operations_json,created_at
    FROM asset_images WHERE asset_id=? ORDER BY position
  `).all(id).map(row => ({
    ...row,
    operations: parseJson(row.operations_json),
    operations_json: undefined,
  }));
  const listings = db.prepare(`
    SELECT id,marketplace,ka_id,external_id,ka_link,price_cents,status,posted_at,expired_at,
           payload_json,last_seen_at,missing_checks,remote_status,alerted_state,
           pending_event_json,created_at
    FROM ka_listings WHERE asset_id=? ORDER BY id DESC
  `).all(id).map(row => {
    const allSnapshots = db.prepare(`
      SELECT price_cents,views,recorded_at
      FROM ka_snapshots
      WHERE listing_id=?
      ORDER BY recorded_at,id
    `).all(row.id);
    const snapshots = allSnapshots.slice(-100);
    return {
      ...row,
      payload: parseJson(row.payload_json),
      pending_event: parseJson(row.pending_event_json),
      snapshots,
      snapshots_truncated: allSnapshots.length > snapshots.length,
      performance: summarizeListingPerformance(row, allSnapshots),
      payload_json: undefined,
      pending_event_json: undefined,
    };
  });
  return {
    asset: {
      ...asset,
      image_paths: parseJson(asset.image_paths, []),
      last_listing_payload: parseJson(asset.last_listing_payload_json),
      last_listing_payload_json: undefined,
    },
    images,
    listings,
  };
}

function getAssetBundleByKaId(kaId) {
  return getAssetBundleByExternalId("kleinanzeigen", kaId);
}

function getAssetBundleByExternalId(marketplace, externalId) {
  const normalizedMarketplace = String(marketplace || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(normalizedMarketplace)) {
    throw new Error("marketplace ist ungültig.");
  }
  const normalized = String(externalId ?? "").trim();
  if (!normalized) return null;
  const row = getDb().prepare(`
    SELECT asset_id
    FROM ka_listings
    WHERE marketplace=? AND COALESCE(external_id,ka_id)=?
    ORDER BY id DESC
    LIMIT 1
  `).get(normalizedMarketplace, normalized);
  return row ? getAssetBundle(row.asset_id) : null;
}

function recordListingEdit(adId, changes, {
  marketplace = "kleinanzeigen",
  now = new Date().toISOString(),
} = {}) {
  const normalizedMarketplace = String(marketplace || "").trim().toLowerCase();
  const normalizedAdId = String(adId || "").trim();
  const normalizedTitle = changes?.title === undefined
    ? null
    : String(changes.title || "").trim();
  const normalizedDescription = changes?.description === undefined
    ? null
    : String(changes.description || "").trim();
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(normalizedMarketplace)) {
    throw new Error("marketplace ist ungültig.");
  }
  if (!/^\d+$/.test(normalizedAdId)) throw new Error("adId ist ungültig.");
  if (normalizedTitle !== null && (!normalizedTitle || normalizedTitle.length > 65)) {
    throw new Error("title ist ungültig.");
  }
  if (
    normalizedDescription !== null
    && (!normalizedDescription || normalizedDescription.length > 4000)
  ) {
    throw new Error("description ist ungültig.");
  }
  if (normalizedTitle === null && normalizedDescription === null) {
    throw new Error("Mindestens eine Anzeigenänderung ist erforderlich.");
  }

  const db = getDb();
  return db.transaction(() => {
    const listing = db.prepare(`
      SELECT l.id,l.asset_id,l.payload_json,a.last_listing_payload_json
      FROM ka_listings l
      JOIN assets a ON a.id=l.asset_id
      WHERE l.marketplace=? AND COALESCE(l.external_id,l.ka_id)=?
      LIMIT 1
    `).get(normalizedMarketplace, normalizedAdId);
    if (!listing) return { tracked: false, assetId: null };

    const payload = parseJson(listing.payload_json)
      || parseJson(listing.last_listing_payload_json)
      || {};
    if (normalizedTitle !== null) payload.title = normalizedTitle;
    if (normalizedDescription !== null) payload.description = normalizedDescription;
    const serializedPayload = JSON.stringify(payload);
    db.prepare(`
      UPDATE ka_listings
      SET payload_json=?,last_seen_at=?,missing_checks=0
      WHERE id=?
    `).run(serializedPayload, now, listing.id);
    db.prepare(`
      UPDATE assets
      SET listing_name=COALESCE(?,listing_name),
          description=COALESCE(?,description),
          last_listing_payload_json=?,updated_at=?
      WHERE id=?
    `).run(
      normalizedTitle,
      normalizedDescription,
      serializedPayload,
      now,
      listing.asset_id
    );
    return { tracked: true, assetId: listing.asset_id };
  })();
}

function normalizeRemoteStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (/(?:remove|delete|gelöscht)/.test(status)) return "removed";
  if (/(?:expire|abgelaufen)/.test(status)) return "expired";
  if (/(?:pause|inactive|deactiv|inaktiv|pausiert)/.test(status)) return "paused";
  return "active";
}

function remotePriceCents(ad) {
  const value = ad?.price?.amount ?? ad?.priceAmount ?? ad?.price;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  // Public and own-ad normalizers expose whole EUR. Raw payloads may expose cents.
  return Math.round(parsed * 100);
}

function reconcileRemoteListings(
  remoteAds,
  {
    marketplace = "kleinanzeigen",
    missingThreshold = 2,
    assetIds = null,
    now = new Date().toISOString(),
  } = {}
) {
  if (!Array.isArray(remoteAds)) throw new Error("remoteAds muss eine Liste sein.");
  const normalizedMarketplace = String(marketplace || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(normalizedMarketplace)) {
    throw new Error("marketplace ist ungültig.");
  }
  const threshold = Number(missingThreshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) {
    throw new Error("missingThreshold muss zwischen 1 und 10 liegen.");
  }
  const targetedAssetIds = assetIds === null
    ? null
    : new Set((Array.isArray(assetIds) ? assetIds : []).map(Number));
  if (
    targetedAssetIds
    && (
      targetedAssetIds.size === 0
      || [...targetedAssetIds].some(id => !Number.isInteger(id) || id < 1)
    )
  ) {
    throw new Error("assetIds muss eine nicht-leere Liste gültiger Asset-IDs sein.");
  }
  const remoteById = new Map(
    remoteAds
      .filter(ad => ad && ad.id !== undefined && ad.id !== null)
      .map(ad => [String(ad.id), ad])
  );
  const db = getDb();
  const eventRows = db.transaction(() => {
    const listings = db.prepare(`
      SELECT l.id,l.asset_id,l.ka_id,COALESCE(l.external_id,l.ka_id) AS external_id,
             l.status,l.missing_checks,l.alerted_state,
             l.pending_event_json,l.price_cents,l.payload_json,a.last_listing_payload_json,
             a.listing_name,a.last_price_cents
      FROM ka_listings l
      JOIN assets a ON a.id=l.asset_id
      WHERE l.marketplace=? AND COALESCE(l.external_id,l.ka_id) IS NOT NULL
    `).all(normalizedMarketplace).filter(
      listing => !targetedAssetIds || targetedAssetIds.has(Number(listing.asset_id))
    );
    const queueEvent = (listing, event, eventKey) => {
      const pending = parseJson(listing.pending_event_json);
      if (listing.alerted_state === eventKey || pending?.eventKey === eventKey) return;
      const queued = JSON.stringify({ ...event, eventKey });
      db.prepare("UPDATE ka_listings SET pending_event_json=? WHERE id=?")
        .run(queued, listing.id);
      listing.pending_event_json = queued;
    };
    for (const listing of listings) {
      const remote = remoteById.get(String(listing.external_id));
      if (remote) {
        const remoteStatus = normalizeRemoteStatus(remote.status);
        const eventState = remoteStatus === "active" ? null : `remote_${remoteStatus}`;
        const pendingBefore = parseJson(listing.pending_event_json);
        const isRecoveryEventKey = value => (
          value === "missing_remote"
          || ["remote_paused", "remote_expired", "remote_removed"].includes(value)
        );
        const recoveredToActive = remoteStatus === "active" && (
          listing.status !== "active"
          || isRecoveryEventKey(listing.alerted_state)
          || isRecoveryEventKey(pendingBefore?.eventKey)
        );
        if (recoveredToActive) {
          const nextAlertedState = isRecoveryEventKey(listing.alerted_state)
            ? null
            : listing.alerted_state;
          const nextPending = isRecoveryEventKey(pendingBefore?.eventKey)
            ? null
            : listing.pending_event_json;
          db.prepare(`
            UPDATE ka_listings
            SET alerted_state=?, pending_event_json=?
            WHERE id=?
          `).run(nextAlertedState, nextPending, listing.id);
          listing.alerted_state = nextAlertedState;
          listing.pending_event_json = nextPending;
        }
        const priceCents = remotePriceCents(remote);
        const payload = parseJson(listing.payload_json)
          || parseJson(listing.last_listing_payload_json)
          || {};
        const changes = {};
        const remoteTitle = String(remote.title || "").trim();
        if (remoteStatus === "active" && remoteTitle && payload.title && remoteTitle !== payload.title) {
          changes.title = { from: payload.title, to: remoteTitle };
          payload.title = remoteTitle;
        } else if (remoteTitle && !payload.title) {
          payload.title = remoteTitle;
        }
        if (
          remoteStatus === "active"
          && priceCents !== null
          && listing.price_cents !== null
          && Number.isFinite(Number(listing.price_cents))
          && priceCents !== Number(listing.price_cents)
        ) {
          changes.price = {
            from: Number(listing.price_cents) / 100,
            to: priceCents / 100,
          };
          payload.price = priceCents / 100;
        } else if (priceCents !== null && !Number.isFinite(Number(payload.price))) {
          payload.price = priceCents / 100;
        }
        db.prepare(`
          UPDATE ka_listings
          SET status=?, last_seen_at=?, missing_checks=0, remote_status=?,
              price_cents=COALESCE(?,price_cents),payload_json=?
          WHERE id=?
        `).run(
          remoteStatus,
          now,
          String(remote.status || "active"),
          priceCents,
          JSON.stringify(payload),
          listing.id
        );
        db.prepare(`
          UPDATE assets
          SET listing_name=COALESCE(?,listing_name),
              last_price_cents=COALESCE(?,last_price_cents),
              last_listing_payload_json=?,
              updated_at=?
          WHERE id=?
        `).run(
          remoteTitle || null,
          priceCents,
          JSON.stringify(payload),
          now,
          listing.asset_id
        );
        if (remoteStatus !== "active" && listing.alerted_state !== eventState) {
          queueEvent(listing, {
            type: "remote_status",
            listingId: listing.id,
            assetId: listing.asset_id,
            ...(normalizedMarketplace !== "kleinanzeigen" ? { marketplace: normalizedMarketplace } : {}),
            ...(normalizedMarketplace !== "kleinanzeigen"
              ? { externalId: String(listing.external_id) }
              : {}),
            ...(normalizedMarketplace === "kleinanzeigen" ? { kaId: String(listing.external_id) } : {}),
            status: remoteStatus,
          }, eventState);
        }
        if (remoteStatus === "active" && Object.keys(changes).length) {
          const changeKey = crypto
            .createHash("sha256")
            .update(JSON.stringify(changes))
            .digest("hex")
            .slice(0, 12);
          queueEvent(listing, {
            type: "remote_changed",
            listingId: listing.id,
            assetId: listing.asset_id,
            ...(normalizedMarketplace !== "kleinanzeigen" ? { marketplace: normalizedMarketplace } : {}),
            ...(normalizedMarketplace !== "kleinanzeigen"
              ? { externalId: String(listing.external_id) }
              : {}),
            ...(normalizedMarketplace === "kleinanzeigen" ? { kaId: String(listing.external_id) } : {}),
            status: "active",
            changes,
          }, `remote_changed:${changeKey}`);
        }

        const views = Number.isFinite(Number(remote.views)) ? Number(remote.views) : null;
        if (priceCents !== null || views !== null) {
          const latest = db.prepare(`
            SELECT price_cents,views FROM ka_snapshots
            WHERE listing_id=? ORDER BY id DESC LIMIT 1
          `).get(listing.id);
          if (!latest || latest.price_cents !== priceCents || latest.views !== views) {
            db.prepare(`
              INSERT INTO ka_snapshots (listing_id,price_cents,views,recorded_at)
              VALUES (?,?,?,?)
            `).run(listing.id, priceCents, views, now);
          }
        }
        continue;
      }

      if (!["active", "needs_review"].includes(listing.status)) continue;
      const missingChecks = Number(listing.missing_checks || 0) + 1;
      if (missingChecks < threshold) {
        db.prepare("UPDATE ka_listings SET missing_checks=? WHERE id=?")
          .run(missingChecks, listing.id);
        continue;
      }
      const eventState = "missing_remote";
      db.prepare(`
        UPDATE ka_listings
        SET status='needs_review', missing_checks=?, remote_status='missing'
        WHERE id=?
      `).run(missingChecks, listing.id);
      if (listing.alerted_state !== eventState) {
        queueEvent(listing, {
          type: "missing_remote",
          listingId: listing.id,
          assetId: listing.asset_id,
          ...(normalizedMarketplace !== "kleinanzeigen" ? { marketplace: normalizedMarketplace } : {}),
          ...(normalizedMarketplace !== "kleinanzeigen"
            ? { externalId: String(listing.external_id) }
            : {}),
          ...(normalizedMarketplace === "kleinanzeigen" ? { kaId: String(listing.external_id) } : {}),
          status: "needs_review",
          missingChecks,
        }, eventState);
      }
    }

    const touchedAssetIds = [...new Set(listings.map(row => row.asset_id))];
    const activeCount = db.prepare(`
      SELECT COUNT(*) AS count FROM ka_listings WHERE asset_id=? AND status='active'
    `);
    const updateAsset = db.prepare(`
      UPDATE assets
      SET has_active_listing=?, updated_at=?
      WHERE id=?
    `);
    for (const assetId of touchedAssetIds) {
      updateAsset.run(activeCount.get(assetId).count > 0 ? 1 : 0, now, assetId);
    }
    return db.prepare(`
      SELECT pending_event_json
      FROM ka_listings
      WHERE marketplace=? AND pending_event_json IS NOT NULL
      ORDER BY id
    `).all(normalizedMarketplace).map(row => parseJson(row.pending_event_json)).filter(Boolean);
  })();

  return {
    checkedAt: now,
    remoteCount: remoteById.size,
    events: eventRows.map(event => ({
      ...event,
      bundle: getAssetBundle(event.assetId),
    })),
  };
}

function acknowledgeLifecycleEvent(listingId, eventKey) {
  const id = Number(listingId);
  if (!Number.isInteger(id) || id < 1) throw new Error("listingId ist ungültig.");
  const key = String(eventKey || "");
  if (!key) throw new Error("eventKey fehlt.");
  const db = getDb();
  const row = db.prepare("SELECT pending_event_json FROM ka_listings WHERE id=?").get(id);
  if (!row) throw new Error(`Listing ${id} nicht gefunden.`);
  const pending = parseJson(row.pending_event_json);
  if (!pending) return { acknowledged: false, reason: "no-pending-event" };
  if (pending.eventKey !== key) {
    throw new Error(`Lifecycle-Ereignis für Listing ${id} wurde inzwischen ersetzt.`);
  }
  const result = db.prepare(`
    UPDATE ka_listings
    SET pending_event_json=NULL, alerted_state=?
    WHERE id=?
  `).run(key, id);
  return { acknowledged: result.changes === 1, listingId: id, eventKey: key };
}

function close() {
  if (_db) _db.close();
  _db = null;
}

// Host-state modules use the same WAL connection so a media rename/database
// insert or operation-state transition can be coordinated without a second
// schema implementation. Agent-facing SQL cannot write either table.
function databaseForHostState() {
  return getDb();
}

module.exports = {
  close,
  databaseForHostState,
  acknowledgeLifecycleEvent,
  deleteUnlinkedAsset,
  getAssetBundle,
  getAssetBundleByExternalId,
  getAssetBundleByKaId,
  normalizeRemoteStatus,
  query,
  reconcileRemoteListings,
  recordListingEdit,
  replaceAssetImages,
  validateSql,
};
