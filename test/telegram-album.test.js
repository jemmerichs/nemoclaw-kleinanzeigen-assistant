"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-album-"));
process.env.NEMOCLAW_IMAGE_DIR = path.join(temporary, "images");
process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
process.env.NEMOCLAW_PENDING_FILE = path.join(temporary, "pending.json");
process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");
process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
process.env.NEMOCLAW_MODE = "dry-run";
process.env.NEMOCLAW_COMPLEXITY_ROUTING = "manual";

const { processTelegramUpdates } = require("../workspace/agent");
const { createSerialExecutor } = require("../workspace/runtime");

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("Telegram albums split across polls become one model turn", async () => {
  const modelCalls = [];
  const sent = [];
  const llmClient = {
    model: "stub",
    async complete(request) {
      modelCalls.push(request);
      return {
        message: { role: "assistant", content: "Beide Fotos wurden gemeinsam empfangen." },
      };
    },
  };
  const gateway = {
    async downloadPhoto(fileId) { return Buffer.from(`jpeg-${fileId}`); },
    async send(_chatId, text) { sent.push(text); },
  };
  const allowed = new Set(["42"]);
  const enqueue = createSerialExecutor();
  const albumBuffer = new Map();
  const options = { gateway, albumBuffer, albumDelayMs: 20 };

  await processTelegramUpdates([{
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 42 },
      media_group_id: "group-1",
      caption: "Gemeinsame Caption",
      photo: [{ file_id: "one" }],
    },
  }], allowed, enqueue, llmClient, options);

  await processTelegramUpdates([{
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: 42 },
      media_group_id: "group-1",
      photo: [{ file_id: "two" }],
    },
  }], allowed, enqueue, llmClient, options);

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(modelCalls.length, 1);
  const content = modelCalls[0].messages[1].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.filter(part => part.type === "image_url").length, 2);
  assert.match(content[0].text, /Gemeinsame Caption/);
  assert.deepEqual(sent, ["Beide Fotos wurden gemeinsam empfangen."]);
  assert.equal(albumBuffer.size, 0);
});

test("large Telegram album keeps all file tokens but bounds visual model input to twelve", async () => {
  const modelCalls = [];
  const llmClient = {
    model: "stub",
    async complete(request) {
      modelCalls.push(request);
      return {
        message: {
          role: "assistant",
          content: "Ich habe 13 Dateien erhalten; 12 davon wurden in diesem Turn visuell analysiert.",
        },
      };
    },
  };
  const gateway = {
    async downloadPhoto(fileId) { return Buffer.from(`jpeg-${fileId}`); },
    async send() {},
  };
  const updates = Array.from({ length: 13 }, (_, index) => ({
    update_id: 100 + index,
    message: {
      message_id: 200 + index,
      chat: { id: 42 },
      media_group_id: "large-group",
      ...(index === 0 ? { caption: "Ein Artikel aus vielen Perspektiven" } : {}),
      photo: [{ file_id: `large-${index + 1}` }],
    },
  }));
  const albumBuffer = new Map();

  await processTelegramUpdates(
    updates,
    new Set(["42"]),
    createSerialExecutor(),
    llmClient,
    { gateway, albumBuffer, albumDelayMs: 20 }
  );
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(modelCalls.length, 1);
  const content = modelCalls[0].messages[1].content;
  assert.equal(content.filter(part => part.type === "image_url").length, 12);
  assert.equal((content[0].text.match(/\[FOTO path:/g) || []).length >= 13, true);
  assert.match(content[0].text, /Ein Artikel aus vielen Perspektiven/);
  assert.equal(albumBuffer.size, 0);
});
