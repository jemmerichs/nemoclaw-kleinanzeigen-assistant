"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { kleinanzeigenListingConfig } = require("../tools/listing-config");

test("listing configuration reports the exact non-secret readiness problems", () => {
  assert.deepEqual(
    kleinanzeigenListingConfig({
      KA_DEFAULT_ZIP_CODE: "00000",
      KA_CONTACT_NAME: "",
    }).problems,
    ["gültige Standard-PLZ", "Profilname"]
  );

  const duplicated = kleinanzeigenListingConfig({
    KA_DEFAULT_ZIP_CODE: "80636",
    KA_CONTACT_NAME: "Jannik",
  });
  assert.equal(duplicated.ready, true);
  assert.deepEqual(duplicated.problems, []);

  assert.deepEqual(
    kleinanzeigenListingConfig({
      KA_DEFAULT_ZIP_CODE: "80636",
      KA_CONTACT_NAME: "J".repeat(31),
    }).problems,
    ["gültiger Profilname (maximal 30 Zeichen)"]
  );

  const ready = kleinanzeigenListingConfig({
    KA_DEFAULT_ZIP_CODE: "80636",
    KA_CONTACT_NAME: "Jannik",
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.problems, []);
});
