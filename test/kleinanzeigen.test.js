"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const KleinanzeigenClient = require("../tools/kleinanzeigen");

class StubClient extends KleinanzeigenClient {
  constructor() {
    super("user_id=42; CSRF-TOKEN=csrf-value", "bearer-token");
    this.calls = [];
    this.nextWww = { status: 200, body: {} };
    this.nextGateway = { status: 200, body: {} };
    this.nextCsrf = { status: 200, body: {} };
  }

  async _wwwRequest(method, requestPath, body) {
    this.calls.push({ transport: "www", method, path: requestPath, body });
    return this.nextWww;
  }

  async _gatewayRequest(method, requestPath, body) {
    this.calls.push({ transport: "gateway", method, path: requestPath, body });
    return this.nextGateway;
  }

  async _csrfWwwRequest(method, requestPath, body, headers) {
    this.calls.push({ transport: "csrf", method, path: requestPath, body, headers });
    return this.nextCsrf;
  }
}

test("search uses category slug, encoded keyword, pagination, and result mapping", async () => {
  const client = new StubClient();
  client.nextWww = {
    status: 200,
    body: { result: { resultList: [{ organicAdPreview: {
      id: 1,
      title: "Gravel Bike",
      price: "900 € VB",
      description: "Used",
      location: "Berlin",
      seoLink: "/s-anzeige/gravel-bike/1",
    } }] } },
  };
  const result = await client.searchAds({
    keyword: "gravel bike",
    categoryId: 217,
    categorySlug: "fahrraeder",
    page: 2,
    limit: 5,
  });
  assert.equal(client.calls[0].path, "/s-fahrraeder/seite:2/gravel%20bike/k0c217");
  assert.deepEqual(result[0], {
    id: 1,
    title: "Gravel Bike",
    price: "900 € VB",
    description: "Used",
    location: "Berlin",
    topAd: undefined,
    link: "https://www.kleinanzeigen.de/s-anzeige/gravel-bike/1",
  });
});

test("category-only search preserves Kleinanzeigen's s-k0 route", async () => {
  const client = new StubClient();
  client.nextWww = { status: 200, body: { result: { resultList: [] } } };
  assert.deepEqual(await client.searchAds({ categoryId: 22 }), []);
  assert.equal(client.calls[0].path, "/s-k0c22");
});

test("search rejects an HTML or otherwise malformed success response", async () => {
  const client = new StubClient();
  client.nextWww = { status: 200, body: "<html>challenge</html>" };
  await assert.rejects(() => client.searchAds({ keyword: "desk" }), /unerwartetes Antwortformat/);
});

test("gateway conversation calls validate IDs and map the other party", async () => {
  const client = new StubClient();
  client.nextGateway = { status: 200, body: { conversations: [{
    id: "conv/1",
    adId: 2,
    adTitle: "Desk",
    userIdBuyer: "42",
    role: "buyer",
    sellerName: "Alex",
    buyerName: "Jannik",
    textShortTrimmed: "Hallo",
    unread: true,
  }] } };
  const conversations = await client.getConversations({ limit: 500, offset: -1 });
  assert.equal(client.calls[0].path, "/messagebox/api/users/42/conversations?limit=100&offset=0");
  assert.equal(conversations[0].otherParty, "Alex");

  client.calls = [];
  client.nextGateway = { status: 200, body: { messages: [] } };
  await client.getMessages("conv/1", { limit: 2 });
  assert.equal(client.calls[0].path, "/messagebox/api/users/42/conversations/conv%2F1/messages?limit=2");
});

test("non-success reads throw instead of looking like empty data", async () => {
  const client = new StubClient();
  client.nextWww = { status: 500, body: { error: "down" } };
  await assert.rejects(() => client.getMyAds(), /getMyAds fehlgeschlagen \(500\)/);
});

test("publishing validates input and parses the returned ad link", async () => {
  const client = new StubClient();
  await assert.rejects(
    () => client.createAd({ title: "", description: "x", categoryId: 1, price: 10 }),
    /Titel fehlt/
  );
  await assert.rejects(
    () => client.createAd({ title: "x".repeat(61), description: "x", categoryId: 1, price: 10 }),
    /maximal 60 Zeichen/
  );
  client.nextCsrf = { status: 200, body: [{ success: 1, redirectUrl: 2 }, true, "/done?adId=12345"] };
  const result = await client.createAd({ title: "Desk", description: "Used desk", categoryId: 93, price: 25 });
  assert.deepEqual(result, { id: "12345", link: "https://www.kleinanzeigen.de/s-anzeige/12345" });

  client.nextCsrf = { status: 200, body: { success: true } };
  await assert.rejects(
    () => client.createAd({ title: "Desk", description: "Used desk", categoryId: 93, price: 25 }),
    /unerwartetes Antwortformat/
  );
});

test("draft operations require a user ID and encode draft IDs", async () => {
  const client = new StubClient();
  client.nextCsrf = { status: 204, body: {} };
  assert.deepEqual(await client.deleteDraft("draft/7"), { deleted: "draft/7" });
  assert.equal(client.calls[0].path, "/users/42/ad-drafts/draft%2F7.json");

  const missingUser = new KleinanzeigenClient("CSRF-TOKEN=csrf", "bearer");
  await assert.rejects(() => missingUser.getDrafts(), /user_id fehlt/);
});

test("upload rejects empty files before making a request", async () => {
  const client = new StubClient();
  await assert.rejects(() => client.uploadImage(Buffer.alloc(0)), /Bilddatei ist leer/);
  assert.equal(client.calls.length, 0);
});
