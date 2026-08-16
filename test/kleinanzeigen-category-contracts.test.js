"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
    assert.equal(result.inspectionVersion, 3);
    assert.deepEqual(result.requiredAttributes[0].values, [
      { value: "regal", label: "Regal" },
    ]);
    assert.equal(rejected, true);
    assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("server-rejected category contracts stay quarantined until a materially repaired refresh", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-category-quarantine-"));
  const cacheFile = path.join(directory, "contracts.json");
  const modulePath = require.resolve("../tools/kleinanzeigen-category-contracts");
  const initialScript = `
    const contracts = require(${JSON.stringify(modulePath)});
    contracts.rememberCategoryRequirements({
      categoryId: 87,
      category: "Haus & Garten > Weiteres Haus & Garten",
      requiredAttributes: []
    });
    contracts.invalidateCategoryRequirements(87, [{
      field: "attributeMap[haus_garten.versand_s]",
      message: "Bitte gib einen Wert für Versand ein."
    }]);
    contracts.rememberCategoryRequirements({
      categoryId: 88,
      category: "Haus & Garten > Sonstiges",
      requiredAttributes: []
    });
    contracts.invalidateCategoryRequirements(88, [{
      field: "location",
      message: "Der Ort passt nicht zur Postleitzahl."
    }]);
  `;
  const repairScript = `
    const contracts = require(${JSON.stringify(modulePath)});
    const before = contracts.getCategoryRequirements(87);
    let unchangedRejected = false;
    try {
      contracts.rememberCategoryRequirements({
        categoryId: 87,
        category: "Haus & Garten > Weiteres Haus & Garten",
        requiredAttributes: []
      });
    } catch (error) {
      unchangedRejected = error.code === "KA_CATEGORY_INSPECTION_INCOMPLETE";
    }
    const repaired = contracts.rememberCategoryRequirements({
      categoryId: 87,
      category: "Haus & Garten > Weiteres Haus & Garten",
      requiredAttributes: [{
        key: "haus_garten.versand",
        label: "Versand",
        values: [
          { value: "ja", label: "Versand möglich" },
          { value: "nein", label: "Nur Abholung" }
        ]
      }]
    });
    process.stdout.write(JSON.stringify({
      before,
      unchangedRejected,
      repaired,
      preferred: contracts.applyCategoryPreferences(87, {}),
      locationOnly: contracts.getCategoryRequirements(88)
    }));
  `;
  try {
    execFileSync(process.execPath, ["-e", initialScript], {
      env: { ...process.env, NEMOCLAW_KA_CATEGORY_CACHE_FILE: cacheFile },
    });
    const output = execFileSync(process.execPath, ["-e", repairScript], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_KA_CATEGORY_CACHE_FILE: cacheFile },
    });
    const result = JSON.parse(output);
    assert.equal(result.before.verified, false);
    assert.equal(result.before.invalidated, true);
    assert.match(result.before.instruction, /Versandfeld/);
    assert.equal(result.unchangedRejected, true);
    assert.equal(result.repaired.verified, undefined);
    assert.equal(result.repaired.inspectionVersion, 3);
    assert.deepEqual(result.preferred, { "haus_garten.versand": "nein" });
    assert.equal(result.locationOnly.verified, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the browser-form transport upgrade releases a legacy writer quarantine after a fresh inspection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-category-transport-upgrade-"));
  const cacheFile = path.join(directory, "contracts.json");
  const requiredAttributes = [{
    key: "sonstiges.versand",
    label: "Versand",
    values: [
      { value: "ja", label: "Versand möglich" },
      { value: "nein", label: "Nur Abholung" },
    ],
  }];
  const legacyFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    categoryId: 87,
    requiredAttributes,
  })).digest("hex");
  fs.writeFileSync(cacheFile, JSON.stringify({
    87: {
      categoryId: 87,
      category: "Haus & Garten > Weiteres Haus & Garten",
      inspectionVersion: 2,
      verifiedAt: new Date().toISOString(),
      requiredAttributes,
      invalidatedAt: new Date().toISOString(),
      rejectedContractFingerprint: legacyFingerprint,
      attributeRejected: true,
      requiredCapabilities: ["shipping"],
    },
  }), { mode: 0o600 });
  const modulePath = require.resolve("../tools/kleinanzeigen-category-contracts");
  const script = `
    const contracts = require(${JSON.stringify(modulePath)});
    const refreshed = contracts.rememberCategoryRequirements({
      categoryId: 87,
      category: "Haus & Garten > Weiteres Haus & Garten",
      requiredAttributes: ${JSON.stringify(requiredAttributes)}
    });
    process.stdout.write(JSON.stringify({
      refreshed,
      current: contracts.getCategoryRequirements(87)
    }));
  `;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_KA_CATEGORY_CACHE_FILE: cacheFile },
    }));
    assert.equal(result.refreshed.inspectionVersion, 3);
    assert.equal(result.current.verified, true);
    assert.deepEqual(result.current.requiredAttributes, requiredAttributes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy dynamic contracts require one current form inspection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-category-legacy-"));
  const cacheFile = path.join(directory, "contracts.json");
  fs.writeFileSync(cacheFile, JSON.stringify({
    87: {
      categoryId: 87,
      category: "Haus & Garten > Weiteres Haus & Garten",
      verifiedAt: new Date().toISOString(),
      requiredAttributes: [],
    },
  }), { mode: 0o600 });
  const modulePath = require.resolve("../tools/kleinanzeigen-category-contracts");
  const script = `
    const result = require(${JSON.stringify(modulePath)}).getCategoryRequirements(87);
    process.stdout.write(JSON.stringify(result));
  `;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_KA_CATEGORY_CACHE_FILE: cacheFile },
    }));
    assert.equal(result.verified, false);
    assert.equal(result.stale, true);
    assert.match(result.instruction, /älteren Formularinspektion/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
