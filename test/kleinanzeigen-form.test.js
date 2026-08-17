"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  browserCookiesFromHeader,
  ensureCategoryBrowserSession,
  inspectionSessionMatchesPath,
  normalizeCategoryPath,
  preparedFormSessionMatches,
  selectCategoryPath,
  waitForCategoryLinks,
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

test("a prepared visible form is reused only for its exact approval binding", () => {
  const session = {
    closed: false,
    readyForm: {
      categoryId: 87,
      categoryPath: ["Haus & Garten", "Weiteres Haus & Garten"],
      formFingerprint: "form-fingerprint",
      sessionRevision: "session-revision",
    },
  };
  const binding = {
    categoryId: 87,
    categoryPath: ["Haus & Garten", "Weiteres Haus & Garten"],
    formFingerprint: "form-fingerprint",
    sessionRevision: "session-revision",
  };
  assert.equal(preparedFormSessionMatches(session, binding), true);
  assert.equal(preparedFormSessionMatches(session, { ...binding, categoryId: 88 }), false);
  assert.equal(preparedFormSessionMatches(session, {
    ...binding,
    categoryPath: ["Haus & Garten", "Möbel"],
  }), false);
  assert.equal(preparedFormSessionMatches(session, {
    ...binding,
    formFingerprint: "changed",
  }), false);
  assert.equal(preparedFormSessionMatches({ ...session, closed: true }, binding), false);
});

test("category-answer follow-ups keep the already visible category form", () => {
  const selecting = {
    selectedLabels: ["Haus & Garten"],
    selectedTokens: ["80"],
  };
  assert.equal(inspectionSessionMatchesPath(selecting, [
    "Haus & Garten",
    "Weiteres Haus & Garten",
  ]), true);

  const ready = {
    ...selecting,
    selectedLabels: ["Haus & Garten", "Weiteres Haus & Garten"],
    readyForm: { categoryId: 87 },
  };
  assert.equal(inspectionSessionMatchesPath(ready, [
    "Haus & Garten",
    "Weiteres Haus & Garten",
  ]), true);
  assert.equal(inspectionSessionMatchesPath(ready, ["Haus & Garten", "Möbel"]), false);
});

test("leaf category selection continues to the real listing form before inspection", async () => {
  const state = {
    depth: 0,
    categoryId: "",
    formReady: false,
    continueClicks: 0,
    waitedForForm: false,
  };
  const choices = [
    {
      label: "Haus & Garten",
      href: "#?path=80&isParent=true",
      tokens: ["80"],
      isParent: true,
      active: false,
    },
    {
      label: "Weiteres Haus & Garten",
      href: "#?path=80/87&isParent=undefined",
      tokens: ["80", "87"],
      isParent: false,
      active: false,
    },
  ];
  const page = {
    locator(selector) {
      if (selector === 'main a[href^="#?path="]') {
        return { async evaluateAll() { return choices; } };
      }
      if (selector.startsWith("main a[href=")) {
        return {
          async count() { return 1; },
          async click() {
            state.depth++;
            if (state.depth === 2) state.categoryId = "87";
          },
        };
      }
      if (selector === 'input[name="categoryId"]') {
        return {
          async count() { return 1; },
          async inputValue() { return state.categoryId; },
        };
      }
      if (selector === 'input[name="title"]') {
        return {
          async count() { return state.formReady ? 1 : 0; },
          async waitFor() {
            assert.equal(state.formReady, true);
            state.waitedForForm = true;
          },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name.test("Weiter zur Anzeige"), true);
      return {
        async count() { return 1; },
        async click() {
          state.continueClicks++;
          state.formReady = true;
        },
      };
    },
  };

  const result = await selectCategoryPath(page, [
    "Haus & Garten",
    "Weiteres Haus & Garten",
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.selectedPath, ["Haus & Garten", "Weiteres Haus & Garten"]);
  assert.equal(state.continueClicks, 1);
  assert.equal(state.waitedForForm, true);
});

test("leaf category selection tolerates the current form appearing asynchronously", async () => {
  let categoryId = "";
  let formReady = false;
  let categoryReads = 0;
  let formReads = 0;
  const page = {
    locator(selector) {
      if (selector === 'main a[href^="#?path="]') {
        return { async evaluateAll() {
          return [{
            label: "Wohnzimmer",
            href: "#?path=80/88&isParent=false",
            tokens: ["80", "88"],
            isParent: false,
            active: false,
          }];
        } };
      }
      if (selector.startsWith("main a[href=")) {
        return {
          async count() { return 1; },
          async click() { categoryId = "88"; },
        };
      }
      if (selector === 'input[name="categoryId"]') {
        return {
          async count() { return 1; },
          async inputValue() {
            categoryReads++;
            return categoryReads > 1 ? categoryId : "";
          },
        };
      }
      if (selector === 'input[name="title"]') {
        return {
          async count() {
            formReads++;
            if (formReads > 2) formReady = true;
            return formReady ? 1 : 0;
          },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name.test("Weiter"), true);
      return { async count() { return 0; } };
    },
  };

  const result = await selectCategoryPath(page, ["Haus & Garten", "Wohnzimmer"], {
    selectedLabels: ["Haus & Garten"],
    selectedTokens: ["80"],
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.selectedPath, ["Haus & Garten", "Wohnzimmer"]);
  assert.equal(formReady, true);
});

test("category browser cookies are derived from the validated API session", () => {
  assert.deepEqual(
    browserCookiesFromHeader("CSRF-TOKEN=csrf; user_id=42; access_token=a.b.c; refresh_token=refresh; compound=a=b"),
    [
      { name: "CSRF-TOKEN", value: "csrf", url: "https://www.kleinanzeigen.de" },
      { name: "user_id", value: "42", url: "https://www.kleinanzeigen.de" },
      { name: "access_token", value: "a.b.c", url: "https://www.kleinanzeigen.de" },
      { name: "refresh_token", value: "refresh", url: "https://www.kleinanzeigen.de" },
      { name: "compound", value: "a=b", url: "https://www.kleinanzeigen.de" },
    ]
  );
  assert.throws(
    () => browserCookiesFromHeader("CSRF-TOKEN=csrf"),
    /user_id oder ableitbare access_token-Identität fehlt/
  );
});

test("category picker waits for client-rendered category links", async () => {
  let attached = false;
  const locator = {
    first() {
      return {
        async waitFor(options) {
          assert.deepEqual(options, { state: "attached", timeout: 250 });
          attached = true;
        },
      };
    },
    async count() { return attached ? 15 : 0; },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, 'main a[href^="#?path="]');
      return locator;
    },
  };

  const result = await waitForCategoryLinks(page, 250);
  assert.equal(await result.count(), 15);
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
    await ensureCategoryBrowserSession(context, "CSRF-TOKEN=fresh; user_id=42; access_token=a.b.c; refresh_token=refresh"),
    { source: "environment" }
  );
  assert.equal(additions, 1);
  assert.deepEqual(
    stored.map(cookie => cookie.name),
    ["CSRF-TOKEN", "user_id", "access_token", "refresh_token"]
  );
});

test("category inspection leaves an already authenticated profile untouched", async () => {
  let additions = 0;
  const context = {
    async cookies() {
      return [
        { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "csrf" },
        { domain: ".kleinanzeigen.de", name: "user_id", value: "42" },
        { domain: ".kleinanzeigen.de", name: "access_token", value: "a.b.c" },
        { domain: ".kleinanzeigen.de", name: "refresh_token", value: "refresh" },
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

test("category inspection replaces an older profile session with a newer stored session", async () => {
  const token = ({ issuedAt, expiresAt }) => {
    const payload = Buffer.from(JSON.stringify({
      iss: "https://login.kleinanzeigen.de/",
      azp: "client_id_123",
      iat: issuedAt,
      exp: expiresAt,
      "https://www.kleinanzeigen.de/user_id": "42",
    })).toString("base64url");
    return `e30.${payload}.signature`;
  };
  const now = Math.floor(Date.now() / 1000);
  let stored = [
    { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "old-csrf" },
    { domain: ".kleinanzeigen.de", name: "user_id", value: "42" },
    { domain: ".kleinanzeigen.de", name: "access_token", value: token({ issuedAt: now - 7200, expiresAt: now - 3600 }) },
    { domain: ".kleinanzeigen.de", name: "refresh_token", value: "refresh-old" },
  ];
  const freshHeader = [
    "CSRF-TOKEN=fresh-csrf",
    "user_id=42",
    `access_token=${token({ issuedAt: now - 60, expiresAt: now + 3600 })}`,
    "refresh_token=refresh-new",
  ].join("; ");
  let additions = 0;
  const context = {
    async cookies() { return stored; },
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
    await ensureCategoryBrowserSession(context, freshHeader),
    { source: "environment" }
  );
  assert.equal(additions, 1);
  assert.equal(stored.find(cookie => cookie.name === "refresh_token").value, "refresh-new");
});
