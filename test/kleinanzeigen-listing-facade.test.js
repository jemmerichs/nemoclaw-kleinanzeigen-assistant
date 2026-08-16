"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-listing-facade-"));
process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
process.env.NEMOCLAW_PENDING_FILE = path.join(temporary, "pending.json");
process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");
process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE = path.join(temporary, "category-contracts.json");
process.env.NEMOCLAW_MODE = "dry-run";
process.env.KA_DEFAULT_ZIP_CODE = "80636";
process.env.KA_DEFAULT_LOCATION_ID = "16360";
process.env.KA_CONTACT_NAME = "Jannik";
process.env.KA_COOKIES = "csrf-token=facade-test; registered_user=true";

const categoryContracts = require("../tools/kleinanzeigen-category-contracts");
const listingPreparations = require("../tools/kleinanzeigen-listing-preparation");
const agent = require("../workspace/agent");
agent.TOOLS.ka_prepare_listing.ensureSession = async () => {};

const inspectedContract = {
  status: "ready",
  verified: true,
  categoryId: 987,
  category: "Haus & Garten > Weiteres Haus & Garten",
  requiredAttributes: [{
    key: "sonstiges.versand",
    label: "Versand",
    values: [
      { value: "ja", label: "Versand möglich" },
      { value: "nein", label: "Nur Abholung" },
    ],
  }],
};

test.after(() => {
  agent.clearPending("facade-flow");
  listingPreparations.clearListingPreparations();
  delete agent.TOOLS.ka_prepare_listing.ensureSession;
  require("../tools/adstore").close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("semantic preparation stages an opaque, revalidated Go action without exposing provider fields", async () => {
  const originalInspect = agent.TOOLS.ka_prepare_listing.inspect;
  agent.TOOLS.ka_prepare_listing.inspect = async ({ categoryPath }) => {
    assert.deepEqual(categoryPath, ["Haus & Garten", "Weiteres Haus & Garten"]);
    categoryContracts.rememberCategoryRequirements(inspectedContract);
    return inspectedContract;
  };
  const sent = [];
  let modelCalls = 0;
  const llmClient = {
    model: "stub",
    async complete(request) {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "prepare-listing",
              type: "function",
              function: {
                name: "ka_prepare_listing",
                arguments: JSON.stringify({
                  title: "6x Möbelerhöher",
                  description: "Sechs unbenutzte Möbelerhöher. Nur Abholung.",
                  category: "Haus & Garten > Weiteres Haus & Garten",
                  price: 6,
                  priceType: "FIXED",
                  delivery: "pickup_only",
                  imagePaths: [],
                }),
              },
            }],
          },
        };
      }
      const prepared = JSON.parse(request.messages.at(-1).content);
      assert.equal(prepared.status, "ready");
      assert.match(prepared.preparationId, /^[a-f0-9]{24}$/);
      assert.equal(prepared.preview.delivery, "Nur Abholung");
      assert.doesNotMatch(
        JSON.stringify(prepared),
        /categoryId|locationId|attributeMap|sonstiges\.versand/
      );
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "stage-prepared-listing",
            type: "function",
            function: {
              name: "ka_publish_prepared_listing",
              arguments: JSON.stringify({ preparationId: prepared.preparationId }),
            },
          }],
        },
      };
    },
  };

  try {
    const result = await agent.runAgent(
      "facade-flow",
      "Veröffentliche die Möbelerhöher auf Kleinanzeigen, nur Abholung.",
      { llmClient, gateway: { async send(_chatId, text) { sent.push(text); } } }
    );
    assert.equal(modelCalls, 2);
    assert.deepEqual(result.toolCalls, ["ka_prepare_listing", "ka_publish_prepared_listing"]);
    const pending = agent.getPending("facade-flow");
    assert.equal(pending.tool, "ka_publish_prepared_listing");
    assert.equal(pending.args.listing.categoryId, 987);
    assert.equal(pending.args.listing.attributes["sonstiges.versand"], "nein");
    assert.equal(pending.args.listing.locationId, "16360");
    assert.match(sent[0], /Kategorie: Haus & Garten > Weiteres Haus & Garten/);
    assert.match(sent[0], /Versand: Nur Abholung/);
    assert.doesNotMatch(sent[0], /Kategorie-ID|Location-ID|Attribute|sonstiges\.versand/);

    await agent.runAgent("facade-flow", "Go", {
      llmClient: null,
      gateway: { async send(_chatId, text) { sent.push(text); } },
    });
    assert.equal(agent.getPending("facade-flow"), null);
    assert.match(sent[1], /dry-run-Modus blockiert/);
  } finally {
    agent.TOOLS.ka_prepare_listing.inspect = originalInspect;
    agent.clearPending("facade-flow");
  }
});

test("an incomplete category path returns only visible choices", async () => {
  const originalInspect = agent.TOOLS.ka_prepare_listing.inspect;
  agent.TOOLS.ka_prepare_listing.inspect = async () => ({
    status: "selection_required",
    selectedPath: ["Haus & Garten"],
    issue: "Die Kategorie benötigt noch eine weitere sichtbare Auswahl.",
    choices: [
      { label: "Schlafzimmer", token: "80" },
      { label: "Weiteres Haus & Garten", token: "87" },
    ],
  });
  try {
    const result = await agent.TOOLS.ka_prepare_listing.fn({
      title: "Möbelerhöher",
      description: "Sechs unbenutzte Möbelerhöher.",
      category: "Haus & Garten",
      price: 6,
      imagePaths: [],
    });
    assert.deepEqual(result.choices, ["Schlafzimmer", "Weiteres Haus & Garten"]);
    assert.equal(result.status, "needs_input");
    assert.doesNotMatch(JSON.stringify(result), /categoryId|token|attributeMap/);
  } finally {
    agent.TOOLS.ka_prepare_listing.inspect = originalInspect;
  }
});
