"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONFIRM_FLAG,
  assertNaturalExternalContent,
  naturalListing,
  newDraftsSince,
  requireExplicitConfirmation,
  verifiedCreatedDraft,
} = require("../scripts/e2e-ka-draft");

test("real draft E2E requires an explicit external-write flag", () => {
  assert.throws(() => requireExplicitConfirmation([]), /echte Bilder.*echten Kleinanzeigen-Entwurf/);
  assert.doesNotThrow(() => requireExplicitConfirmation([CONFIRM_FLAG]));
});

test("external draft content contains no technical marker", () => {
  const listing = naturalListing([]);
  assert.equal(assertNaturalExternalContent(listing), true);
  assert.doesNotMatch(`${listing.title}\n${listing.description}`, /canary|e2e|smoke|test|timestamp|zeitstempel/i);
  assert.throws(
    () => assertNaturalExternalContent({ title: "Canary-Lampe", description: "Normal" }),
    /Testmarkierung/
  );
});

test("a natural unused title is selected without appending an identifier", () => {
  const first = naturalListing([]);
  const second = naturalListing([{ id: "old", title: first.title }]);
  assert.notEqual(second.title, first.title);
  assert.doesNotMatch(second.title, /\d{4,}|[-_][a-f0-9]{6,}/i);
});

test("draft verification is bound to the one new remote ID and all listing fields", () => {
  const listing = {
    ...naturalListing([]),
    imagePaths: ["front", "rear", "defect"],
  };
  const before = [{ id: "old", title: "Vorhanden" }];
  const created = {
    id: "new",
    title: listing.title,
    categoryId: 82,
    priceAmount: listing.price,
    priceType: listing.priceType,
    images: 3,
  };
  assert.deepEqual(newDraftsSince(before, [...before, created]), [created]);
  assert.deepEqual(verifiedCreatedDraft(before, [...before, created], listing, "new"), created);
  assert.throws(
    () => verifiedCreatedDraft(before, [...before, { ...created, images: 2 }], listing, "new"),
    /nicht eindeutig/
  );
});
