"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const KleinanzeigenClient = require("../tools/kleinanzeigen");

function accessToken({ expiresInSeconds = 3600, clientId = "client_id_123", userId = "42" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: "https://login.kleinanzeigen.de/",
    azp: clientId,
    exp: now + expiresInSeconds,
    iat: now,
    "https://www.kleinanzeigen.de/user_id": userId,
  })).toString("base64url");
  return `e30.${payload}.signature`;
}

class StubClient extends KleinanzeigenClient {
  constructor() {
    super("user_id=42; CSRF-TOKEN=csrf-value", "bearer-token");
    this.calls = [];
    this.nextWww = { status: 200, body: {} };
    this.nextGateway = { status: 200, body: {} };
    this.nextCsrf = { status: 200, body: {} };
  }

  async _wwwRequest(method, requestPath, body, options) {
    this.calls.push({ transport: "www", method, path: requestPath, body, options });
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
      seoLink: "/s-anzeige/gravel-bike/1-217-99",
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
  assert.deepEqual(client.calls[0].options, { authenticated: false });
  assert.deepEqual(result[0], {
    id: 1,
    title: "Gravel Bike",
    price: "900 € VB",
    description: "Used",
    location: "Berlin",
    categoryId: 217,
    topAd: undefined,
    link: "https://www.kleinanzeigen.de/s-anzeige/gravel-bike/1-217-99",
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

test("response cookies are merged without dropping the authenticated session", () => {
  const { mergeCookieHeader } = require("../tools/kleinanzeigen");
  assert.equal(
    mergeCookieHeader("session=old; CSRF-TOKEN=csrf", [
      "session=new; Path=/; Secure; HttpOnly",
      "postad=flow; Path=/; Secure",
      "obsolete=; Max-Age=0; Path=/",
    ]),
    "session=new; CSRF-TOKEN=csrf; postad=flow"
  );
});

test("HTTP access failures distinguish public blocks from expired credentials", () => {
  const { accessResponseError } = require("../tools/kleinanzeigen");
  const publicError = accessResponseError(403, { authenticated: false, transport: "cookie" });
  assert.equal(publicError.code, "KA_PUBLIC_ACCESS_DENIED");
  assert.doesNotMatch(publicError.message, /Session abgelaufen/);

  assert.equal(
    accessResponseError(401, { authenticated: true, transport: "cookie" }).code,
    "KA_SESSION_EXPIRED"
  );
  assert.equal(accessResponseError(401, { transport: "csrf" }).code, "KA_CSRF_EXPIRED");
  assert.equal(accessResponseError(401, { transport: "bearer" }).code, "KA_BEARER_EXPIRED");
  assert.equal(accessResponseError(403, { authenticated: true, transport: "csrf" }).code, "KA_SESSION_REJECTED");
  assert.equal(accessResponseError(429, { authenticated: true, transport: "bearer" }).code, "KA_ACCESS_DENIED");
  assert.equal(accessResponseError(500, { authenticated: false }), null);
});

test("OIDC refresh rotates tokens in memory without exposing them", async () => {
  const expired = accessToken({ expiresInSeconds: -60 });
  const fresh = accessToken({ expiresInSeconds: 3600 });
  const client = new KleinanzeigenClient(
    `CSRF-TOKEN=csrf; access_token=${expired}; refresh_token=refresh-old`,
    null
  );
  let submitted;
  client._oidcTokenRequest = async form => {
    submitted = form;
    return {
      status: 200,
      body: {
        access_token: fresh,
        refresh_token: "refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
      },
    };
  };

  const result = await client.refreshAccessToken();
  assert.deepEqual(submitted, {
    grant_type: "refresh_token",
    client_id: "client_id_123",
    refresh_token: "refresh-old",
  });
  assert.equal(client.bearerToken, fresh);
  assert.equal(client.refreshToken, "refresh-new");
  assert.match(client.cookies, /access_token=e30\./);
  assert.match(client.cookies, /refresh_token=refresh-new/);
  assert.equal(result.refreshTokenRotated, true);
  assert.equal(client.accessTokenExpiresWithin(), false);
});

test("expired local access tokens fail before a private web request", async () => {
  const expired = accessToken({ expiresInSeconds: -60 });
  const client = new KleinanzeigenClient(`CSRF-TOKEN=csrf; access_token=${expired}; refresh_token=refresh`);
  let requested = false;
  client._wwwRequest = async () => {
    requested = true;
    return { status: 200, body: { ads: [] } };
  };
  await assert.rejects(
    () => client.getMyAds(),
    error => error.code === "KA_SESSION_EXPIRED"
  );
  assert.equal(requested, false);
});

test("rejected OIDC refresh requires one manual login and is not retried", async () => {
  const expired = accessToken({ expiresInSeconds: -60 });
  const client = new KleinanzeigenClient(`access_token=${expired}; refresh_token=refresh-old`);
  let calls = 0;
  client._oidcTokenRequest = async () => {
    calls++;
    return { status: 400, body: { error: "invalid_grant" } };
  };
  await assert.rejects(
    () => client.refreshAccessToken(),
    error => error.code === "KA_REFRESH_EXPIRED" && /npm run login/.test(error.message)
  );
  assert.equal(calls, 1);
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

test("private ad reads use the current browser route including explicit sort", async () => {
  const client = new StubClient();
  client.nextWww = { status: 200, body: { ads: [] } };
  assert.deepEqual(await client.getMyAds(), []);
  assert.equal(client.calls[0].path, "/m-meine-anzeigen-verwalten.json?sort=DEFAULT");
});

test("publishing validates input and parses the returned ad link", async () => {
  const client = new StubClient();
  await assert.rejects(
    () => client.createAd({ title: "", description: "x", categoryId: 1, price: 10 }),
    /Titel fehlt/
  );
  await assert.rejects(
    () => client.createAd({ title: "x".repeat(66), description: "x", categoryId: 1, price: 10 }),
    /maximal 65 Zeichen/
  );
  await assert.rejects(
    () => client.createAd({ title: "Desk", description: "x", categoryId: 1, price: 10, zipCode: "123" }),
    /PLZ muss aus 5 Ziffern/
  );
  await assert.rejects(
    () => client.createAd({ title: "Desk", description: "x", categoryId: 1, price: 10.5 }),
    /ganze EUR-Zahl/
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

test("publishing checks known category requirements before any upload or submit request", async () => {
  const client = new StubClient();
  await assert.rejects(
    () => client.createAd({
      title: "Heißluftfritteuse",
      description: "Gebraucht und funktionsfähig.",
      categoryId: 176,
      price: 25,
    }),
    /haushaltsgeraete\.art/
  );
  assert.equal(client.calls.length, 0);

  client.nextCsrf = {
    status: 201,
    body: [{ success: 1, redirectUrl: 2 }, true, "/done?adId=17625"],
  };
  await client.createAd({
    title: "Heißluftfritteuse",
    description: "Gebraucht und funktionsfähig.",
    categoryId: 176,
    price: 25,
    attributes: {
      "haushaltsgeraete.art": "haushaltskleingeraete",
      "haushaltsgeraete.versand": "nein",
    },
  });
  const multipart = client.calls[0].body.toString("utf8");
  assert.match(multipart, /name="attributeMap\[haushaltsgeraete\.art\]"\r\n\r\nhaushaltskleingeraete/);
  assert.match(multipart, /name="attributeMap\[haushaltsgeraete\.versand\]"\r\n\r\nnein/);
});

test("publishing exposes structured server validation so a new category can self-heal", async () => {
  const client = new StubClient();
  client.nextCsrf = {
    status: 422,
    body: [
      { errors: 1 },
      [2, 5, 8],
      { field: 3, message: 4 },
      "attributeMap[moebel.art]",
      "Bitte wähle eine Art aus.",
      { field: 6, message: 7 },
      "attributeMap[moebel.versand]",
      "Bitte wähle eine Versandart aus.",
      { field: 9, message: 10 },
      "location",
      "Der Ort passt nicht zur Postleitzahl.",
    ],
  };

  await assert.rejects(
    () => client.createAd({
      title: "Regal",
      description: "Gebrauchtes Regal.",
      categoryId: 93,
      price: 20,
    }),
    error => {
      assert.equal(error.code, "KA_LISTING_VALIDATION");
      assert.equal(error.categoryId, 93);
      assert.deepEqual(error.validationErrors, [
        { field: "attributeMap[moebel.art]", message: "Bitte wähle eine Art aus." },
        { field: "attributeMap[moebel.versand]", message: "Bitte wähle eine Versandart aus." },
        { field: "location", message: "Der Ort passt nicht zur Postleitzahl." },
      ]);
      assert.deepEqual(error.recoveryAreas, ["category", "location"]);
      return true;
    }
  );
});

test("publishing hides upstream internals when Kleinanzeigen returns a server error", async () => {
  const client = new StubClient();
  client.nextCsrf = {
    status: 500,
    body: {
      type: "AstroActionError",
      message: "Failed to submit to https://desktop.internal.invalid/ads",
    },
  };
  await assert.rejects(
    () => client.createAd({
      title: "Regal",
      description: "Gebrauchtes Regal.",
      categoryId: 93,
      price: 20,
    }),
    error => {
      assert.equal(error.code, "KA_CREATE_SERVER_ERROR");
      assert.equal(error.status, 500);
      assert.match(error.message, /internen Serverfehler.*500/);
      assert.doesNotMatch(error.message, /AstroAction|desktop\.internal|https:/);
      return true;
    }
  );
});

test("publishing serializes the current web form contract", async () => {
  const client = new StubClient();
  client.nextCsrf = { status: 201, body: [{ success: 1, redirectUrl: 2 }, true, "/done?adId=987"] };
  await client.createAd({
    title: "Salewa Klettersteigset",
    description: "Zweimal benutzt, ohne Sturzbelastung.",
    categoryId: 230,
    price: 85,
    priceType: "NEGOTIABLE",
    zipCode: "80636",
    locationId: "16360",
    contactName: "Jannik",
    imageUrls: ["https://img.kleinanzeigen.de/example.jpg"],
    attributes: { "sport.condition": "used" },
  });
  const call = client.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/_actions/postListingWeb.submitListing/");
  assert.match(call.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  const multipart = call.body.toString("utf8");
  for (const [field, value] of [
    ["title", "Salewa Klettersteigset"],
    ["description", "Zweimal benutzt, ohne Sturzbelastung."],
    ["categoryId", "230"],
    ["priceAmount", "85"],
    ["priceType", "NEGOTIABLE"],
    ["zipCode", "80636"],
    ["locationId", "16360"],
    ["contactName", "Jannik"],
    ["adDraftUuid", ""],
    ["adId", ""],
    ["posterType", "PRIVATE"],
    ["attributeMap[sport.condition]", "used"],
    ["adImages[0].url", "https://img.kleinanzeigen.de/example.jpg"],
  ]) {
    assert.match(multipart, new RegExp(`name="${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\r\\n\\r\\n${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("draft, message, and delete writes use bounded encoded contracts", async () => {
  const client = new StubClient();
  client.nextCsrf = {
    status: 201,
    body: { result: { actionSuccessful: true }, adDraft: { id: "draft-1" } },
  };
  assert.deepEqual(await client.saveDraft({
    title: "Entwurf",
    description: "Noch unvollständig",
    categoryId: 230,
    priceAmount: 80,
    zipCode: "80636",
    locationId: "16360",
    imageUrls: ["https://img.kleinanzeigen.de/draft.jpg"],
  }), { draftId: "draft-1", imageCount: 1 });
  assert.equal(client.calls[0].path, "/users/42/ad-drafts.json");
  assert.deepEqual(client.calls[0].body.adImages, ["https://img.kleinanzeigen.de/draft.jpg"]);

  client.calls = [];
  client.nextGateway = { status: 201, body: { id: "message-1" } };
  assert.deepEqual(await client.sendMessage("conversation/1", "  Hallo!  "), { id: "message-1" });
  assert.equal(client.calls[0].path, "/messagebox/api/users/42/conversations/conversation%2F1/messages");
  assert.deepEqual(client.calls[0].body, { message: "Hallo!" });

  client.calls = [];
  client.nextCsrf = { status: 204, body: {} };
  assert.deepEqual(await client.deleteAd("12345"), { deleted: "12345", status: 204 });
  assert.equal(client.calls[0].path, "/m-anzeigen-loeschen.json?ids=12345");
  await assert.rejects(() => client.deleteAd("../123"), /ungültig/);
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
