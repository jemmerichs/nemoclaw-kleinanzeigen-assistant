"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  browserCookiesFromHeader,
  ensureCategoryBrowserSession,
  normalizeCategoryPath,
} = require("../tools/kleinanzeigen-form");

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

test("category browser cookies are derived from the validated API session", () => {
  assert.deepEqual(
    browserCookiesFromHeader("CSRF-TOKEN=csrf; user_id=42; compound=a=b"),
    [
      { name: "CSRF-TOKEN", value: "csrf", url: "https://www.kleinanzeigen.de" },
      { name: "user_id", value: "42", url: "https://www.kleinanzeigen.de" },
      { name: "compound", value: "a=b", url: "https://www.kleinanzeigen.de" },
    ]
  );
  assert.throws(
    () => browserCookiesFromHeader("CSRF-TOKEN=csrf"),
    /user_id oder ableitbare access_token-Identität fehlt/
  );
});

test("category inspection reuses a valid imported session when the profile is signed out", async () => {
  let stored = [{ domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "stale" }];
  let additions = 0;
  const context = {
    async cookies() {
      return stored;
    },
    async addCookies(cookies) {
      additions++;
      stored = cookies.map(cookie => ({
        domain: "www.kleinanzeigen.de",
        name: cookie.name,
        value: cookie.value,
      }));
    },
  };

  assert.deepEqual(
    await ensureCategoryBrowserSession(context, "CSRF-TOKEN=fresh; user_id=42"),
    { source: "environment" }
  );
  assert.equal(additions, 1);
  assert.deepEqual(
    stored.map(cookie => cookie.name),
    ["CSRF-TOKEN", "user_id"]
  );
});

test("category inspection leaves an already authenticated profile untouched", async () => {
  let additions = 0;
  const context = {
    async cookies() {
      return [
        { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "csrf" },
        { domain: ".kleinanzeigen.de", name: "user_id", value: "42" },
      ];
    },
    async addCookies() {
      additions++;
    },
  };

  assert.deepEqual(
    await ensureCategoryBrowserSession(context, ""),
    { source: "profile" }
  );
  assert.equal(additions, 0);
});
