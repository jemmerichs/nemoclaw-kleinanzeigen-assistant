"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertOnlyRequestedFormChanges,
  editFormUrl,
  editTimeoutError,
  normalizeAdEditAction,
  normalizeAdEditArgs,
  normalizeEditError,
} = require("../tools/kleinanzeigen-edit-form");
const { classifyError } = require("../tools/safe-error");

const baseEntries = [
  ["adType", "OFFER"],
  ["title", "Bisheriger Titel"],
  ["categoryId", "87"],
  ["description", "Bisherige Beschreibung"],
  ["priceAmount", "6"],
  ["priceType", "FIXED"],
  ["zipCode", "80636"],
  ["locationId", "16360"],
  ["contactName", "Jannik"],
  ["adId", "3487180022"],
];

test("live-ad edits accept title, description, or both through one narrow contract", () => {
  assert.deepEqual(normalizeAdEditArgs({
    adId: " 3487180022 ",
    title: " Neuer Titel ",
  }), { adId: "3487180022", title: "Neuer Titel" });

  assert.deepEqual(normalizeAdEditAction({
    adId: "3487180022",
    previousTitle: "Bisheriger Titel",
    description: " Neue Beschreibung ",
  }), {
    adId: "3487180022",
    previousTitle: "Bisheriger Titel",
    title: "Bisheriger Titel",
    description: "Neue Beschreibung",
  });

  assert.throws(
    () => normalizeAdEditArgs({ adId: "3487180022" }),
    /Mindestens title oder description/
  );
  assert.throws(
    () => normalizeAdEditAction({
      adId: "3487180022",
      previousTitle: "Gleich",
      title: "Gleich",
    }),
    /identisch/
  );
  assert.equal(
    editFormUrl("3487180022"),
    "https://www.kleinanzeigen.de/p-anzeige-bearbeiten.html?adId=3487180022"
  );
});

test("the final form gate permits only the requested title and description changes", () => {
  const after = baseEntries.map(([name, value]) => {
    if (name === "title") return [name, "Neuer Titel"];
    if (name === "description") return [name, "Neue Beschreibung"];
    return [name, value];
  });
  assert.equal(assertOnlyRequestedFormChanges(baseEntries, after, {
    adId: "3487180022",
    previousTitle: "Bisheriger Titel",
    title: "Neuer Titel",
    description: "Neue Beschreibung",
  }), true);

  const changedPrice = after.map(([name, value]) => (
    name === "priceAmount" ? [name, "7"] : [name, value]
  ));
  assert.throws(
    () => assertOnlyRequestedFormChanges(baseEntries, changedPrice, {
      adId: "3487180022",
      previousTitle: "Bisheriger Titel",
      title: "Neuer Titel",
      description: "Neue Beschreibung",
    }),
    error => error.code === "KA_EDIT_PRECHECK_FAILED" && /priceAmount/.test(error.message)
  );
});

test("description-only edits cannot accidentally alter the title", () => {
  const after = baseEntries.map(([name, value]) => (
    name === "description" ? [name, "Neue Beschreibung"] : [name, value]
  ));
  assert.equal(assertOnlyRequestedFormChanges(baseEntries, after, {
    adId: "3487180022",
    previousTitle: "Bisheriger Titel",
    description: "Neue Beschreibung",
  }), true);

  const staleTitle = baseEntries.map(([name, value]) => (
    name === "title" ? [name, "Manuell geändert"] : [name, value]
  ));
  assert.throws(
    () => assertOnlyRequestedFormChanges(staleTitle, after, {
      adId: "3487180022",
      previousTitle: "Bisheriger Titel",
      description: "Neue Beschreibung",
    }),
    /seit der Freigabe geändert/
  );
});

test("edit failures distinguish safe preflight stops from ambiguous saves", () => {
  const beforeSave = normalizeEditError(new Error("Form missing"), {
    precheckStep: "verify_form",
  });
  assert.equal(beforeSave.code, "KA_EDIT_PRECHECK_FAILED");
  assert.equal(beforeSave.definitiveNoWrite, true);
  assert.equal(classifyError(beforeSave, {
    phase: "preflight",
    requestStarted: true,
  }).writeCertainty, "definitive_no_write");

  const afterSave = normalizeEditError(new Error("Page closed"), {
    editRequestStarted: true,
  });
  assert.equal(afterSave.code, "KA_EDIT_OUTCOME_UNKNOWN");
  assert.equal(classifyError(afterSave, {
    phase: "commit",
    requestStarted: true,
  }).writeCertainty, "ambiguous");

  assert.equal(editTimeoutError().definitiveNoWrite, true);
  assert.equal(editTimeoutError({ editRequestStarted: true }).code, "KA_EDIT_OUTCOME_UNKNOWN");
});
