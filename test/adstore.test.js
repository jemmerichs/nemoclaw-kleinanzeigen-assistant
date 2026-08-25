"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-db-"));
process.env.NEMOCLAW_DB_PATH = path.join(directory, "test.db");
process.env.NEMOCLAW_IMAGE_DIR = path.join(directory, "images");
const store = require("../tools/adstore");
const image = require("../tools/image");

test.after(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("store initializes the complete asset schema and supports safe writes", () => {
  const inserted = store.query({
    sql: "INSERT INTO assets (name, ka_draft_id, image_paths) VALUES (?,?,?)",
    params: ["Bike", "draft-1", "[]"],
  });
  assert.equal(inserted.lastInsertRowid, 1);
  const rows = store.query({ sql: "SELECT name, ka_draft_id, image_paths FROM assets WHERE id=?", params: [1] });
  assert.deepEqual(rows, [{ name: "Bike", ka_draft_id: "draft-1", image_paths: "[]" }]);

  const updated = store.query({ sql: "UPDATE assets SET status=? WHERE id=?", params: ["sold", 1] });
  assert.equal(updated.changes, 1);
  assert.equal(fs.statSync(process.env.NEMOCLAW_DB_PATH).mode & 0o777, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const file = `${process.env.NEMOCLAW_DB_PATH}${suffix}`;
    if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("store blocks destructive, administrative, commented, and multi-statement SQL", () => {
  for (const sql of [
    "DELETE FROM assets",
    "DROP TABLE assets",
    "PRAGMA table_info(assets)",
    "SELECT 1; UPDATE assets SET status='sold'",
    "-- harmless\nSELECT 1",
    "WITH row AS (SELECT 1) UPDATE assets SET status='sold'",
    "UPDATE assets SET status='sold'",
    "INSERT INTO sqlite_master (type) VALUES ('table')",
  ]) {
    assert.throws(() => store.query({ sql }), /erlaubt|nur ein|nur für lesende/i, sql);
  }
});

test("specialized cleanup deletes only assets without draft or listing history", () => {
  const { deleteUnlinkedAsset } = store;
  const removable = store.query({
    sql: "INSERT INTO assets (name) VALUES (?)",
    params: ["Removable"],
  }).lastInsertRowid;
  assert.deepEqual(deleteUnlinkedAsset(removable), {
    deletedAssetId: removable,
    name: "Removable",
    changes: 1,
  });
  assert.equal(store.query({
    sql: "SELECT COUNT(*) AS count FROM assets WHERE id=?",
    params: [removable],
  })[0].count, 0);

  const withDraft = store.query({
    sql: "INSERT INTO assets (name,ka_draft_id) VALUES (?,?)",
    params: ["Draft linked", "draft-locked"],
  }).lastInsertRowid;
  assert.throws(() => deleteUnlinkedAsset(withDraft), /Entwurf oder einer Anzeigenhistorie/);

  const withHistory = store.query({
    sql: "INSERT INTO assets (name) VALUES (?)",
    params: ["History linked"],
  }).lastInsertRowid;
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status) VALUES (?,?,?)",
    params: [withHistory, "history-1", "removed"],
  });
  assert.throws(() => deleteUnlinkedAsset(withHistory), /Entwurf oder einer Anzeigenhistorie/);
});

test("asset bundle preserves canonical listing data and ordered image provenance", () => {
  const firstPath = image.saveTemp(Buffer.from("first-photo"));
  const secondPath = image.saveTemp(Buffer.from("second-photo"));
  const payload = {
    title: "Canonical title",
    description: "Canonical description",
    categoryId: 278,
    price: 42,
    priceType: "NEGOTIABLE",
    imagePaths: [secondPath, firstPath],
  };
  const assetId = store.query({
    sql: "INSERT INTO assets (name,image_paths,last_listing_payload_json) VALUES (?,?,?)",
    params: ["Canonical asset", JSON.stringify(payload.imagePaths), JSON.stringify(payload)],
  }).lastInsertRowid;

  const provenance = store.replaceAssetImages(assetId, payload.imagePaths);
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status,payload_json) VALUES (?,?,?,?)",
    params: [assetId, "canonical-1", "active", JSON.stringify(payload)],
  });
  const bundle = store.getAssetBundle(assetId);

  assert.deepEqual(bundle.asset.last_listing_payload, payload);
  assert.deepEqual(bundle.asset.image_paths, [secondPath, firstPath]);
  assert.deepEqual(bundle.images.map(row => row.image_path), [secondPath, firstPath]);
  assert.deepEqual(bundle.images.map(row => row.position), [0, 1]);
  assert.deepEqual(bundle.images.map(row => row.kind), ["original", "original"]);
  assert.deepEqual(bundle.images.map(row => row.output_sha256), provenance.map(row => row.outputSha256));
  assert.deepEqual(bundle.listings[0].payload, payload);
  assert.equal(store.getAssetBundleByKaId("canonical-1").asset.id, assetId);
  assert.equal(store.getAssetBundleByKaId("unknown-ka-id"), null);
});

test("confirmed live-ad edits update the canonical local title and description", () => {
  const payload = {
    title: "Alter Titel",
    description: "Alte Beschreibung",
    categoryId: 87,
    price: 6,
  };
  const assetId = store.query({
    sql: "INSERT INTO assets (name,listing_name,description,last_listing_payload_json) VALUES (?,?,?,?)",
    params: ["Tracked edit", payload.title, payload.description, JSON.stringify(payload)],
  }).lastInsertRowid;
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,external_id,status,payload_json) VALUES (?,?,?,?,?)",
    params: [assetId, "3487180022", "3487180022", "active", JSON.stringify(payload)],
  });

  assert.deepEqual(store.recordListingEdit("3487180022", {
    title: "Neuer Titel",
    description: "Neue Beschreibung",
  }, { now: "2026-08-17T12:00:00.000Z" }), {
    tracked: true,
    assetId,
  });
  const bundle = store.getAssetBundle(assetId);
  assert.equal(bundle.asset.listing_name, "Neuer Titel");
  assert.equal(bundle.asset.description, "Neue Beschreibung");
  assert.equal(bundle.asset.last_listing_payload.title, "Neuer Titel");
  assert.equal(bundle.asset.last_listing_payload.description, "Neue Beschreibung");
  assert.equal(bundle.listings[0].payload.title, "Neuer Titel");
  assert.equal(bundle.listings[0].payload.description, "Neue Beschreibung");
  store.query({
    sql: "UPDATE ka_listings SET status='removed' WHERE external_id=?",
    params: ["3487180022"],
  });
});

test("remote reconciliation tolerates one miss, alerts once after two, and recovers", () => {
  store.query({
    sql: "UPDATE ka_listings SET status='removed' WHERE ka_id=?",
    params: ["canonical-1"],
  });
  const payload = {
    title: "Lifecycle item",
    description: "Stored for relisting",
    categoryId: 278,
    price: 30,
    priceType: "FIXED",
    imagePaths: [],
  };
  const assetId = store.query({
    sql: "INSERT INTO assets (name,has_active_listing,last_listing_payload_json) VALUES (?,?,?)",
    params: ["Lifecycle asset", 1, JSON.stringify(payload)],
  }).lastInsertRowid;
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status,payload_json) VALUES (?,?,?,?)",
    params: [assetId, "life-1", "active", JSON.stringify(payload)],
  });

  const visible = store.reconcileRemoteListings([{
    id: "life-1",
    status: "active",
    price: 30,
    views: 12,
  }], { now: "2026-07-28T10:00:00.000Z" });
  assert.equal(visible.events.length, 0);
  assert.equal(store.query({
    sql: "SELECT COUNT(*) AS count FROM ka_snapshots",
  })[0].count > 0, true);

  const firstMiss = store.reconcileRemoteListings([], { now: "2026-07-28T11:00:00.000Z" });
  assert.equal(firstMiss.events.length, 0);
  assert.deepEqual(store.query({
    sql: "SELECT status,missing_checks FROM ka_listings WHERE ka_id=?",
    params: ["life-1"],
  })[0], { status: "active", missing_checks: 1 });

  const secondMiss = store.reconcileRemoteListings([], { now: "2026-07-28T12:00:00.000Z" });
  assert.equal(secondMiss.events.length, 1);
  assert.equal(secondMiss.events[0].type, "missing_remote");
  assert.equal(secondMiss.events[0].eventKey, "missing_remote");
  assert.equal(secondMiss.events[0].bundle.asset.last_listing_payload.title, "Lifecycle item");
  const pendingMissingRow = store.query({
    sql: "SELECT status,missing_checks,alerted_state,pending_event_json FROM ka_listings WHERE ka_id=?",
    params: ["life-1"],
  })[0];
  assert.equal(pendingMissingRow.status, "needs_review");
  assert.equal(pendingMissingRow.missing_checks, 2);
  assert.equal(pendingMissingRow.alerted_state, null);
  assert.equal(JSON.parse(pendingMissingRow.pending_event_json).eventKey, "missing_remote");
  assert.equal(store.getAssetBundle(assetId).asset.has_active_listing, 0);

  const thirdMiss = store.reconcileRemoteListings([], { now: "2026-07-28T13:00:00.000Z" });
  assert.equal(thirdMiss.events.length, 1);
  assert.equal(thirdMiss.events[0].eventKey, "missing_remote");
  assert.deepEqual(
    store.acknowledgeLifecycleEvent(thirdMiss.events[0].listingId, thirdMiss.events[0].eventKey),
    {
      acknowledged: true,
      listingId: thirdMiss.events[0].listingId,
      eventKey: "missing_remote",
    }
  );
  const acknowledgedMiss = store.reconcileRemoteListings([], { now: "2026-07-28T13:30:00.000Z" });
  assert.equal(acknowledgedMiss.events.length, 0);

  const recovered = store.reconcileRemoteListings([{
    id: "life-1",
    status: "active",
    price: 30,
    views: 13,
  }], { now: "2026-07-28T14:00:00.000Z" });
  assert.equal(recovered.events.length, 0);
  assert.deepEqual(store.query({
    sql: "SELECT status,missing_checks,alerted_state FROM ka_listings WHERE ka_id=?",
    params: ["life-1"],
  })[0], {
    status: "active",
    missing_checks: 0,
    alerted_state: null,
  });
  assert.equal(store.getAssetBundle(assetId).asset.has_active_listing, 1);

  const manualChange = store.reconcileRemoteListings([{
    id: "life-1",
    status: "active",
    title: "Lifecycle item – manuell geändert",
    price: 27,
    views: 14,
  }], { now: "2026-07-28T15:00:00.000Z" });
  assert.equal(manualChange.events.length, 1);
  assert.equal(manualChange.events[0].type, "remote_changed");
  assert.deepEqual(manualChange.events[0].changes.price, { from: 30, to: 27 });
  const changedBundle = store.getAssetBundle(assetId);
  assert.equal(changedBundle.asset.listing_name, "Lifecycle item – manuell geändert");
  assert.equal(changedBundle.asset.last_price_cents, 2700);
  assert.equal(changedBundle.asset.last_listing_payload.title, "Lifecycle item – manuell geändert");
  assert.equal(changedBundle.asset.last_listing_payload.price, 27);
  assert.equal(changedBundle.listings[0].payload.price, 27);
  assert.equal(
    store.acknowledgeLifecycleEvent(
      manualChange.events[0].listingId,
      manualChange.events[0].eventKey
    ).acknowledged,
    true
  );

  const unchangedAgain = store.reconcileRemoteListings([{
    id: "life-1",
    status: "active",
    title: "Lifecycle item – manuell geändert",
    price: 27,
    views: 14,
  }], { now: "2026-07-28T16:00:00.000Z" });
  assert.equal(unchangedAgain.events.length, 0);

  const performance = store.getAssetBundle(assetId).listings[0];
  assert.deepEqual(performance.snapshots, [
    { price_cents: 3000, views: 12, recorded_at: "2026-07-28T10:00:00.000Z" },
    { price_cents: 3000, views: 13, recorded_at: "2026-07-28T14:00:00.000Z" },
    { price_cents: 2700, views: 14, recorded_at: "2026-07-28T15:00:00.000Z" },
  ]);
  assert.deepEqual(performance.performance, {
    snapshot_count: 3,
    first_observed_at: "2026-07-28T10:00:00.000Z",
    last_metric_change_at: "2026-07-28T15:00:00.000Z",
    last_checked_at: "2026-07-28T16:00:00.000Z",
    initial_price_cents: 3000,
    current_price_cents: 2700,
    price_delta_cents: -300,
    initial_views: 12,
    current_views: 14,
    view_delta: 2,
    last_price_change_at: "2026-07-28T15:00:00.000Z",
    last_view_change_at: "2026-07-28T15:00:00.000Z",
  });
});

test("a user-reported missing ad can be reconciled once without touching other assets", () => {
  const firstAssetId = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Reported missing", 1],
  }).lastInsertRowid;
  const secondAssetId = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Unrelated active", 1],
  }).lastInsertRowid;
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status) VALUES (?,?,?)",
    params: [firstAssetId, "reported-missing-1", "active"],
  });
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status) VALUES (?,?,?)",
    params: [secondAssetId, "unrelated-active-1", "active"],
  });

  const result = store.reconcileRemoteListings([], {
    missingThreshold: 1,
    assetIds: [firstAssetId],
    now: "2026-08-25T10:00:00.000Z",
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].assetId, firstAssetId);
  assert.deepEqual(store.query({
    sql: "SELECT status,missing_checks FROM ka_listings WHERE ka_id=?",
    params: ["reported-missing-1"],
  })[0], { status: "needs_review", missing_checks: 1 });
  assert.deepEqual(store.query({
    sql: "SELECT status,missing_checks FROM ka_listings WHERE ka_id=?",
    params: ["unrelated-active-1"],
  })[0], { status: "active", missing_checks: 0 });
  assert.equal(store.acknowledgeLifecycleEvent(
    result.events[0].listingId,
    result.events[0].eventKey
  ).acknowledged, true);
});

test("explicit paused and removed states alert, do not become false misses, and can recover", () => {
  store.query({
    sql: "UPDATE ka_listings SET status='removed' WHERE status IN ('active','needs_review')",
  });
  const createTracked = (name, kaId) => {
    const assetId = store.query({
      sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
      params: [name, 1],
    }).lastInsertRowid;
    store.query({
      sql: "INSERT INTO ka_listings (asset_id,ka_id,status,price_cents) VALUES (?,?,?,?)",
      params: [assetId, kaId, "active", 2000],
    });
    return assetId;
  };

  const pausedAssetId = createTracked("Paused lifecycle", "paused-1");
  const paused = store.reconcileRemoteListings([{
    id: "paused-1",
    status: "PAUSED",
    price: 20,
    views: 5,
  }], { now: "2026-07-28T17:00:00.000Z" });
  assert.equal(paused.events.length, 1);
  assert.equal(paused.events[0].type, "remote_status");
  assert.equal(paused.events[0].status, "paused");
  assert.deepEqual(store.query({
    sql: "SELECT status,missing_checks,pending_event_json FROM ka_listings WHERE ka_id=?",
    params: ["paused-1"],
  })[0], {
    status: "paused",
    missing_checks: 0,
    pending_event_json: JSON.stringify({
      type: "remote_status",
      listingId: paused.events[0].listingId,
      assetId: pausedAssetId,
      kaId: "paused-1",
      status: "paused",
      eventKey: "remote_paused",
    }),
  });
  assert.equal(store.getAssetBundle(pausedAssetId).asset.has_active_listing, 0);

  const recovered = store.reconcileRemoteListings([{
    id: "paused-1",
    status: "ACTIVE",
    price: 20,
    views: 6,
  }], { now: "2026-07-28T18:00:00.000Z" });
  assert.equal(recovered.events.length, 0);
  assert.deepEqual(store.query({
    sql: "SELECT status,alerted_state,pending_event_json FROM ka_listings WHERE ka_id=?",
    params: ["paused-1"],
  })[0], {
    status: "active",
    alerted_state: null,
    pending_event_json: null,
  });
  assert.equal(store.getAssetBundle(pausedAssetId).asset.has_active_listing, 1);

  const pausedAgain = store.reconcileRemoteListings([{
    id: "paused-1",
    status: "INACTIVE",
    price: 20,
    views: 6,
  }], { now: "2026-07-28T19:00:00.000Z" });
  assert.equal(pausedAgain.events[0].eventKey, "remote_paused");
  assert.equal(
    store.acknowledgeLifecycleEvent(
      pausedAgain.events[0].listingId,
      pausedAgain.events[0].eventKey
    ).acknowledged,
    true
  );
  const absentPaused = store.reconcileRemoteListings([], {
    now: "2026-07-28T20:00:00.000Z",
  });
  assert.equal(absentPaused.events.length, 0);
  assert.equal(store.query({
    sql: "SELECT missing_checks FROM ka_listings WHERE ka_id=?",
    params: ["paused-1"],
  })[0].missing_checks, 0);

  const removedAssetId = createTracked("Removed lifecycle", "removed-1");
  const removed = store.reconcileRemoteListings([{
    id: "removed-1",
    status: "DELETED",
    price: 20,
  }], { now: "2026-07-28T21:00:00.000Z" });
  assert.equal(removed.events.length, 1);
  assert.equal(removed.events[0].status, "removed");
  assert.equal(removed.events[0].eventKey, "remote_removed");
  assert.equal(store.getAssetBundle(removedAssetId).asset.has_active_listing, 0);
});

test("marketplace reconciliation does not leak pending Vinted events into Kleinanzeigen checks", () => {
  const assetId = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Vinted lifecycle isolation", 1],
  }).lastInsertRowid;
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,external_id,status,marketplace) VALUES (?,?,?,?)",
    params: [assetId, "vinted-isolated-1", "active", "vinted"],
  });
  store.reconcileRemoteListings([], {
    marketplace: "vinted",
    now: "2026-07-29T10:00:00.000Z",
  });
  const vinted = store.reconcileRemoteListings([], {
    marketplace: "vinted",
    now: "2026-07-29T11:00:00.000Z",
  });
  assert.equal(vinted.events.some(event => event.marketplace === "vinted"), true);

  const kleinanzeigen = store.reconcileRemoteListings([], {
    marketplace: "kleinanzeigen",
    now: "2026-07-29T12:00:00.000Z",
  });
  assert.equal(kleinanzeigen.events.some(event => event.marketplace === "vinted"), false);
});
