"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const TelegramGateway = require("../tools/telegram");
const { mimeTypeFor, splitMessage } = require("../tools/telegram");

test("long Telegram messages are split without losing content", () => {
  const original = `${"a".repeat(2500)}\n${"b".repeat(2500)}`;
  const chunks = splitMessage(original, 3000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.every(chunk => chunk.length <= 3000), true);
  assert.equal(chunks.join("\n"), original);
});

test("photo MIME type follows the file extension", () => {
  assert.equal(mimeTypeFor("photo.PNG"), "image/png");
  assert.equal(mimeTypeFor("photo.webp"), "image/webp");
  assert.equal(mimeTypeFor("photo.jpg"), "image/jpeg");
});

test("send chunks messages and returns Telegram results", async () => {
  const gateway = new TelegramGateway("test-token");
  const calls = [];
  gateway._request = async (method, body) => {
    calls.push({ method, body });
    return { message_id: calls.length };
  };
  const results = await gateway.send("42", "x".repeat(8500));
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.method === "sendMessage" && call.body.chat_id === "42"), true);
  assert.equal(results.length, 3);
});

test("getUpdates advances the offset monotonically", async () => {
  const gateway = new TelegramGateway("test-token", { lastUpdateId: 7 });
  gateway._request = async (method, body, timeoutMs) => {
    assert.equal(method, "getUpdates");
    assert.equal(body.offset, 8);
    assert.equal(body.timeout, 25);
    assert.equal(timeoutMs, 35000);
    return [{ update_id: 9 }, { update_id: 8 }];
  };
  const updates = await gateway.getUpdates();
  assert.equal(updates.length, 2);
  assert.equal(gateway.lastUpdateId, 9);
});
