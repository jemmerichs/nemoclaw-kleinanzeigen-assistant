"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-"));
process.env.NEMOCLAW_SESSION_FILE = path.join(directory, "sessions.json");
process.env.NEMOCLAW_PENDING_FILE = path.join(directory, "pending.json");
process.env.NEMOCLAW_STATE_FILE = path.join(directory, "state.json");
process.env.NEMOCLAW_DB_PATH = path.join(directory, "ads.db");
process.env.NEMOCLAW_MODE = "dry-run";

const store = require("../tools/adstore");
const { getPending, runAgent, stagePending } = require("../workspace/agent");

test.after(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("protected model action is staged exactly and Go is consumed once", async () => {
  const sent = [];
  const gateway = {
    async send(_chatId, text) { sent.push(text); },
    async sendPhoto() {},
  };
  const llmClient = {
    model: "stub",
    async complete() {
      return {
        message: {
          role: "assistant",
          content: "Ich habe einen vollständigen Vorschlag vorbereitet.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "ka_create_ad",
              arguments: JSON.stringify({
                title: "Testartikel",
                description: "Ehrlicher Testtext",
                categoryId: 278,
                price: 10,
                priceType: "FIXED",
                zipCode: "80636",
                locationId: "16360",
                contactName: "Jannik",
                imagePaths: [],
              }),
            },
          }],
        },
        usage: { totalTokens: 1, costUsd: 0 },
      };
    },
  };

  const stagedResult = await runAgent("42", "Bereite die Anzeige vor.", { llmClient, gateway });
  const pending = getPending("42");
  assert.equal(pending.tool, "ka_create_ad");
  assert.equal(pending.args.title, "Testartikel");
  assert.match(sent[0], /Aktion [a-f0-9]{12}/);
  assert.match(sent[0], /Dry-run ist aktiv/);
  assert.equal(stagedResult.route.tier, "fast");
  assert.deepEqual(stagedResult.toolCalls, ["ka_create_ad"]);
  assert.equal(stagedResult.toolTrace[0].staged, true);

  await runAgent("42", "Go", { llmClient, gateway });
  assert.equal(getPending("42"), null);
  assert.match(sent[1], /dry-run-Modus blockiert/);
  assert.match(sent[1], /nicht ausgeführt/);

  await runAgent("42", "Go", { llmClient, gateway });
  assert.match(sent[2], /keine aktuelle/);
});

test("any non-cancel command invalidates an older approval", async () => {
  const sent = [];
  const gateway = { async send(_chatId, text) { sent.push(text); } };
  const llmClient = {
    model: "stub",
    usageSummary() {
      return {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        dailyBudgetUsd: 1,
      };
    },
    async complete() {
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-2",
            type: "function",
            function: {
              name: "inventory_mark_sold",
              arguments: JSON.stringify({ assetId: 1, soldPriceEur: 10 }),
            },
          }],
        },
      };
    },
  };
  await runAgent("status-clears", "Bereite es vor.", { llmClient, gateway });
  assert.ok(getPending("status-clears"));
  await runAgent("status-clears", "/status", { llmClient, gateway });
  assert.equal(getPending("status-clears"), null);
  await runAgent("status-clears", "Go", { llmClient, gateway });
  assert.match(sent.at(-1), /keine aktuelle/);
});

test("Go rejects a pending payload changed after its fingerprint was created", async () => {
  const sent = [];
  const gateway = { async send(_chatId, text) { sent.push(text); } };
  const action = stagePending("tampered", "inventory_mark_sold", {
    assetId: 999,
    soldPriceEur: 1,
  });
  action.args.soldPriceEur = 100;

  await runAgent("tampered", "Go", { llmClient: null, gateway });
  assert.equal(getPending("tampered"), null);
  assert.match(sent[0], /seit der Anzeige verändert/);
  assert.equal(store.query({ sql: "SELECT COUNT(*) AS count FROM assets" })[0].count, 0);
});

test("marking an asset sold locally preserves a still-active external listing", () => {
  const inserted = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Verkauftes Testobjekt", 1],
  });
  store.query({
    sql: "INSERT INTO ka_listings (asset_id,ka_id,status) VALUES (?,?,?)",
    params: [inserted.lastInsertRowid, "123456", "active"],
  });

  const result = require("../workspace/agent").TOOLS.inventory_mark_sold.fn({
    assetId: inserted.lastInsertRowid,
    soldPriceEur: 12.5,
  });
  assert.equal(result.activeExternalListings, 1);
  const asset = store.query({
    sql: "SELECT status,has_active_listing,sold_price_cents FROM assets WHERE id=?",
    params: [inserted.lastInsertRowid],
  })[0];
  assert.deepEqual(asset, { status: "sold", has_active_listing: 1, sold_price_cents: 1250 });
  const listing = store.query({
    sql: "SELECT status FROM ka_listings WHERE asset_id=?",
    params: [inserted.lastInsertRowid],
  })[0];
  assert.equal(listing.status, "active");
});

test("saving a draft for an existing asset preserves its active-listing flag", () => {
  const inserted = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Aktiver Artikel mit neuem Entwurf", 1],
  });
  require("../workspace/agent").ensureAssetForListing({
    assetId: inserted.lastInsertRowid,
    title: "Überarbeiteter Titel",
    description: "Noch nicht veröffentlicht",
    imagePaths: [],
  }, { active: false, draftId: "draft-2" });

  const asset = store.query({
    sql: "SELECT has_active_listing,ka_draft_id FROM assets WHERE id=?",
    params: [inserted.lastInsertRowid],
  })[0];
  assert.deepEqual(asset, { has_active_listing: 1, ka_draft_id: "draft-2" });
});

test("removing one listing preserves the flag while another active listing remains", () => {
  const inserted = store.query({
    sql: "INSERT INTO assets (name,has_active_listing) VALUES (?,?)",
    params: ["Artikel mit zwei Anzeigen", 1],
  });
  for (const adId of ["1001", "1002"]) {
    store.query({
      sql: "INSERT INTO ka_listings (asset_id,ka_id,status) VALUES (?,?,?)",
      params: [inserted.lastInsertRowid, adId, "active"],
    });
  }

  const agent = require("../workspace/agent");
  const first = agent.recordRemovedListing("1001");
  assert.equal(first.remainingActiveListings, 1);
  assert.equal(store.query({
    sql: "SELECT has_active_listing FROM assets WHERE id=?",
    params: [inserted.lastInsertRowid],
  })[0].has_active_listing, 1);

  const second = agent.recordRemovedListing("1002");
  assert.equal(second.remainingActiveListings, 0);
  assert.equal(store.query({
    sql: "SELECT has_active_listing FROM assets WHERE id=?",
    params: [inserted.lastInsertRowid],
  })[0].has_active_listing, 0);
});
