"use strict";

const crypto = require("crypto");
const { accessTokenMetadata } = require("./kleinanzeigen");

function cookieValues(rawHeader) {
  const values = new Map();
  for (const part of String(rawHeader || "").split(";")) {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return values;
}

function sessionAuthFingerprint(rawHeader) {
  const values = cookieValues(rawHeader);
  const accessToken = values.get("access_token") || "";
  const refreshToken = values.get("refresh_token") || "";
  if (!accessToken && !refreshToken) return "";
  return crypto
    .createHash("sha256")
    .update(`${accessToken}\0${refreshToken}`)
    .digest("hex");
}

function sessionAccessMetadata(rawHeader) {
  return accessTokenMetadata(cookieValues(rawHeader).get("access_token"));
}

function shouldPreferStoredSession(currentHeader, storedHeader) {
  const currentFingerprint = sessionAuthFingerprint(currentHeader);
  const storedFingerprint = sessionAuthFingerprint(storedHeader);
  if (!storedFingerprint || storedFingerprint === currentFingerprint) return false;

  const current = sessionAccessMetadata(currentHeader);
  const stored = sessionAccessMetadata(storedHeader);
  if (!stored?.issuedAt || !stored?.expiresAt) return false;
  if (!current?.issuedAt || !current?.expiresAt) return true;
  return stored.issuedAt > current.issuedAt
    || (stored.issuedAt === current.issuedAt && stored.expiresAt > current.expiresAt);
}

function expiresAtFromClient(client) {
  const metadata = sessionAccessMetadata(client?.cookies);
  return metadata?.expiresAt
    ? new Date(metadata.expiresAt * 1000).toISOString()
    : null;
}

function hasFreshAccessToken(rawHeader, minimumLifetimeSeconds = 300) {
  const metadata = sessionAccessMetadata(rawHeader);
  return Boolean(
    metadata?.expiresAt
    && metadata.expiresAt > Math.floor(Date.now() / 1000) + minimumLifetimeSeconds
  );
}

async function refreshKleinanzeigenClient(currentClient, {
  loadStoredCookieHeader,
  createClient,
} = {}) {
  if (!currentClient || typeof currentClient.refreshAccessToken !== "function") {
    throw new Error("Aktuelle Kleinanzeigen-Sitzung fehlt.");
  }
  if (typeof loadStoredCookieHeader !== "function" || typeof createClient !== "function") {
    throw new Error("Kleinanzeigen-Sitzungserneuerung ist nicht vollständig konfiguriert.");
  }

  let client = currentClient;
  let adoptedStoredSession = false;
  const storedHeader = String(loadStoredCookieHeader() || "");
  if (shouldPreferStoredSession(client.cookies, storedHeader)) {
    client = createClient(storedHeader);
    adoptedStoredSession = true;
    if (hasFreshAccessToken(client.cookies)) {
      return {
        client,
        adoptedStoredSession,
        refreshed: false,
        expiresAt: expiresAtFromClient(client),
      };
    }
  }

  const attemptedFingerprint = sessionAuthFingerprint(client.cookies);
  try {
    const refreshed = await client.refreshAccessToken();
    return { client, adoptedStoredSession, refreshed: true, ...refreshed };
  } catch (error) {
    if (error?.code !== "KA_REFRESH_EXPIRED") throw error;

    // A separate `npm run refresh-auth` or login can rotate the refresh token
    // while the long-running bot still holds the old one. Re-read the canonical
    // file once and only retry when its authentication material actually changed.
    const fallbackHeader = String(loadStoredCookieHeader() || "");
    const fallbackFingerprint = sessionAuthFingerprint(fallbackHeader);
    if (!fallbackFingerprint || fallbackFingerprint === attemptedFingerprint) throw error;

    const fallbackClient = createClient(fallbackHeader);
    if (hasFreshAccessToken(fallbackClient.cookies)) {
      return {
        client: fallbackClient,
        adoptedStoredSession: true,
        refreshed: false,
        expiresAt: expiresAtFromClient(fallbackClient),
      };
    }
    const refreshed = await fallbackClient.refreshAccessToken();
    return {
      client: fallbackClient,
      adoptedStoredSession: true,
      refreshed: true,
      ...refreshed,
    };
  }
}

module.exports = {
  hasFreshAccessToken,
  refreshKleinanzeigenClient,
  sessionAccessMetadata,
  sessionAuthFingerprint,
  shouldPreferStoredSession,
};
