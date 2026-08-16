"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { kleinanzeigenListingConfig } = require("../tools/listing-config");

test("listing configuration reports the exact non-secret readiness problems", () => {
  assert.deepEqual(
    kleinanzeigenListingConfig({
      KA_DEFAULT_ZIP_CODE: "00000",
      KA_DEFAULT_LOCATION_ID: "",
      KA_CONTACT_NAME: "",
    }).problems,
    ["gültige Standard-PLZ", "interne Kleinanzeigen-Orts-ID", "Profilname"]
  );

  const duplicated = kleinanzeigenListingConfig({
    KA_DEFAULT_ZIP_CODE: "80636",
    KA_DEFAULT_LOCATION_ID: "80636",
    KA_CONTACT_NAME: "Jannik",
  });
  assert.equal(duplicated.ready, false);
  assert.deepEqual(duplicated.problems, ["eigenständige Kleinanzeigen-Orts-ID (nicht die PLZ)"]);

  assert.deepEqual(
    kleinanzeigenListingConfig({
      KA_DEFAULT_ZIP_CODE: "80636",
      KA_DEFAULT_LOCATION_ID: "1".repeat(51),
      KA_CONTACT_NAME: "J".repeat(31),
    }).problems,
    ["gültige interne Kleinanzeigen-Orts-ID", "gültiger Profilname (maximal 30 Zeichen)"]
  );

  const ready = kleinanzeigenListingConfig({
    KA_DEFAULT_ZIP_CODE: "80636",
    KA_DEFAULT_LOCATION_ID: "16360",
    KA_CONTACT_NAME: "Jannik",
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.problems, []);
});
