"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-db-"));
process.env.NEMOCLAW_DB_PATH = path.join(directory, "test.db");
const store = require("../tools/adstore");

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
