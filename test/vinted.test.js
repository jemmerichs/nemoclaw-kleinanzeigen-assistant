"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const VintedClient = require("../tools/vinted");
const {
  extractProductCards,
  normalizeConversationPath,
  normalizeListingArgs,
  parseProductCard,
} = require("../tools/vinted");
const {
  extractVintedCookieString,
  requestFieldNames,
  safeVintedRoute,
  validatedVintedSession,
  vintedUserIdFromCookies,
} = require("../tools/vinted-auth");

test("Vinted session serialization keeps only exact Vinted domains", () => {
  const cookies = [
    { domain: ".vinted.de", name: "_vinted_fr_session", value: "session" },
    { domain: ".vinted.de", name: "v_uid", value: "3172002476" },
    { domain: "www.vinted.de", name: "cf_clearance", value: "clearance" },
    { domain: "evilvinted.de", name: "stolen", value: "no" },
    { domain: "example.com", name: "other", value: "no" },
  ];
  assert.equal(
    extractVintedCookieString(cookies),
    "_vinted_fr_session=session; v_uid=3172002476; cf_clearance=clearance"
  );
  assert.deepEqual(validatedVintedSession(cookies, "3172002476"), {
    cookieString: "_vinted_fr_session=session; v_uid=3172002476; cf_clearance=clearance",
    userId: "3172002476",
  });
  assert.deepEqual(validatedVintedSession(cookies, null), {
    cookieString: "_vinted_fr_session=session; v_uid=3172002476; cf_clearance=clearance",
    userId: "3172002476",
  });
  assert.equal(vintedUserIdFromCookies(cookies), "3172002476");
});

test("Vinted evidence capture records field names but not submitted values", () => {
  const request = {
    headers: () => ({ "content-type": "application/json" }),
    postData: () => JSON.stringify({
      item: {
        title: "secret title",
        description: "secret description",
        photos: [{ id: 1 }],
      },
    }),
  };
  assert.deepEqual(requestFieldNames(request), [
    "item",
    "item.description",
    "item.photos",
    "item.photos[]",
    "item.photos[].id",
    "item.title",
  ]);
  assert.deepEqual(safeVintedRoute("https://www.vinted.de/api/v2/items?foo=secret&page=2"), {
    host: "www.vinted.de",
    path: "/api/v2/items",
    queryKeys: ["foo", "page"],
  });
  assert.equal(safeVintedRoute("https://evilvinted.de/api/v2/items"), null);
});

test("Vinted listing validation covers current sell-form requirements", () => {
  const normalized = normalizeListingArgs({
    title: "Lenovo ThinkPad T14",
    description: "Gebraucht, sichtbarer Kratzer links.",
    category: "Laptops",
    categoryPath: "Electronics > Computers & accessories",
    brand: "Lenovo",
    condition: "Good",
    price: 275.555,
    packageTypeId: 8,
    imagePaths: ["/tmp/item.jpg"],
    attributes: {
      computer_storage_capacity: "512 GB",
      computer_ram: "16 GB",
    },
  });
  assert.equal(normalized.price, 275.56);
  assert.equal(normalized.packageTypeId, 8);
  assert.deepEqual(normalized.attributes, {
    computer_storage_capacity: "512 GB",
    computer_ram: "16 GB",
  });

  assert.throws(
    () => normalizeListingArgs({
      title: "Laptop",
      description: "Used",
      category: "Laptops",
      categoryPath: "Electronics > Computers & accessories",
      price: 100,
      imagePaths: ["/tmp/item.jpg"],
    }),
    /Zustand fehlt/
  );
  assert.throws(
    () => normalizeListingArgs({
      title: "Laptop",
      description: "Used",
      category: "Laptops",
      categoryPath: "Electronics > Computers & accessories",
      condition: "Excellent",
      price: 100,
      imagePaths: ["/tmp/item.jpg"],
    }),
    /Unbekannter Vinted-Zustand/
  );
  assert.throws(
    () => normalizeListingArgs({
      title: "Laptop",
      description: "Used",
      category: "Laptops",
      categoryPath: "Electronics > Computers & accessories",
      condition: "Good",
      price: 100,
      imagePaths: [],
    }),
    /mindestens ein Bild/
  );
  assert.equal(normalizeListingArgs({ title: "Entwurf" }, { draft: true }).title, "Entwurf");
});

test("Vinted catalogue cards map stable IDs, seller price, and promotion state", () => {
  const item = parseProductCard({
    link: "https://www.vinted.de/items/9403176154-lenovo-thinkpad?referrer=catalog",
    label: "Lenovo Thinkpad T14 G1, brand: Lenovo, model: ThinkPad T14, condition: Very good, €1,100.00, €1,155.70 includes Buyer Protection, Bumped",
    imageUrl: "https://images1.vinted.net/example.webp",
    details: ["Lenovo ThinkPad T14", "Bumped", "Very good", "€1,100.00"],
  });
  assert.deepEqual(item, {
    id: "9403176154",
    title: "Lenovo Thinkpad T14 G1",
    brand: "Lenovo",
    model: "ThinkPad T14",
    condition: "Very good",
    size: "",
    price: 1100,
    promoted: true,
    imageUrl: "https://images1.vinted.net/example.webp",
    link: "https://www.vinted.de/items/9403176154-lenovo-thinkpad",
    visibleDetails: ["Lenovo ThinkPad T14", "Bumped", "Very good", "€1,100.00"],
  });
  assert.equal(parseProductCard({
    link: "https://www.vinted.de/items/2-deutscher-preis",
    label: "ThinkPad, condition: Good, 1.100,00 €",
  }).price, 1100);
});

test("Vinted result extraction is bounded and ignores malformed cards", async () => {
  const page = {
    async evaluate(_callback, limit) {
      assert.equal(limit, 2);
      return [
        {
          link: "https://www.vinted.de/items/1-first?referrer=catalog",
          label: "First item, condition: Good, €12.50, €13.83 includes Buyer Protection",
          imageUrl: "https://images1.vinted.net/1.webp",
          details: ["First item", "Good", "€12.50"],
        },
        { link: "https://www.vinted.de/member/1", label: "not an item" },
      ];
    },
  };
  const items = await extractProductCards(page, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "1");
  assert.equal(items[0].price, 12.5);
});

test("Vinted conversation paths cannot escape the inbox", () => {
  assert.equal(normalizeConversationPath("/inbox/123-message"), "/inbox/123-message");
  assert.throws(() => normalizeConversationPath("https://evil.example/inbox/1"), /ungültig/);
  assert.throws(() => normalizeConversationPath("/member/1"), /ungültig/);
});

test("Vinted browser client fails closed on a challenge page", async () => {
  let closed = false;
  const page = {
    goto: async () => ({ status: () => 403 }),
    title: async () => "Just a moment...",
    url: () => "https://www.vinted.de/",
  };
  const client = new VintedClient({
    openProfile: async () => ({ page }),
    closeProfile: async () => { closed = true; },
  });
  await assert.rejects(() => client._withPage("https://www.vinted.de/", async () => null), error => {
    assert.equal(error.code, "VINTED_ACCESS_DENIED");
    return true;
  });
  assert.equal(closed, true);
});

test("Vinted account verification uses the saved numeric profile route", async () => {
  let target = "";
  let closed = false;
  const heading = {
    waitFor: async () => {},
    innerText: async () => "jaem001",
  };
  const page = {
    goto: async url => {
      target = url;
      return { status: () => 200 };
    },
    title: async () => "jaem001 - member profile | Vinted",
    url: () => target,
    getByRole: () => ({ first: () => heading }),
  };
  const client = new VintedClient({
    userId: "3172002476",
    openProfile: async () => ({ page }),
    closeProfile: async () => { closed = true; },
  });
  assert.deepEqual(await client.getCurrentUser(), {
    id: "3172002476",
    login: "jaem001",
    profilePath: "/member/3172002476",
  });
  assert.equal(target, "https://www.vinted.de/member/3172002476");
  assert.equal(closed, true);
});
