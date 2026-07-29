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
process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE = path.join(temporary, "category-contracts.json");
process.env.NEMOCLAW_MODE = "dry-run";
process.env.NEMOCLAW_COMPLEXITY_ROUTING = "manual";

require("../tools/kleinanzeigen-category-contracts").rememberCategoryRequirements({
  categoryId: 278,
  category: "Testkategorie",
  requiredAttributes: [],
});
const {
  clearPending,
  getPending,
  processTelegramUpdates,
} = require("../workspace/agent");
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

test("large Telegram album is visually reviewed in bounded batches before the answer", async () => {
  const modelCalls = [];
  const llmClient = {
    model: "stub",
    async complete(request) {
      modelCalls.push(request);
      return {
        message: {
          role: "assistant",
          content: modelCalls.length === 1
            ? "Ich habe den ersten Bildbatch geprüft."
            : "Ich habe alle 13 Dateien visuell geprüft und kann sie jetzt gemeinsam beurteilen.",
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

  assert.equal(modelCalls.length, 2);
  const firstContent = modelCalls[0].messages[1].content;
  assert.equal(firstContent.filter(part => part.type === "image_url").length, 12);
  assert.equal((firstContent[0].text.match(/\[FOTO path:/g) || []).length >= 13, true);
  assert.match(firstContent[0].text, /Ein Artikel aus vielen Perspektiven/);
  const secondContent = modelCalls[1].messages.at(-1).content;
  assert.equal(secondContent.filter(part => part.type === "image_url").length, 1);
  assert.match(secondContent[0].text, /weiteren Fotos visuell/);
  assert.equal(albumBuffer.size, 0);
});

test("a listing tool call is deferred until the remaining album batch was visible", async () => {
  let callCount = 0;
  let imagePaths = [];
  const sent = [];
  const llmClient = {
    model: "stub",
    async complete(request) {
      callCount++;
      if (!imagePaths.length) {
        imagePaths = [...request.messages[1].content[0].text.matchAll(
          /\[FOTO path:([^\]]+)\]/g
        )].map(match => match[1]);
      }
      return {
        message: {
          role: "assistant",
          content: "Vollständiger Anzeigenvorschlag.",
          tool_calls: [{
            id: `album-create-${callCount}`,
            type: "function",
            function: {
              name: "ka_create_ad",
              arguments: JSON.stringify({
                title: "Album-Testartikel",
                description: "Alle Bilder wurden geprüft.",
                categoryId: 278,
                price: 20,
                priceType: "FIXED",
                zipCode: "80636",
                locationId: "16360",
                contactName: "Jannik",
                imagePaths,
              }),
            },
          }],
        },
      };
    },
  };
  const gateway = {
    async downloadPhoto(fileId) { return Buffer.from(`jpeg-${fileId}`); },
    async send(_chatId, text) { sent.push(text); },
  };
  const updates = Array.from({ length: 13 }, (_, index) => ({
    update_id: 300 + index,
    message: {
      message_id: 400 + index,
      chat: { id: 43 },
      media_group_id: "deferred-group",
      photo: [{ file_id: `deferred-${index + 1}` }],
    },
  }));

  await processTelegramUpdates(
    updates,
    new Set(["43"]),
    createSerialExecutor(),
    llmClient,
    { gateway, albumBuffer: new Map(), albumDelayMs: 20 }
  );
  await new Promise(resolve => setTimeout(resolve, 120));

  try {
    assert.equal(callCount, 2);
    assert.equal(imagePaths.length, 13);
    assert.equal(getPending("43").tool, "ka_create_ad");
    assert.deepEqual(getPending("43").args.imagePaths, imagePaths);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Album-Testartikel/);
  } finally {
    clearPending("43");
  }
});
