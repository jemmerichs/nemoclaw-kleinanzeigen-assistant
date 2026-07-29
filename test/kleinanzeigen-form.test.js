"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeCategoryPath } = require("../tools/kleinanzeigen-form");

test("category form paths are bounded visible labels, not guessed internal IDs", () => {
  assert.deepEqual(
    normalizeCategoryPath([" Elektronik ", "Haushaltsgeräte", "Haushaltskleingeräte"]),
    ["Elektronik", "Haushaltsgeräte", "Haushaltskleingeräte"]
  );
  assert.deepEqual(normalizeCategoryPath(), []);
  assert.throws(() => normalizeCategoryPath("Elektronik"), /Liste sichtbarer Kategorienamen/);
  assert.throws(() => normalizeCategoryPath(Array(7).fill("Ebene")), /höchstens 6/);
  assert.throws(() => normalizeCategoryPath([""]), /categoryPath\[0\]/);
});
