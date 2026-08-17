"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertCanaryResult,
  canaryCaption,
  explainTelegramPollError,
  getCanaryUpdates,
  isRetryableTelegramPollError,
  parseArgs,
  selectCanaryUpdates,
} = require("../scripts/smoke-telegram-agent");

test("Telegram agent canary arguments and caption are bounded", () => {
  assert.deepEqual(
    parseArgs(["--marker", "canary-fixed", "--timeout-seconds", "120"]),
    { marker: "canary-fixed", timeoutSeconds: 120 }
  );
  assert.throws(() => parseArgs(["--timeout-seconds", "10"]), /zwischen 30 und 900/);
  assert.match(canaryCaption("canary-fixed"), /ka_prepare_listing/);
  assert.match(canaryCaption("canary-fixed"), /Nichts hochladen oder veröffentlichen/);
});

test("Telegram agent canary explains a competing bot poll without hiding other errors", () => {
  const conflict = explainTelegramPollError(new Error(
    "Telegram getUpdates fehlgeschlagen (409): Conflict: terminated by other getUpdates request"
  ));
  assert.match(conflict.message, /andere Bot-Instanz/);
  assert.match(conflict.message, /separaten Telegram-Bot/);
  assert.match(conflict.message, /keine Testnachricht verarbeitet/);

  const dns = new Error("getaddrinfo ENOTFOUND api.telegram.org");
  assert.equal(explainTelegramPollError(dns), dns);
});

test("Telegram agent canary safely retries read-only poll timeouts", async () => {
  let calls = 0;
  const gateway = {
    async getUpdates() {
      calls++;
      if (calls === 1) throw new Error("Telegram getUpdates: Timeout");
      return [{ update_id: 42 }];
    },
  };
  assert.equal(isRetryableTelegramPollError(new Error("Telegram getUpdates: Timeout")), true);
  assert.equal(isRetryableTelegramPollError(new Error("Telegram sendMessage: Timeout")), false);
  assert.deepEqual(await getCanaryUpdates(gateway, {
    timeoutSeconds: 0,
    deadline: Date.now() + 1000,
    retryDelayMs: 0,
  }), [{ update_id: 42 }]);
  assert.equal(calls, 2);
});

test("Telegram agent canary selects only the exact marked owner update", () => {
  const updates = [{
    update_id: 10,
    message: { chat: { id: 42 }, caption: "canary-fixed", photo: [{ file_id: "photo" }] },
  }, {
    update_id: 11,
    message: { chat: { id: 99 }, text: "ignored" },
  }];
  const result = selectCanaryUpdates(updates, new Set(["42"]), "canary-fixed");
  assert.deepEqual(result.selected.map(update => update.update_id), [10]);
  assert.deepEqual(result.unexpected, []);

  const occupied = selectCanaryUpdates([{
    update_id: 12,
    message: { chat: { id: 42 }, text: "normale Nachricht" },
  }], new Set(["42"]), "canary-fixed");
  assert.equal(occupied.selected.length, 0);
  assert.equal(occupied.unexpected.length, 1);
});

test("Telegram agent canary requires visible form, image, and Dry-run evidence", () => {
  const pending = {
    tool: "ka_publish_prepared_listing",
    mode: "dry-run",
    args: {
      category: "Haus & Garten > Lampen & Licht",
      listing: {
        title: "Canary-Lampe",
        zipCode: "80636",
        locationId: "opaque-place",
        locationName: "München",
        contactName: "Jannik",
        formFingerprint: "a".repeat(64),
        sessionRevision: "revision",
        imagePaths: ["/managed/canary.jpg"],
      },
    },
    materials: [{ mediaId: "a".repeat(24), sha256: "b".repeat(64) }],
  };
  const listing = assertCanaryResult(pending, [
    "Canary-Lampe\nKategorie: Haus & Garten > Lampen & Licht\nOrt: München\nDry-run ist aktiv",
  ]);
  assert.equal(listing.zipCode, "80636");
  assert.throws(
    () => assertCanaryResult({
      ...pending,
      args: { ...pending.args, listing: { ...pending.args.listing, contactName: "" } },
    }, ["Dry-run ist aktiv"]),
    /Profilname fehlt/
  );
});
