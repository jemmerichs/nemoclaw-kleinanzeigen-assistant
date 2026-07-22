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
});

test("store blocks destructive, administrative, commented, and multi-statement SQL", () => {
  for (const sql of [
    "DELETE FROM assets",
    "DROP TABLE assets",
    "PRAGMA table_info(assets)",
    "SELECT 1; UPDATE assets SET status='sold'",
    "-- harmless\nSELECT 1",
    "WITH row AS (SELECT 1) UPDATE assets SET status='sold'",
  ]) {
    assert.throws(() => store.query({ sql }), /erlaubt|nur ein|nur für lesende/i, sql);
  }
});
