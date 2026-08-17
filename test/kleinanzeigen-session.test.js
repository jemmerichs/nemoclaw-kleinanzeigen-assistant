"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  refreshKleinanzeigenClient,
  sessionAuthFingerprint,
  shouldPreferStoredSession,
} = require("../tools/kleinanzeigen-session");

function accessToken({ issuedAt, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({
    iss: "https://login.kleinanzeigen.de/",
    azp: "client_id_123",
    iat: issuedAt,
    exp: expiresAt,
    "https://www.kleinanzeigen.de/user_id": "42",
  })).toString("base64url");
  return `e30.${payload}.signature`;
}

function sessionHeader({ issuedAt, expiresAt, refreshToken }) {
  return [
    "CSRF-TOKEN=csrf",
    "user_id=42",
    `access_token=${accessToken({ issuedAt, expiresAt })}`,
    `refresh_token=${refreshToken}`,
  ].join("; ");
}

function stubClient(cookies, { expiring = true, refreshError = null } = {}) {
  return {
    cookies,
    refreshCalls: 0,
    accessTokenExpiresWithin() { return expiring; },
    async refreshAccessToken() {
      this.refreshCalls++;
      if (refreshError) throw refreshError;
      return {
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshTokenRotated: true,
      };
    },
  };
}

test("a newer externally refreshed session replaces stale in-memory auth", async () => {
  const now = Math.floor(Date.now() / 1000);
  const staleHeader = sessionHeader({
    issuedAt: now - 7200,
    expiresAt: now - 3600,
    refreshToken: "stale-refresh",
  });
  const storedHeader = sessionHeader({
    issuedAt: now - 1800,
    expiresAt: now + 120,
    refreshToken: "stored-refresh",
  });
  const staleClient = stubClient(staleHeader);
  const storedClient = stubClient(storedHeader);

  assert.equal(shouldPreferStoredSession(staleHeader, storedHeader), true);
  const result = await refreshKleinanzeigenClient(staleClient, {
    loadStoredCookieHeader: () => storedHeader,
    createClient: header => {
      assert.equal(header, storedHeader);
      return storedClient;
    },
  });

  assert.equal(result.client, storedClient);
  assert.equal(result.adoptedStoredSession, true);
  assert.equal(result.refreshed, true);
  assert.equal(staleClient.refreshCalls, 0);
  assert.equal(storedClient.refreshCalls, 1);
});

test("a refresh rejection adopts a token rotated by another process instead of demanding login", async () => {
  const now = Math.floor(Date.now() / 1000);
  const staleHeader = sessionHeader({
    issuedAt: now - 7200,
    expiresAt: now - 3600,
    refreshToken: "stale-refresh",
  });
  const freshHeader = sessionHeader({
    issuedAt: now - 10,
    expiresAt: now + 3600,
    refreshToken: "fresh-refresh",
  });
  const rejected = new Error("invalid_grant");
  rejected.code = "KA_REFRESH_EXPIRED";
  const staleClient = stubClient(staleHeader, { refreshError: rejected });
  const freshClient = stubClient(freshHeader, { expiring: false });
  let reads = 0;

  const result = await refreshKleinanzeigenClient(staleClient, {
    loadStoredCookieHeader: () => (++reads === 1 ? staleHeader : freshHeader),
    createClient: header => {
      assert.equal(header, freshHeader);
      return freshClient;
    },
  });

  assert.equal(result.client, freshClient);
  assert.equal(result.refreshed, false);
  assert.equal(staleClient.refreshCalls, 1);
  assert.equal(freshClient.refreshCalls, 0);
  assert.notEqual(sessionAuthFingerprint(staleHeader), sessionAuthFingerprint(freshHeader));
});

test("an unchanged rejected refresh token is attempted only once", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = sessionHeader({
    issuedAt: now - 7200,
    expiresAt: now - 3600,
    refreshToken: "rejected-refresh",
  });
  const rejected = new Error("invalid_grant");
  rejected.code = "KA_REFRESH_EXPIRED";
  const client = stubClient(header, { refreshError: rejected });

  await assert.rejects(
    () => refreshKleinanzeigenClient(client, {
      loadStoredCookieHeader: () => header,
      createClient: () => { throw new Error("must not create a duplicate client"); },
    }),
    error => error === rejected
  );
  assert.equal(client.refreshCalls, 1);
});
