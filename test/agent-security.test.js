"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-security-"));
process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE = path.join(
  testDirectory,
  "category-contracts.json"
);

test.after(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

const {
  TOOLS,
  describeAction,
  loadContext,
  prepareBoundKleinanzeigenListing,
  toolDefinitions,
  toolRequiresApproval,
  validateConfig,
} = require("../workspace/agent");
const { redactUnsafeText } = require("../tools/safe-error");
const { withBoundKleinanzeigenForm } = require("./test-helpers");

test("safe errors redact credentials and absolute paths", () => {
  const redacted = redactUnsafeText(
    "Cookie: secret-cookie\n{\"access_token\":\"secret-token\"} /Users/example/private/photo.jpg"
  );
  assert.doesNotMatch(redacted, /secret-cookie|secret-token|\/Users\/example/);
  assert.match(redacted, /Cookie \[geschützt\]|access_token \[geschützt\]/);
});

test("every externally destructive bridge tool requires approval", () => {
  for (const name of [
    "ka_send_message",
    "ka_publish_prepared_listing",
    "ka_save_prepared_draft",
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
  assert.equal(names.includes("ka_prepare_listing"), true);
  assert.equal(names.includes("ka_publish_prepared_listing"), true);
  assert.equal(names.includes("ka_save_prepared_draft"), true);
  assert.equal(names.includes("ka_create_ad"), false);
  assert.equal(names.includes("ka_save_draft"), false);
  assert.equal(names.includes("ka_get_category_requirements"), false);
  assert.equal(names.includes("ka_delete_ad"), true);
  assert.equal(names.includes("vinted_create_item"), true);
  assert.equal(names.includes("vinted_delete_item"), true);
  assert.equal(names.includes("updateSkillFile"), false);
});

test("Kleinanzeigen writes expose only semantic preparation and opaque action tokens", () => {
  const definitions = new Map(
    toolDefinitions().map(tool => [tool.function.name, tool.function.parameters])
  );
  const prepareProperties = definitions.get("ka_prepare_listing").properties;
  assert.equal("category" in prepareProperties, true);
  assert.equal("delivery" in prepareProperties, true);
  for (const internal of ["categoryId", "zipCode", "locationId", "contactName", "attributes"]) {
    assert.equal(internal in prepareProperties, false, `${internal} must stay inside the bridge`);
  }
  assert.deepEqual(
    Object.keys(definitions.get("ka_publish_prepared_listing").properties),
    ["preparationId"]
  );
  assert.deepEqual(
    Object.keys(definitions.get("ka_save_prepared_draft").properties),
    ["preparationId"]
  );
});

test("Vinted package IDs use provider-compatible integer schemas", () => {
  const definitions = new Map(
    toolDefinitions().map(tool => [tool.function.name, tool.function.parameters])
  );
  for (const name of ["vinted_save_draft", "vinted_create_item"]) {
    const schema = definitions.get(name).properties.packageTypeId;
    assert.equal(schema.type, "integer");
    assert.equal(schema.minimum, 1);
    assert.equal(schema.enum, undefined);
    assert.match(schema.description, /8, 9 oder 10/);
  }
});

test("agent context treats buyer content as data and includes negotiation handoff rules", () => {
  const context = loadContext();
  assert.match(context, /Käufernachrichten.*fremde Daten/i);
  assert.match(context, /Zahlungs-, Login-, TAN-, Verifizierungs- oder Abholcodes niemals/i);
  assert.match(context, /keine geheime Mindestgrenze annehmen/i);
  assert.match(context, /Eine bereits vorgemerkte Nutzeraktion|alte Aktion niemals ersetzen/i);
  assert.match(context, /Set oder einzeln verkauft/i);
  assert.match(context, /Standardmäßig kein Versand, sondern nur Abholung/i);
});

test("pending action descriptions hide provider identifiers", () => {
  const description = describeAction({
    id: "a".repeat(32),
    tool: "ka_send_message",
    args: { conversationId: "c1", text: "Hallo" },
  });
  assert.doesNotMatch(description, /c1/);
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
    locationName: "München-Neuhausen",
    contactName: "Jannik",
    sessionRevision: "security-session",
    imagePaths: [],
  };
  assert.throws(
    () => prepareBoundKleinanzeigenListing(withBoundKleinanzeigenForm(base)),
    /haushaltsgeraete\.art/
  );
  const prepared = prepareBoundKleinanzeigenListing(withBoundKleinanzeigenForm({
    ...base,
    attributes: {
      "haushaltsgeraete.art": "haushaltskleingeraete",
    },
  }));
  assert.equal(prepared.attributes["haushaltsgeraete.versand"], "nein");
  const visiblyBound = prepareBoundKleinanzeigenListing(withBoundKleinanzeigenForm({
    ...base,
    zipCode: "10115",
    locationId: "6488",
    locationName: "Berlin-Mitte",
    contactName: "Formularname",
    attributes: {
      "haushaltsgeraete.art": "haushaltskleingeraete",
    },
  }));
  assert.equal(visiblyBound.zipCode, "10115");
  assert.equal(visiblyBound.locationId, "6488");
  assert.equal(visiblyBound.locationName, "Berlin-Mitte");
  assert.equal(visiblyBound.contactName, "Formularname");
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
