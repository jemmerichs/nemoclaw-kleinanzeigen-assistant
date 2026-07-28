"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { smokeDiagnosis } = require("../scripts/smoke-ka");

test("smoke diagnosis distinguishes DNS from a login failure", () => {
  const error = new Error("getaddrinfo ENOTFOUND www.kleinanzeigen.de");
  error.code = "ENOTFOUND";
  const diagnosis = smokeDiagnosis([error]);
  assert.match(diagnosis, /DNS-Diagnose/);
  assert.match(diagnosis, /kein Loginfehler/);
  assert.doesNotMatch(diagnosis, /npm run login' erneuert/);
});

test("smoke diagnosis distinguishes access blocks, session expiry, and timeouts", () => {
  const blocked = new Error("Öffentlicher Zugriff abgelehnt");
  blocked.code = "KA_ACCESS_DENIED";
  assert.match(smokeDiagnosis([blocked]), /Zugriffsdiagnose/);

  const expired = new Error("Bearer token abgelaufen (401)");
  expired.code = "KA_BEARER_EXPIRED";
  assert.match(smokeDiagnosis([expired]), /Session-Diagnose/);
  assert.match(smokeDiagnosis([new Error("Token-Refresh fehlgeschlagen (401)")]), /Session-Diagnose/);

  assert.match(smokeDiagnosis([new Error("GET www.kleinanzeigen.de: Timeout")]), /Netzwerkdiagnose/);
  assert.equal(smokeDiagnosis([]), null);
});
