"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertNetworkAccess,
  classifyAccessProblem,
  extractCookieHeaderFromCurl,
  extractKaCookieString,
  requestMetadataFromCurl,
  validatedCookieHeader,
  validatedFreshSessionCookieString,
  validatedSessionCookieString,
} = require("../tools/auth");

function accessPage({ title = "", bodyText = "", url = "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html" } = {}) {
  return {
    async title() { return title; },
    locator() {
      return { async innerText() { return bodyText; } };
    },
    url() { return url; },
  };
}

test("auth serializes only Kleinanzeigen cookies and deduplicates names", () => {
  const cookies = [
    { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "old" },
    { domain: "www.kleinanzeigen.de", name: "CSRF-TOKEN", value: "new" },
    { domain: "login.kleinanzeigen.de", name: "user_id", value: "42" },
    { domain: "evilkleinanzeigen.de", name: "injected", value: "bad" },
    { domain: "example.com", name: "other", value: "bad" },
  ];
  assert.equal(
    extractKaCookieString(cookies),
    "CSRF-TOKEN=new; user_id=42"
  );
});

test("auth refuses a partial browser session", () => {
  assert.throws(
    () => validatedSessionCookieString([{ domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "csrf" }]),
    /user_id oder ableitbare access_token-Identität fehlt/
  );
  assert.equal(
    validatedSessionCookieString([
      { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "csrf" },
      { domain: ".kleinanzeigen.de", name: "user_id", value: "42" },
      { domain: ".kleinanzeigen.de", name: "access_token", value: "a.b.c" },
      { domain: ".kleinanzeigen.de", name: "refresh_token", value: "refresh" },
    ]),
    "CSRF-TOKEN=csrf; user_id=42; access_token=a.b.c; refresh_token=refresh"
  );
});

test("auth accepts the current session shape with user identity in the bearer JWT", () => {
  const payload = Buffer.from(JSON.stringify({
    "https://www.kleinanzeigen.de/user_id": 42,
  })).toString("base64url");
  const accessToken = `e30.${payload}.signature`;
  assert.equal(
    validatedCookieHeader(`CSRF-TOKEN=csrf; access_token=${accessToken}; refresh_token=refresh`),
    `CSRF-TOKEN=csrf; access_token=${accessToken}; refresh_token=refresh`
  );
});

test("interactive login rejects complete-looking stale cookies until the access token is fresh", () => {
  const token = expiresAt => {
    const payload = Buffer.from(JSON.stringify({
      iss: "https://login.kleinanzeigen.de/",
      azp: "client_id_123",
      iat: expiresAt - 3600,
      exp: expiresAt,
      "https://www.kleinanzeigen.de/user_id": 42,
    })).toString("base64url");
    return `e30.${payload}.signature`;
  };
  const cookies = accessToken => [
    { domain: ".kleinanzeigen.de", name: "CSRF-TOKEN", value: "csrf" },
    { domain: ".kleinanzeigen.de", name: "user_id", value: "42" },
    { domain: ".kleinanzeigen.de", name: "access_token", value: accessToken },
    { domain: ".kleinanzeigen.de", name: "refresh_token", value: "refresh" },
  ];
  const now = Math.floor(Date.now() / 1000);
  assert.throws(
    () => validatedFreshSessionCookieString(cookies(token(now - 60))),
    /noch nicht frisch/
  );
  assert.match(
    validatedFreshSessionCookieString(cookies(token(now + 3600))),
    /access_token=/
  );
});

test("auth recognizes blocked network responses without retrying login", () => {
  assert.equal(classifyAccessProblem({ status: 403 }), "HTTP 403");
  assert.equal(classifyAccessProblem({ status: 429 }), "HTTP 429");
  assert.equal(
    classifyAccessProblem({ title: "Zugriff verweigert", bodyText: "Dein IP-Bereich ist gesperrt." }),
    '"ip-bereich ist gesperrt"'
  );
  assert.equal(
    classifyAccessProblem({ status: 200, title: "Bei Kleinanzeigen einloggen", bodyText: "Sicher einloggen" }),
    null
  );
});

test("authenticated browser 403 is not mislabeled as an IP block", async () => {
  const response = { status: () => 403 };
  await assert.rejects(
    () => assertNetworkAccess(accessPage(), response, { authenticated: true }),
    error => {
      assert.equal(error.code, "KA_BROWSER_REJECTED");
      assert.equal(error.status, 403);
      assert.match(error.message, /belegt weder .*IP-Sperre/);
      assert.doesNotMatch(error.message, /Browser-Fingerabdruck|erneuert werden/);
      assert.doesNotMatch(error.message, /blockiert diesen Netzwerkpfad/);
      return true;
    }
  );
});

test("authenticated block page without a response handle stays a private-access failure", async () => {
  await assert.rejects(
    () => assertNetworkAccess(accessPage({ bodyText: "Zugriff verweigert." }), null, {
      authenticated: true,
    }),
    error => {
      assert.equal(error.code, "KA_BROWSER_REJECTED");
      assert.equal(error.status, undefined);
      assert.match(error.message, /belegt weder .*IP-Sperre/);
      return true;
    }
  );
});

test("public browser 403 remains a network-path access failure", async () => {
  const response = { status: () => 403 };
  await assert.rejects(
    () => assertNetworkAccess(accessPage(), response),
    error => {
      assert.equal(error.code, "KA_ACCESS_DENIED");
      assert.match(error.message, /blockiert diesen Netzwerkpfad/);
      return true;
    }
  );
});

test("auth imports a Chrome Copy-as-cURL cookie header without executing it", () => {
  const curl = [
    "curl 'https://www.kleinanzeigen.de/m-meine-anzeigen-verwalten.json' \\",
    "  -H 'accept: application/json' \\",
    "  -H 'accept-language: de-DE,de;q=0.9' \\",
    "  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' \\",
    "  -H 'sec-ch-ua: \"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"' \\",
    "  -H 'sec-ch-ua-mobile: ?0' \\",
    "  -H 'sec-ch-ua-platform: \"macOS\"' \\",
    "  -H 'cookie: foo=bar; user_id=42; CSRF-TOKEN=csrf%20value; access_token=a.b.c; refresh_token=refresh'",
  ].join("\n");
  assert.equal(
    extractCookieHeaderFromCurl(curl),
    "foo=bar; user_id=42; CSRF-TOKEN=csrf%20value; access_token=a.b.c; refresh_token=refresh"
  );
  assert.deepEqual(requestMetadataFromCurl(curl), {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    acceptLanguage: "de-DE,de;q=0.9",
    secChUa: "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"",
    secChUaMobile: "?0",
    secChUaPlatform: "\"macOS\"",
  });
});

test("auth rejects clipboard input without a complete session", () => {
  assert.throws(() => extractCookieHeaderFromCurl("curl https://example.com"), /Kein Cookie-Header/);
  assert.throws(() => validatedCookieHeader("user_id=42"), /CSRF-TOKEN.*fehlt/);
  assert.throws(
    () => extractCookieHeaderFromCurl("curl 'x' -H 'cookie: user_id=42; CSRF-TOKEN=ok\nINJECTED=1'"),
    /Zeilenumbrüche|Kein Cookie-Header/
  );
});
