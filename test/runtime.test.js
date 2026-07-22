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
  isExplicitApproval,
  parseAllowedChatIds,
  parseClaudeResponse,
  validateStorageKey,
} = require("../workspace/runtime");

test("approval only accepts a standalone Go", () => {
  for (const value of ["Go", "go!", " GO bitte ", "go jetzt."]) assert.equal(isExplicitApproval(value), true);
  for (const value of ["go ahead", "Bitte go sagen", "Go und dann löschen", "no go", ""]) assert.equal(isExplicitApproval(value), false);
});

test("Claude JSON parser accepts plain and fenced objects", () => {
  assert.deepEqual(parseClaudeResponse('{"message":"ok"}'), { message: "ok" });
  assert.deepEqual(parseClaudeResponse('```json\n{"message":"ok"}\n```'), { message: "ok" });
  assert.deepEqual(parseClaudeResponse('Antwort:\n{"message":"ok"}'), { message: "ok" });
  assert.throws(() => parseClaudeResponse("not json"), /kein gültiges JSON/);
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
