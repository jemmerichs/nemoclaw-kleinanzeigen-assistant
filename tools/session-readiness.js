"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { atomicWriteJson } = require("../workspace/runtime");
const {
  sessionAccessMetadata,
  sessionAuthFingerprint,
} = require("./kleinanzeigen-session");

const DEFAULT_EVIDENCE_TTL_MS = 30 * 60 * 1000;
const LOGIN_REQUIRED_CODES = new Set([
  "KA_BEARER_EXPIRED",
  "KA_CSRF_EXPIRED",
  "KA_REFRESH_EXPIRED",
  "KA_SESSION_EXPIRED",
]);
const READINESS_FILE = process.env.NEMOCLAW_READINESS_FILE
  ? path.resolve(process.env.NEMOCLAW_READINESS_FILE)
  : path.resolve(__dirname, "../workspace/readiness.json");

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function accountFromSession(cookieHeader) {
  const direct = cookieValue(cookieHeader, "user_id");
  if (direct) return direct;
  try {
    const token = cookieValue(cookieHeader, "access_token");
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return String(payload["https://www.kleinanzeigen.de/user_id"] || payload.sub || "unknown");
  } catch {
    return "unknown";
  }
}

function sessionRevision(cookieHeader, { provider = "kleinanzeigen", userAgent = "" } = {}) {
  const auth = sessionAuthFingerprint(cookieHeader);
  if (!auth) return "unavailable";
  return crypto.createHash("sha256")
    .update(`${provider}\0${accountFromSession(cookieHeader)}\0${auth}\0${String(userAgent)}`)
    .digest("hex");
}

function classifyReadiness({ privateReadOk, refreshAttempted = false, refreshOk = null } = {}) {
  if (!privateReadOk) return "unavailable";
  if (refreshAttempted && refreshOk === false) return "degraded";
  return "ready";
}

function isLoginRequiredError(error) {
  return LOGIN_REQUIRED_CODES.has(String(error?.code || ""));
}

function createEvidence({
  provider = "kleinanzeigen",
  capability = "private_read",
  account = "unknown",
  sessionRevision: revision,
  privateReadOk,
  refreshAttempted = false,
  refreshOk = null,
  checkedAt = new Date().toISOString(),
  expiresAt = null,
  formFingerprint = null,
  safeDetail = null,
  loginRequired = false,
} = {}) {
  if (!revision) throw new Error("Session-Revision fehlt für Readiness-Evidenz.");
  return {
    provider: String(provider),
    capability: String(capability),
    account: String(account || "unknown"),
    sessionRevision: String(revision),
    state: classifyReadiness({ privateReadOk, refreshAttempted, refreshOk }),
    privateReadOk: Boolean(privateReadOk),
    refreshAttempted: Boolean(refreshAttempted),
    refreshOk: refreshAttempted ? Boolean(refreshOk) : null,
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    formFingerprint: formFingerprint ? String(formFingerprint) : null,
    safeDetail: safeDetail ? String(safeDetail).slice(0, 300) : null,
    loginRequired: !privateReadOk && Boolean(loginRequired),
  };
}

async function evaluatePrivateRead({
  provider = "kleinanzeigen",
  capability = "private_read",
  cookieHeader,
  userAgent = "",
  privateRead,
  refresh = null,
  proactiveRefresh = false,
  now = Date.now(),
} = {}) {
  if (typeof privateRead !== "function") throw new Error("Private Read-Prüfung fehlt.");
  const currentCookieHeader = () => (
    typeof cookieHeader === "function" ? cookieHeader() : cookieHeader
  );
  let readOk = false;
  let readError = null;
  let refreshAttempted = false;
  let refreshOk = null;
  let refreshError = null;
  try {
    await privateRead();
    readOk = true;
  } catch (error) {
    readError = error;
  }

  if ((proactiveRefresh || !readOk) && typeof refresh === "function") {
    refreshAttempted = true;
    try {
      await refresh();
      refreshOk = true;
      if (!readOk) {
        await privateRead();
        readOk = true;
        readError = null;
      }
    } catch (error) {
      refreshOk = false;
      refreshError = error;
      if (!readError) readError = error;
    }
  }

  const resolvedCookieHeader = currentCookieHeader();
  const metadata = sessionAccessMetadata(resolvedCookieHeader);
  const revision = sessionRevision(resolvedCookieHeader, { provider, userAgent });
  return createEvidence({
    provider,
    capability,
    account: accountFromSession(resolvedCookieHeader),
    sessionRevision: revision,
    privateReadOk: readOk,
    refreshAttempted,
    refreshOk,
    checkedAt: now,
    expiresAt: metadata?.expiresAt ? metadata.expiresAt * 1000 : null,
    safeDetail: readOk
      ? refreshOk === false ? "Private Read funktioniert; vorsorgliche Erneuerung ist nicht verfügbar." : null
      : "Die aktuelle Session kann den privaten Read nicht ausführen.",
    loginRequired: !readOk && (
      isLoginRequiredError(readError) || isLoginRequiredError(refreshError)
    ),
  });
}

function readOperationalState(filePath = READINESS_FILE) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return state && !Array.isArray(state) && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function writeOperationalState(state, filePath = READINESS_FILE) {
  atomicWriteJson(filePath, state || {});
  return state;
}

function recordDoctorEvidence(evidence, { filePath = READINESS_FILE } = {}) {
  const state = readOperationalState(filePath);
  state.doctorEvidence = evidence;
  state.updatedAt = new Date().toISOString();
  writeOperationalState(state, filePath);
  return evidence;
}

function evidenceIsFresh(evidence, {
  sessionRevision: revision,
  maximumAgeMs = DEFAULT_EVIDENCE_TTL_MS,
  now = Date.now(),
} = {}) {
  if (!evidence || !["ready", "degraded"].includes(evidence.state)) return false;
  if (String(evidence.sessionRevision) !== String(revision)) return false;
  const checkedAt = Date.parse(evidence.checkedAt);
  return Number.isFinite(checkedAt) && Number(now) - checkedAt <= Number(maximumAgeMs);
}

module.exports = {
  DEFAULT_EVIDENCE_TTL_MS,
  READINESS_FILE,
  accountFromSession,
  classifyReadiness,
  createEvidence,
  evaluatePrivateRead,
  evidenceIsFresh,
  isLoginRequiredError,
  readOperationalState,
  recordDoctorEvidence,
  sessionRevision,
  writeOperationalState,
};
