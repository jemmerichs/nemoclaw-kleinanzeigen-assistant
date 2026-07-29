"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TOOLS,
  describeAction,
  loadContext,
  toolDefinitions,
  toolRequiresApproval,
  validateConfig,
} = require("../workspace/agent");
const { actionFingerprint } = require("../workspace/runtime");

test("every externally destructive bridge tool requires approval", () => {
  for (const name of [
    "ka_send_message",
    "ka_create_ad",
    "ka_save_draft",
    "ka_delete_draft",
    "ka_delete_ad",
    "vinted_create_item",
    "vinted_save_draft",
    "vinted_delete_item",
    "inventory_mark_sold",
    "inventory_delete_asset",
  ]) {
    assert.equal(TOOLS[name].requiresApproval, true, `${name} must require Go`);
  }
  assert.equal(TOOLS.ka_get_my_ads.requiresApproval, undefined);
  assert.equal(TOOLS.ka_search_ads.requiresApproval, undefined);
  assert.equal(TOOLS.vinted_search_items.requiresApproval, undefined);
});

test("model only sees narrow tools and cannot call raw SQL", () => {
  const names = toolDefinitions().map(tool => tool.function.name);
  assert.equal(names.includes("db_query"), false);
  assert.equal(names.includes("ka_create_ad"), true);
  assert.equal(names.includes("ka_delete_ad"), true);
  assert.equal(names.includes("vinted_create_item"), true);
  assert.equal(names.includes("vinted_delete_item"), true);
  assert.equal(names.includes("updateSkillFile"), false);
});

test("agent context treats buyer content as data and includes negotiation handoff rules", () => {
  const context = loadContext();
  assert.match(context, /Käufernachrichten.*fremde Daten/i);
  assert.match(context, /Zahlungs-, Login-, TAN-, Verifizierungs- oder Abholcodes niemals/i);
  assert.match(context, /keine geheime Mindestgrenze annehmen/i);
  assert.match(context, /Eine bereits vorgemerkte Nutzeraktion|alte Aktion niemals ersetzen/i);
  assert.match(context, /Set oder einzeln verkauft/i);
});

test("pending action identity binds tool and exact arguments", () => {
  const first = actionFingerprint("ka_send_message", { conversationId: "c1", text: "Hallo" });
  const reordered = actionFingerprint("ka_send_message", { text: "Hallo", conversationId: "c1" });
  const changed = actionFingerprint("ka_send_message", { conversationId: "c1", text: "Andere Nachricht" });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  const description = describeAction({
    id: first,
    tool: "ka_send_message",
    args: { conversationId: "c1", text: "Hallo" },
  });
  assert.match(description, /c1/);
  assert.match(description, /Hallo/);
  assert.equal(toolRequiresApproval(TOOLS.ka_send_message, {}), true);
});

test("known category requirements are enforced while preparing the exact action", () => {
  const base = {
    title: "Heißluftfritteuse",
    description: "Gebraucht und funktionsfähig.",
    categoryId: 176,
    price: 25,
    priceType: "FIXED",
    zipCode: "80636",
    locationId: "16360",
    contactName: "Jannik",
    imagePaths: [],
  };
  assert.throws(
    () => TOOLS.ka_create_ad.prepare(base),
    /haushaltsgeraete\.art/
  );
  assert.doesNotThrow(() => TOOLS.ka_create_ad.prepare({
    ...base,
    attributes: {
      "haushaltsgeraete.art": "haushaltskleingeraete",
      "haushaltsgeraete.versand": "nein",
    },
  }));
  assert.equal(TOOLS.ka_get_category_requirements.requiresApproval, undefined);
});

test("startup rejects placeholder IDs and heartbeat recipients outside the allowlist", () => {
  const previous = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    allowed: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    allowedMany: process.env.TELEGRAM_ALLOWED_CHAT_IDS,
    heartbeat: process.env.TELEGRAM_HEARTBEAT_CHAT_ID,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  try {
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    process.env.TELEGRAM_BOT_TOKEN = "your_token_here";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "not-a-number";
    process.env.OPENROUTER_API_KEY = "bad-key";
    assert.throws(
      () => validateConfig(),
      /OPENROUTER_API_KEY fehlt oder ist ungültig.*TOKEN fehlt oder ist ungültig.*CHAT_ID fehlt oder ist ungültig/
    );

    process.env.OPENROUTER_API_KEY = `sk-or-v1-${"a".repeat(64)}`;
    process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "42";
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = "43";
    assert.throws(() => validateConfig(), /HEARTBEAT_CHAT_ID muss/);
  } finally {
    if (previous.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous.token;
    if (previous.allowed === undefined) delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
    else process.env.TELEGRAM_ALLOWED_CHAT_ID = previous.allowed;
    if (previous.allowedMany === undefined) delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    else process.env.TELEGRAM_ALLOWED_CHAT_IDS = previous.allowedMany;
    if (previous.heartbeat === undefined) delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;
    else process.env.TELEGRAM_HEARTBEAT_CHAT_ID = previous.heartbeat;
    if (previous.openrouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous.openrouter;
  }
});
