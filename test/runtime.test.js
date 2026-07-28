"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  atomicWriteJson,
  boundedJson,
  createSerialExecutor,
  extractImagePaths,
  isExplicitApproval,
  normalizeInboxPollMinutes,
  normalizeMode,
  parseAllowedChatIds,
  parseToolArguments,
  randomInboxIntervalMs,
  selectModelRoute,
  validateSchema,
  validateStorageKey,
} = require("../workspace/runtime");

test("approval only accepts a standalone Go", () => {
  for (const value of ["Go", "go!", " GO bitte ", "go jetzt."]) assert.equal(isExplicitApproval(value), true);
  for (const value of ["go ahead", "Bitte go sagen", "Go und dann löschen", "no go", ""]) assert.equal(isExplicitApproval(value), false);
});

test("native tool arguments and photo tokens are parsed defensively", () => {
  assert.deepEqual(parseToolArguments('{"price":42}'), { price: 42 });
  assert.deepEqual(parseToolArguments({ price: 42 }), { price: 42 });
  assert.throws(() => parseToolArguments("[]"), /JSON-Objekt/);
  assert.throws(() => parseToolArguments("{"), /gültiges JSON/);
  assert.deepEqual(
    extractImagePaths("[FOTO path:/tmp/a.jpg]\n[FOTO path:/tmp/b.jpg]\n[FOTO path:/tmp/a.jpg]"),
    ["/tmp/a.jpg", "/tmp/b.jpg"]
  );
});

test("tool arguments are validated independently of the model provider", () => {
  const schema = {
    type: "object",
    required: ["title", "price", "images"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 10 },
      price: { type: "number", minimum: 0 },
      images: { type: "array", maxItems: 2, items: { type: "string" } },
    },
  };
  const valid = { title: "Artikel", price: 12.5, images: ["one.jpg"] };
  assert.equal(validateSchema(valid, schema), valid);
  assert.throws(() => validateSchema({ ...valid, extra: true }, schema), /extra.*nicht erlaubt/);
  assert.throws(() => validateSchema({ ...valid, price: -1 }, schema), /price.*zu klein/);
  assert.throws(() => validateSchema({ ...valid, title: "" }, schema), /title.*zu kurz/);
  assert.throws(() => validateSchema({ ...valid, images: ["a", "b", "c"] }, schema), /zu viele/);
});

test("runtime mode fails closed", () => {
  assert.equal(normalizeMode(undefined), "dry-run");
  assert.equal(normalizeMode("live"), "live");
  assert.throws(() => normalizeMode("maybe"), /dry-run.*live/);
});

test("inbox polling is conservative, configurable, and jittered", () => {
  assert.equal(normalizeInboxPollMinutes(undefined), 45);
  assert.equal(normalizeInboxPollMinutes("0"), 0);
  assert.equal(normalizeInboxPollMinutes("15"), 15);
  assert.equal(normalizeInboxPollMinutes("360"), 360);
  assert.throws(() => normalizeInboxPollMinutes("14"), /15 und 360/);
  assert.throws(() => normalizeInboxPollMinutes("daily"), /15 und 360/);
  assert.equal(randomInboxIntervalMs(0, () => 0.5), null);
  assert.equal(randomInboxIntervalMs(45, () => 0), 36 * 60 * 1000);
  assert.equal(randomInboxIntervalMs(45, () => 0.5), 45 * 60 * 1000);
  assert.equal(randomInboxIntervalMs(45, () => 1), 54 * 60 * 1000);
});

test("complexity routing is cheap by default and explicitly controllable", () => {
  assert.equal(selectModelRoute("Zeige mein Inventar.", "auto").tier, "fast");
  assert.deepEqual(
    selectModelRoute("/high Analysiere diese schwierige Sammlung.", "auto"),
    {
      tier: "high",
      score: 99,
      reason: "explicit-high",
      message: "Analysiere diese schwierige Sammlung.",
    }
  );
  assert.equal(selectModelRoute("/fast Komplexe Strategie", "auto").tier, "fast");
  assert.equal(
    selectModelRoute("Analysiere mehrere Artikel und entwickle eine komplexe Strategie.", "auto").tier,
    "high"
  );
  assert.equal(
    selectModelRoute("Automatischer Inbox-Check: komplexe Nachricht von außen", "auto").tier,
    "fast"
  );
  assert.equal(selectModelRoute("/high teuer", "off").tier, "fast");
  assert.throws(() => selectModelRoute("x", "random"), /off.*manual.*auto/);
});

test("storage keys cannot escape their directory", () => {
  assert.equal(validateStorageKey("price-insights_2026"), "price-insights_2026");
  for (const value of ["../secret", "a/b", ".hidden", "with space", ""]) {
    assert.throws(() => validateStorageKey(value), /Key muss/);
  }
});

test("chat IDs and large tool results are bounded", () => {
  assert.deepEqual([...parseAllowedChatIds(" 123,456,123 ")], ["123", "456"]);
  const result = JSON.parse(boundedJson({ value: "x".repeat(100) }, 20));
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength > 20, true);
});

test("serial executor never overlaps work for one chat", async () => {
  const enqueue = createSerialExecutor();
  const events = [];
  const first = enqueue("chat", async () => {
    events.push("first:start");
    await new Promise(resolve => setTimeout(resolve, 15));
    events.push("first:end");
  });
  const second = enqueue("chat", async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("atomic JSON writes produce a complete private file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-"));
  const file = path.join(directory, "state.json");
  try {
    atomicWriteJson(file, { lastUpdateId: 42 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { lastUpdateId: 42 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
