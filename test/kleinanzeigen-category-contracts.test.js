"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyCategoryPreferences,
  getCategoryRequirements,
  validateCategoryAttributes,
} = require("../tools/kleinanzeigen-category-contracts");

test("household appliance requirements expose the current verified form values", () => {
  const requirements = getCategoryRequirements(176);
  assert.equal(requirements.verified, true);
  assert.equal(requirements.category, "Elektronik > Haushaltsgeräte");
  assert.deepEqual(
    requirements.requiredAttributes.map(field => field.key),
    ["haushaltsgeraete.art", "haushaltsgeraete.versand"]
  );
  assert.ok(
    requirements.requiredAttributes[0].values.some(
      option => option.value === "haushaltskleingeraete"
    )
  );
  assert.deepEqual(
    requirements.requiredAttributes[1].values.map(option => option.value),
    ["ja", "nein"]
  );
});

test("lamps require the exact visible shipping field and values from the current form", () => {
  const requirements = getCategoryRequirements(82);
  assert.equal(requirements.verified, true);
  assert.equal(requirements.category, "Haus & Garten > Lampen & Licht");
  assert.deepEqual(requirements.requiredAttributes, [{
    key: "lampen_licht.versand",
    label: "Versand",
    values: [
      { value: "ja", label: "Versand möglich" },
      { value: "nein", label: "Nur Abholung" },
    ],
  }]);

  assert.throws(
    () => validateCategoryAttributes(82, {
      "lampen_licht.versand_s": "nein",
    }, { requireRequired: true }),
    /lampen_licht\.versand/
  );
  assert.throws(
    () => validateCategoryAttributes(82, {
      "lampen_licht.versand": "abholung",
    }),
    /Erlaubt: ja, nein/
  );
  assert.doesNotThrow(() => validateCategoryAttributes(82, {
    "lampen_licht.versand": "nein",
  }));
});

test("the pickup preference fills only an unambiguous verified shipping field", () => {
  assert.deepEqual(applyCategoryPreferences(82, {}), {
    "lampen_licht.versand": "nein",
  });
  assert.deepEqual(applyCategoryPreferences(82, {
    "lampen_licht.versand": "ja",
  }), {
    "lampen_licht.versand": "ja",
  });
  assert.deepEqual(applyCategoryPreferences(999, {}), {});
});

test("known category contracts fail before upload when required attributes are missing or guessed", () => {
  assert.throws(
    () => validateCategoryAttributes(176, {}, { requireRequired: true }),
    /haushaltsgeraete\.art/
  );
  assert.throws(
    () => validateCategoryAttributes(176, {
      "haushaltsgeraete.art": "fritteuse",
      "haushaltsgeraete.versand": "ja",
    }),
    /unbekannten Wert "fritteuse"/
  );
  assert.doesNotThrow(() => validateCategoryAttributes(176, {
    "haushaltsgeraete.art": "haushaltskleingeraete",
    "haushaltsgeraete.versand": "nein",
  }));
});

test("drafts may stay incomplete while still rejecting known invalid values", () => {
  assert.doesNotThrow(
    () => validateCategoryAttributes(176, {}, { requireRequired: false })
  );
  assert.throws(
    () => validateCategoryAttributes(176, {
      "haushaltsgeraete.versand": "vielleicht",
    }, { requireRequired: false }),
    /Erlaubt: ja, nein/
  );
});

test("unknown categories are reported without inventing a contract", () => {
  assert.deepEqual(getCategoryRequirements(999), {
    categoryId: 999,
    verified: false,
    requiredAttributes: [],
    instruction:
      "Für diese Kategorie ist noch kein aktueller Formularvertrag lokal verifiziert. " +
      "Keine Attributschlüssel oder Werte raten; das Formular mit dem exakten sichtbaren categoryPath prüfen.",
  });
  assert.doesNotThrow(
    () => validateCategoryAttributes(999, {}, { requireRequired: true })
  );
  assert.throws(
    () => validateCategoryAttributes(999, {}, {
      requireRequired: true,
      requireVerified: true,
    }),
    /noch nicht anhand des aktuellen Formulars verifiziert/
  );
});

test("a newly inspected category is sanitized, cached, and enforced without source changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-category-cache-"));
  const cacheFile = path.join(directory, "contracts.json");
  const modulePath = require.resolve("../tools/kleinanzeigen-category-contracts");
  const script = `
    const contracts = require(${JSON.stringify(modulePath)});
    contracts.rememberCategoryRequirements({
      categoryId: 321,
      category: "Haus & Garten > Möbel",
      requiredAttributes: [{
        key: "moebel.art",
        label: "Art",
        values: [
          { value: "regal", label: "Regal" },
          { value: "regal", label: "Doppelter Eintrag" }
        ]
      }, {
        key: "moebel.mass",
        label: "Maß",
        values: []
      }]
    });
    const result = contracts.getCategoryRequirements(321);
    let rejected = false;
    try {
      contracts.validateCategoryAttributes(321, { "moebel.art": "tisch" });
    } catch { rejected = true; }
    process.stdout.write(JSON.stringify({ result, rejected }));
  `;
  try {
    const output = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_KA_CATEGORY_CACHE_FILE: cacheFile,
      },
    });
    const { result, rejected } = JSON.parse(output);
    assert.equal(result.verified, true);
    assert.equal(result.categoryId, 321);
    assert.deepEqual(result.requiredAttributes[0].values, [
      { value: "regal", label: "Regal" },
    ]);
    assert.equal(rejected, true);
    assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
