"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const TelegramGateway = require("../tools/telegram");
const {
  isTransientDnsError,
  mimeTypeFor,
  splitMessage,
  telegramPlainText,
} = require("../tools/telegram");

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

test("Telegram output uses compact plain-text sections", () => {
  const formatted = telegramPlainText([
    "### Marktübersicht",
    "---",
    "- Standard-Sets: 6 € bis 10 €",
    "",
    "### Preisempfehlung",
    "- 8 € VB",
    "",
    "Antworte mit `Go`.",
  ].join("\n"));
  assert.equal(formatted, [
    "Marktübersicht:",
    "- Standard-Sets: 6 € bis 10 €",
    "",
    "Preisempfehlung:",
    "- 8 € VB",
    "",
    "Antworte mit Go.",
  ].join("\n"));
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

test("send normalizes model Markdown before calling Telegram", async () => {
  const gateway = new TelegramGateway("test-token");
  const calls = [];
  gateway._request = async (_method, body) => {
    calls.push(body.text);
    return { message_id: 1 };
  };
  await gateway.send("42", "### Ergebnis\n---\nBitte mit `Go` bestätigen.");
  assert.deepEqual(calls, ["Ergebnis:\nBitte mit Go bestätigen."]);
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

test("Telegram retries only pre-connect DNS failures with bounded delays", async () => {
  const gateway = new TelegramGateway("test-token", { dnsRetryDelaysMs: [0, 0, 0] });
  let attempts = 0;
  gateway._requestOnce = async () => {
    attempts++;
    if (attempts < 3) {
      const error = new Error("getaddrinfo ENOTFOUND api.telegram.org");
      error.code = attempts === 1 ? "ENOTFOUND" : "EAI_AGAIN";
      throw error;
    }
    return { ok: true };
  };

  assert.deepEqual(await gateway._request("sendMessage", { chat_id: "42", text: "test" }), { ok: true });
  assert.equal(attempts, 3);
  assert.equal(isTransientDnsError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), true);
  assert.equal(isTransientDnsError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), false);
});

test("Telegram does not retry ambiguous transport failures", async () => {
  const gateway = new TelegramGateway("test-token", { dnsRetryDelaysMs: [0, 0] });
  let attempts = 0;
  gateway._requestOnce = async () => {
    attempts++;
    const error = new Error("socket hang up");
    error.code = "ECONNRESET";
    throw error;
  };

  await assert.rejects(() => gateway._request("sendMessage", { chat_id: "42", text: "test" }), /socket hang up/);
  assert.equal(attempts, 1);
});
