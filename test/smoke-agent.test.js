"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { verifySmokeResult } = require("../scripts/smoke-agent");

function fixture(categoryId = 230) {
  const images = ["/images/one.jpg", "/images/two.jpg"];
  const result = {
    route: { tier: "fast", model: "google/gemini-3.6-flash" },
    toolCalls: ["ka_search_ads", "ka_create_ad"],
    toolTrace: [
      {
        tool: "ka_search_ads",
        args: { keyword: "item" },
        result: { count: 3, categoryIds: [230, 231] },
      },
      { tool: "ka_create_ad", staged: true },
    ],
  };
  const pending = {
    tool: "ka_create_ad",
    materials: images.map(path => ({ path, size: 10, sha256: "a".repeat(64) })),
    args: {
      title: "Testartikel",
      description: "Ehrliche Beschreibung",
      categoryId,
      price: 50,
      zipCode: "80636",
      locationId: "16360",
      contactName: "Test",
      imagePaths: images,
    },
  };
  return { result, pending, images, expectedModel: "google/gemini-3.6-flash" };
}

test("agent smoke verifier binds the staged category to observed search results", () => {
  assert.doesNotThrow(() => verifySmokeResult(fixture()));
  assert.throws(
    () => verifySmokeResult(fixture(999)),
    /Kategorie 999 kam nicht in den Suchergebnissen vor/
  );
});

test("agent smoke verifier rejects missing image manifests and expensive routing", () => {
  const missingManifest = fixture();
  missingManifest.pending.materials.pop();
  assert.throws(() => verifySmokeResult(missingManifest), /Bild-Manifeste fehlen/);

  const highRoute = fixture();
  highRoute.result.route.tier = "high";
  assert.throws(() => verifySmokeResult(highRoute), /unerwartet geroutet/);
});

test("agent smoke verifier accepts a subset or derivative but rejects unknown photos", () => {
  const subset = fixture();
  subset.pending.args.imagePaths = [subset.images[1]];
  subset.pending.materials = [subset.pending.materials[1]];
  assert.doesNotThrow(() => verifySmokeResult(subset));

  const derivative = fixture();
  derivative.pending.args.imagePaths = ["/images/edited-one.jpg"];
  derivative.pending.materials = [{
    path: "/images/edited-one.jpg",
    size: 10,
    sha256: "b".repeat(64),
  }];
  derivative.imageSourceResolver = () => derivative.images[0];
  assert.doesNotThrow(() => verifySmokeResult(derivative));

  const unknown = fixture();
  unknown.pending.args.imagePaths = ["/images/unknown.jpg"];
  unknown.pending.materials = [{
    path: "/images/unknown.jpg",
    size: 10,
    sha256: "c".repeat(64),
  }];
  assert.throws(() => verifySmokeResult(unknown), /nicht aus dem Testalbum/);
});
