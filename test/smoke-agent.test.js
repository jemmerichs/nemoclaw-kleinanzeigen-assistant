"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { smokePrompt, verifySmokeResult } = require("../scripts/smoke-agent");

function fixture(categoryId = 230) {
  const images = ["/images/one.jpg", "/images/two.jpg"];
  const result = {
    route: { tier: "fast", model: "google/gemini-3.6-flash" },
    toolCalls: ["ka_search_ads", "ka_prepare_listing", "ka_publish_prepared_listing"],
    toolTrace: [
      {
        tool: "ka_search_ads",
        args: { keyword: "item" },
        result: { count: 3, categoryIds: [230, 231] },
      },
      { tool: "ka_prepare_listing", ok: true },
      { tool: "ka_publish_prepared_listing", staged: true },
    ],
  };
  const pending = {
    id: "abc123",
    tool: "ka_publish_prepared_listing",
    materials: images.map(path => ({ path, size: 10, sha256: "a".repeat(64) })),
    args: {
      preparationId: "0".repeat(24),
      category: "Haus & Garten > Test",
      delivery: "pickup_only",
      listing: {
        title: "Testartikel",
        description: "Ehrliche Beschreibung",
        categoryId,
        price: 50,
        zipCode: "80636",
        locationId: "16360",
        contactName: "Test",
        imagePaths: images,
      },
    },
  };
  const listing = pending.args.listing;
  const proposal = [
    listing.title,
    `Kategorie: ${pending.args.category}`,
    `Fotos: ${listing.imagePaths.length} (one.jpg sha256:aaaaaaaaaaaa, two.jpg sha256:aaaaaaaaaaaa)`,
    listing.description,
    "Dry-run ist aktiv",
  ].join("\n");
  return {
    result,
    pending,
    images,
    expectedModel: "google/gemini-3.6-flash",
    proposal,
  };
}

test("agent smoke context cannot replace price research and preparation requirements", () => {
  const prompt = smokePrompt(["a".repeat(24), "b".repeat(24)], "Dunkelgrün muss erwähnt werden.");
  assert.match(prompt, /recherchiere vergleichbare aktuelle Angebote/);
  assert.match(prompt, /Zusätzlicher Testkontext: Dunkelgrün/);
  assert.match(prompt, /ka_prepare_listing/);
  assert.equal((prompt.match(/\[MEDIA id:/g) || []).length, 2);
});

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
  subset.pending.args.listing.imagePaths = [subset.images[1]];
  subset.pending.materials = [subset.pending.materials[1]];
  subset.proposal = subset.proposal.replace("Fotos: 2", "Fotos: 1");
  assert.doesNotThrow(() => verifySmokeResult(subset));

  const derivative = fixture();
  derivative.pending.args.listing.imagePaths = ["/images/edited-one.jpg"];
  derivative.pending.materials = [{
    path: "/images/edited-one.jpg",
    size: 10,
    sha256: "b".repeat(64),
  }];
  derivative.imageSourceResolver = () => derivative.images[0];
  derivative.proposal = derivative.proposal.replace("Fotos: 2", "Fotos: 1");
  assert.doesNotThrow(() => verifySmokeResult(derivative));

  const unknown = fixture();
  unknown.pending.args.listing.imagePaths = ["/images/unknown.jpg"];
  unknown.pending.materials = [{
    path: "/images/unknown.jpg",
    size: 10,
    sha256: "c".repeat(64),
  }];
  assert.throws(() => verifySmokeResult(unknown), /nicht aus dem Testalbum/);
});

test("agent smoke verifier requires exact proposal fields and requested condition facts", () => {
  const valid = fixture();
  valid.pending.args.listing.description = "Ehrliche Beschreibung mit sichtbarem Lackabplatzer.";
  valid.proposal = valid.proposal.replace(
    "Ehrliche Beschreibung",
    valid.pending.args.listing.description
  );
  valid.requiredFacts = ["Lackabplatzer"];
  assert.doesNotThrow(() => verifySmokeResult(valid));

  const omittedFact = fixture();
  omittedFact.requiredFacts = ["Lackabplatzer"];
  assert.throws(
    () => verifySmokeResult(omittedFact),
    /Pflichtfakt fehlt in der Anzeigenbeschreibung/
  );

  const missingManifest = fixture();
  missingManifest.proposal = missingManifest.proposal.replace(/sha256:[a-f0-9]+/gi, "ohne-hash");
  assert.throws(
    () => verifySmokeResult(missingManifest),
    /kein gebundenes Foto-Hash-Manifest/
  );
});
