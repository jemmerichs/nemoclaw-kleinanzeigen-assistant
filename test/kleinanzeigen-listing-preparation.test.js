"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const preparation = require("../tools/kleinanzeigen-listing-preparation");

const contract = {
  categoryId: 87,
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

test.afterEach(() => preparation.clearListingPreparations());

test("visible category paths and pickup intent resolve without provider IDs", () => {
  assert.deepEqual(
    preparation.normalizeCategoryPath(" Haus & Garten > Weiteres Haus & Garten "),
    ["Haus & Garten", "Weiteres Haus & Garten"]
  );
  assert.deepEqual(
    preparation.resolveCategoryAttributes(contract, { delivery: "pickup_only" }),
    { status: "ready", attributes: { "sonstiges.versand": "nein" } }
  );
});

test("non-shipping category choices stay visible and semantic", () => {
  const appliance = {
    categoryId: 176,
    category: "Elektronik > Haushaltsgeräte",
    requiredAttributes: [
      {
        key: "haushaltsgeraete.art",
        label: "Art",
        values: [
          { value: "haushaltskleingeraete", label: "Haushaltskleingeräte" },
          { value: "sonstige", label: "Weitere Haushaltsgeräte" },
        ],
      },
      ...contract.requiredAttributes,
    ],
  };
  const missing = preparation.resolveCategoryAttributes(appliance, { delivery: "pickup_only" });
  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.fields, [{
    field: "Art",
    choices: ["Haushaltskleingeräte", "Weitere Haushaltsgeräte"],
  }]);
  assert.doesNotMatch(JSON.stringify(missing), /haushaltsgeraete\.art|sonstiges\.versand/);

  assert.deepEqual(
    preparation.resolveCategoryAttributes(appliance, {
      delivery: "pickup_only",
      categoryAnswers: { Art: "Haushaltskleingeräte" },
    }),
    {
      status: "ready",
      attributes: {
        "haushaltsgeraete.art": "haushaltskleingeraete",
        "sonstiges.versand": "nein",
      },
    }
  );
});

test("opaque preparations are cloned and expire after the approval window", () => {
  const id = preparation.storeListingPreparation(
    { category: contract.category, delivery: "pickup_only", listing: { title: "Test" } },
    { now: 1000, randomBytes: () => Buffer.alloc(12, 7) }
  );
  assert.equal(id, "070707070707070707070707");
  const first = preparation.getListingPreparation(id, { now: 1001 });
  first.listing.title = "Geändert";
  assert.equal(preparation.getListingPreparation(id, { now: 1002 }).listing.title, "Test");
  assert.throws(
    () => preparation.getListingPreparation(id, {
      now: 1000 + preparation.PREPARATION_TTL_MS + 1,
    }),
    /abgelaufen oder unbekannt/
  );
});

test("visible free-text category answers are passed through without exposing their field key", () => {
  const result = preparation.resolveCategoryAttributes({
    requiredAttributes: [{ key: "custom.details", label: "Details", values: [] }],
  }, { categoryAnswers: { Details: "Massivholz" } });
  assert.deepEqual(result, {
    status: "ready",
    attributes: { "custom.details": "Massivholz" },
  });
});

test("technical preparation failures produce a bounded developer handoff", () => {
  const error = new Error("Formular enthält kein Versandfeld");
  error.code = "KA_CATEGORY_INSPECTION_INCOMPLETE";
  const result = preparation.preparationTechnicalFailure(error, {
    categoryPath: ["Haus & Garten", "Weiteres Haus & Garten"],
  });
  assert.equal(result.status, "technical_failure");
  assert.equal(result.diagnostic.code, "KA_CATEGORY_INSPECTION_INCOMPLETE");
  assert.equal(result.diagnostic.step, "prepare_current_listing_form");
  assert.match(result.action, /vollständige Fehlermeldung weitergeben/);
  assert.match(result.instruction, /Artikelangaben und Bilder nicht erneut erfragen/);
  assert.match(result.diagnostic.reason, /kein Versandfeld/);
});

test("a changed category DOM is not misreported as a login failure", () => {
  const error = new Error("Die Kategoriepfade wurden nach dem Laden nicht sichtbar.");
  error.code = "KA_FORM_STRUCTURE_CHANGED";
  const result = preparation.preparationTechnicalFailure(error, {
    categoryPath: ["Haus & Garten", "Weiteres Haus & Garten"],
  });
  assert.equal(result.diagnostic.code, "KA_FORM_STRUCTURE_CHANGED");
  assert.doesNotMatch(result.action, /login/i);
});
