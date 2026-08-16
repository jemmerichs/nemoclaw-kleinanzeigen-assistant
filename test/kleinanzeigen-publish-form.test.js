"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { listingValidationError } = require("../tools/kleinanzeigen");
const {
  assertListingFormContract,
  categoryPathFromContract,
  inspectSubmissionPath,
  normalizeSubmissionPath,
  publishedListingResult,
} = require("../tools/kleinanzeigen-publish-form");

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

const args = {
  title: "6x Möbelerhöher",
  description: "Unbenutzt. Nur Abholung.",
  categoryId: 87,
  price: 6,
  priceType: "FIXED",
  zipCode: "80636",
  locationId: "16360",
  contactName: "Jannik",
  attributes: { "sonstiges.versand": "nein" },
};

const entries = [
  ["title", args.title],
  ["description", args.description],
  ["categoryId", "87"],
  ["priceAmount", "6"],
  ["priceType", "FIXED"],
  ["zipCode", "80636"],
  ["locationId", "16360"],
  ["contactName", "Jannik"],
  ["attributeMap[sonstiges.versand]", "nein"],
];

test("browser publishing uses the visible category path and current safe submit target", async () => {
  assert.deepEqual(categoryPathFromContract(contract), [
    "Haus & Garten",
    "Weiteres Haus & Garten",
  ]);
  assert.equal(normalizeSubmissionPath("/post-listing/ads"), "/post-listing/ads");
  assert.throws(
    () => normalizeSubmissionPath("/_actions/postListingWeb.submitListing/"),
    /kein zulässiges Publish-Ziel/
  );
  assert.throws(
    () => normalizeSubmissionPath("https://example.invalid/post-listing/ads"),
    /kein zulässiges Publish-Ziel/
  );

  const page = {
    locator(selector) {
      assert.equal(selector, "astro-island[props]");
      return {
        async evaluateAll(callback) {
          return callback([{
            getAttribute(name) {
              assert.equal(name, "props");
              return JSON.stringify({
                postListingPage: [0, { actionUrl: [0, "/post-listing/ads"] }],
              });
            },
          }]);
        },
      };
    },
  };
  assert.equal(await inspectSubmissionPath(page), "/post-listing/ads");
});

test("the final browser FormData gate requires both category and verified pickup", () => {
  assert.equal(assertListingFormContract(entries, args, contract), true);

  for (const missingName of ["categoryId", "attributeMap[sonstiges.versand]"]) {
    assert.throws(
      () => assertListingFormContract(
        entries.filter(([name]) => name !== missingName),
        args,
        contract
      ),
      error => {
        assert.equal(error.code, "KA_BROWSER_FORM_INCOMPLETE");
        assert.equal(error.definitiveNoWrite, true);
        assert.match(error.message, /nichts veröffentlicht/);
        return true;
      }
    );
  }

  assert.throws(
    () => assertListingFormContract(entries, {
      ...args,
      attributes: { "sonstiges.versand_s": "nein" },
    }, contract),
    /nicht zum aktuell verifizierten Pflichtvertrag/
  );
});

test("browser publication result parsing accepts current response and redirect shapes", () => {
  assert.deepEqual(
    publishedListingResult({ body: { adId: 12345 } }),
    { id: "12345", link: "https://www.kleinanzeigen.de/s-anzeige/12345" }
  );
  assert.deepEqual(
    publishedListingResult({ pageUrl: "https://www.kleinanzeigen.de/s-anzeige/moebelerhoeher/98765-87-1" }),
    { id: "98765", link: "https://www.kleinanzeigen.de/s-anzeige/98765" }
  );
  assert.equal(publishedListingResult({ body: { success: true } }), null);
});

test("structured category validation remains available to the browser publisher", () => {
  const error = listingValidationError([
    { errors: 1 },
    [2, 5],
    { field: 3, message: 4 },
    "categoryId",
    "Bitte gib einen Wert ein.",
    { field: 6, message: 7 },
    "attributeMap[sonstiges.versand]",
    "Bitte gib einen Wert ein.",
  ], 87, 422);
  assert.equal(error.code, "KA_LISTING_VALIDATION");
  assert.deepEqual(error.recoveryAreas, ["category"]);
  assert.deepEqual(error.validationErrors, [
    { field: "categoryId", message: "Bitte gib einen Wert ein." },
    { field: "attributeMap[sonstiges.versand]", message: "Bitte gib einen Wert ein." },
  ]);

  const currentRouteError = listingValidationError({
    validationErrors: {
      categoryId: "Bitte gib einen Wert ein.",
      "attributeMap[sonstiges.versand]": ["Bitte gib einen Wert ein."],
    },
  }, 87, 422);
  assert.deepEqual(currentRouteError.validationErrors, error.validationErrors);
});

test("the obsolete direct HTTP publisher is no longer exposed", () => {
  const client = new KleinanzeigenClient("user_id=42; CSRF-TOKEN=csrf", "bearer");
  assert.equal(client.createAd, undefined);
});
