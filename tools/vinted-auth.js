"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const {
  findChromeExecutable,
  saveToEnv,
  systemChromeUserAgent,
} = require("./auth");

const PROFILE_DIR = path.resolve(__dirname, "../workspace/vinted-browser-profile");
const EVIDENCE_FILE = path.resolve(__dirname, "../workspace/vinted-api-evidence.json");
const DEVTOOLS_ACTIVE_PORT_FILE = path.join(PROFILE_DIR, "DevToolsActivePort");
const VINTED_ORIGIN = "https://www.vinted.de";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ACCEPT_LANGUAGE = "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";
const MAX_COOKIE_HEADER_BYTES = 65_536;
const MAX_EVIDENCE_ENTRIES = 300;

function delay(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs));
}

function isVintedDomain(domain) {
  const normalized = String(domain || "").replace(/^\./, "").toLowerCase();
  return normalized === "vinted.de" || normalized.endsWith(".vinted.de");
}

function extractVintedCookieString(cookies) {
  const values = new Map();
  for (const cookie of cookies || []) {
    if (!isVintedDomain(cookie.domain) || !/^[A-Za-z0-9_.-]{1,128}$/.test(String(cookie.name || ""))) {
      continue;
    }
    const value = String(cookie.value || "");
    if (value.length > 16_384) continue;
    values.set(String(cookie.name), value);
  }
  const header = [...values].map(([name, value]) => `${name}=${value}`).join("; ");
  if (Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES) {
    throw new Error("Vinted-Cookie-Header ist größer als 64 KB.");
  }
  return header;
}

function vintedUserIdFromCookies(cookies) {
  const cookie = (cookies || []).find(value => (
    isVintedDomain(value.domain) && value.name === "v_uid"
  ));
  if (!cookie) return "";
  let value = String(cookie.value || "");
  try { value = decodeURIComponent(value); } catch {}
  const match = value.match(/(?:^|[^\d])(\d{3,30})(?:[^\d]|$)/);
  return match ? match[1] : "";
}

function validatedVintedSession(cookies, userId) {
  const cookieString = extractVintedCookieString(cookies);
  if (!cookieString) throw new Error("Keine Vinted-Cookies im dedizierten Profil gefunden.");
  const resolvedUserId = /^\d+$/.test(String(userId || ""))
    ? String(userId)
    : vintedUserIdFromCookies(cookies);
  return {
    cookieString,
    userId: resolvedUserId,
  };
}

function atomicWritePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function nestedFieldNames(value, prefix = "", depth = 0, output = []) {
  if (depth > 4 || output.length >= 100 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    if (prefix) output.push(`${prefix}[]`);
    for (const item of value.slice(0, 2)) nestedFieldNames(item, `${prefix}[]`, depth + 1, output);
    return output;
  }
  if (typeof value !== "object") {
    if (prefix) output.push(prefix);
    return output;
  }
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    output.push(childPrefix);
    nestedFieldNames(child, childPrefix, depth + 1, output);
  }
  return output;
}

function requestFieldNames(request) {
  const contentType = String(request.headers()["content-type"] || "").toLowerCase();
  const body = request.postData() || "";
  if (!body) return [];
  try {
    if (contentType.includes("application/json")) {
      return sortedUnique(nestedFieldNames(JSON.parse(body)));
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return sortedUnique([...new URLSearchParams(body).keys()]);
    }
    if (contentType.includes("multipart/form-data")) {
      return sortedUnique(
        [...body.matchAll(/(?:^|\r\n)Content-Disposition:[^\r\n]*\bname="([^"\r\n]{1,200})"/gi)]
          .map(match => match[1])
      );
    }
  } catch {}
  return [];
}

function publicResponseShape(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      itemKeys: sortedUnique(
        value.slice(0, 3).flatMap(item =>
          item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : []
        )
      ).slice(0, 100),
    };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).sort().slice(0, 100) };
  }
  return { type: typeof value };
}

function safeVintedRoute(rawUrl) {
  const url = new URL(rawUrl);
  if (!isVintedDomain(url.hostname)) return null;
  const queryKeys = sortedUnique([...url.searchParams.keys()]);
  return {
    host: url.hostname,
    path: url.pathname,
    queryKeys,
  };
}

function installEvidenceRecorder(page, entries) {
  const pending = new Set();

  page.on("response", response => {
    const task = (async () => {
      const request = response.request();
      const route = safeVintedRoute(request.url());
      if (!route || entries.length >= MAX_EVIDENCE_ENTRIES) return;
      const contentType = String(response.headers()["content-type"] || "").split(";", 1)[0];
      const entry = {
        at: new Date().toISOString(),
        ...route,
        method: request.method(),
        status: response.status(),
        requestContentType: String(request.headers()["content-type"] || "").split(";", 1)[0],
        requestFields: requestFieldNames(request),
        responseContentType: contentType,
      };
      if (
        contentType === "application/json" &&
        request.method() === "GET" &&
        !/(?:inbox|message|conversation|order|transaction|wallet|payment)/i.test(route.path)
      ) {
        try {
          entry.responseShape = publicResponseShape(await response.json());
        } catch {}
      }
      entries.push(entry);
    })().finally(() => pending.delete(task));
    pending.add(task);
  });

  return async () => {
    await Promise.allSettled([...pending]);
    return entries;
  };
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Das dedizierte Vinted-Chrome-Profil wurde nicht rechtzeitig freigegeben.")),
      timeoutMs
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForDevToolsEndpoint(child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Das dedizierte Vinted-Chrome-Fenster wurde vor dem Verbindungsaufbau geschlossen.");
    }
    try {
      const [port] = fs.readFileSync(DEVTOOLS_ACTIVE_PORT_FILE, "utf8").trim().split(/\r?\n/);
      if (/^\d{2,5}$/.test(port) && Number(port) <= 65_535) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Das dedizierte Vinted-Chrome-Fenster konnte nicht lokal validiert werden.");
}

function profileInUseError(error) {
  if (!/singleton|profile.*(?:in use|locked)|browser.*closed/i.test(String(error?.message || error))) {
    return null;
  }
  return new Error(
    "Das dedizierte Vinted-Chrome-Profil ist noch geöffnet. Schließe dieses Fenster vollständig und versuche es erneut."
  );
}

async function openNativeProfile({ headless = false, url = VINTED_ORIGIN } = {}) {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Google Chrome/Chromium wurde nicht gefunden.");
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PROFILE_DIR, 0o700);
  try { fs.unlinkSync(DEVTOOLS_ACTIVE_PORT_FILE); } catch {}

  const child = spawn(executablePath, [
    `--user-data-dir=${PROFILE_DIR}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new"] : ["--new-window"]),
    url,
  ], { stdio: "ignore" });
  let browser;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  try {
    const endpoint = await waitForDevToolsEndpoint(child);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Das dedizierte Vinted-Chrome-Profil konnte nicht geöffnet werden.");
    const pages = context.pages();
    const page = pages.find(candidate => candidate.url().includes("vinted.de")) || pages[0];
    if (!page) throw new Error("Das dedizierte Vinted-Tab wurde nicht gefunden.");
    return { browser, child, context, page };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForChildExit(child).catch(() => {});
    throw profileInUseError(error) || error;
  }
}

async function openUnobservedProfile(url = VINTED_ORIGIN) {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Google Chrome/Chromium wurde nicht gefunden.");
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PROFILE_DIR, 0o700);
  const child = spawn(executablePath, [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--window-size=1280,900",
    "--new-window",
    url,
  ], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  return child;
}

async function closeNativeProfile(nativeProfile) {
  if (!nativeProfile) return;
  const { browser, child } = nativeProfile;
  let browserClose = null;
  if (browser) {
    browserClose = browser.close().catch(() => {});
    await Promise.race([browserClose, delay(5_000)]);
  }
  try {
    await waitForChildExit(child, 5_000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForChildExit(child).catch(() => {});
  } finally {
    if (browserClose) await Promise.race([browserClose, delay(1_000)]);
    try { fs.unlinkSync(DEVTOOLS_ACTIVE_PORT_FILE); } catch {}
  }
}

async function persistSession(context, user) {
  const cookies = await context.cookies(VINTED_ORIGIN);
  const { cookieString, userId } = validatedVintedSession(cookies, user?.id);
  saveToEnv({
    VINTED_COOKIES: cookieString,
    VINTED_USER_ID: userId || null,
    VINTED_USER_AGENT: systemChromeUserAgent(),
    VINTED_ACCEPT_LANGUAGE: DEFAULT_ACCEPT_LANGUAGE,
  });
  return { userId, login: user?.login || "", cookieCount: cookies.filter(cookie => isVintedDomain(cookie.domain)).length };
}

async function loginWithSystemChrome() {
  const child = await openUnobservedProfile(VINTED_ORIGIN);
  console.log("[vinted-auth] Gewöhnliches dediziertes Chrome-Fenster geöffnet (ohne Browser-Steuerung).");
  console.log("[vinted-auth] Bitte Vinted dort manuell einloggen und 2FA/CAPTCHA selbst abschließen.");
  console.log("[vinted-auth] Danach dieses dedizierte Chrome-Fenster vollständig schließen; erst dann wird die Sitzung importiert.");
  try {
    await waitForChildExit(child, LOGIN_TIMEOUT_MS);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw error;
  }
  return importSessionFromProfile();
}

async function importSessionFromProfile() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("Kein Vinted-Browserprofil gefunden.");
  }
  let nativeProfile;
  try {
    nativeProfile = await openNativeProfile({ headless: true, url: "about:blank" });
    const session = await persistSession(nativeProfile.context, null);
    console.log(`[vinted-auth] ${session.cookieCount} Vinted-Cookies aus dem geschlossenen Profil gespeichert.`);
    console.log(
      session.userId
        ? "[vinted-auth] Numerische Benutzer-ID aus den gespeicherten Vinted-Sessiondaten übernommen."
        : "[vinted-auth] Die Benutzer-ID wird beim read-only Smoke-Test über Vinted validiert."
    );
    return session;
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

async function inspectProfileSession() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  let nativeProfile;
  try {
    nativeProfile = await openNativeProfile({ headless: true, url: "about:blank" });
    const cookies = await nativeProfile.context.cookies(VINTED_ORIGIN);
    return cookies
      .filter(cookie => isVintedDomain(cookie.domain))
      .map(cookie => ({ domain: cookie.domain, name: cookie.name }))
      .sort((left, right) => `${left.domain}/${left.name}`.localeCompare(`${right.domain}/${right.name}`));
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

async function refreshSession() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("Kein Vinted-Browserprofil gefunden — bitte zuerst 'npm run login:vinted' ausführen.");
  }
  return importSessionFromProfile();
}

module.exports = {
  DEFAULT_ACCEPT_LANGUAGE,
  EVIDENCE_FILE,
  PROFILE_DIR,
  closeNativeProfile,
  extractVintedCookieString,
  inspectProfileSession,
  importSessionFromProfile,
  installEvidenceRecorder,
  loginWithSystemChrome,
  openNativeProfile,
  openUnobservedProfile,
  publicResponseShape,
  refreshSession,
  requestFieldNames,
  safeVintedRoute,
  validatedVintedSession,
  vintedUserIdFromCookies,
};
