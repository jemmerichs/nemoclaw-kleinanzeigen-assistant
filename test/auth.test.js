"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyAccessProblem,
  extractCookieHeaderFromCurl,
  extractKaCookieString,
  requestMetadataFromCurl,
  validatedCookieHeader,
  validatedSessionCookieString,
} = require("../tools/auth");

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
    ]),
    "CSRF-TOKEN=csrf; user_id=42"
  );
});

test("auth accepts the current session shape with user identity in the bearer JWT", () => {
  const payload = Buffer.from(JSON.stringify({
    "https://www.kleinanzeigen.de/user_id": 42,
  })).toString("base64url");
  const accessToken = `e30.${payload}.signature`;
  assert.equal(
    validatedCookieHeader(`CSRF-TOKEN=csrf; access_token=${accessToken}`),
    `CSRF-TOKEN=csrf; access_token=${accessToken}`
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

test("auth imports a Chrome Copy-as-cURL cookie header without executing it", () => {
  const curl = [
    "curl 'https://www.kleinanzeigen.de/m-meine-anzeigen-verwalten.json' \\",
    "  -H 'accept: application/json' \\",
    "  -H 'accept-language: de-DE,de;q=0.9' \\",
    "  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' \\",
    "  -H 'sec-ch-ua: \"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"' \\",
    "  -H 'sec-ch-ua-mobile: ?0' \\",
    "  -H 'sec-ch-ua-platform: \"macOS\"' \\",
    "  -H 'cookie: foo=bar; user_id=42; CSRF-TOKEN=csrf%20value; access_token=a.b.c'",
  ].join("\n");
  assert.equal(
    extractCookieHeaderFromCurl(curl),
    "foo=bar; user_id=42; CSRF-TOKEN=csrf%20value; access_token=a.b.c"
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
  assert.throws(() => validatedCookieHeader("user_id=42"), /CSRF-TOKEN fehlt/);
  assert.throws(
    () => extractCookieHeaderFromCurl("curl 'x' -H 'cookie: user_id=42; CSRF-TOKEN=ok\nINJECTED=1'"),
    /Zeilenumbrüche|Kein Cookie-Header/
  );
});
