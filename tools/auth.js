"use strict";

// login() — headed setup. refreshCookies() — headless renewal of a still-valid session.

const { chromium } = require("playwright");
const { execFileSync, spawn } = require("child_process");

const fs   = require("fs");
const path = require("path");

const ENV_FILE    = path.resolve(__dirname, "../.env");
const PROFILE_DIR = path.resolve(__dirname, "../workspace/browser-profile");
const LOGIN_URL   = "https://www.kleinanzeigen.de/m-einloggen.html";
const CSRF_URL    = "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt1.html";
const LOGIN_TIMEOUT_MS = 300_000;

const ACCESS_BLOCK_MARKERS = [
  "ip-bereich ist gesperrt",
  "ip-bereich wurde gesperrt",
  "ip range has been blocked",
  "ungewöhnlichen datenverkehr",
  "unusual traffic",
  "zugriff verweigert",
  "access denied",
  "request blocked",
  "temporarily blocked",
];

function classifyAccessProblem({ status, url = "", title = "", bodyText = "" } = {}) {
  const statusCode = Number(status);
  if (statusCode === 403 || statusCode === 429) {
    return `HTTP ${statusCode}`;
  }

  const haystack = `${url}\n${title}\n${bodyText}`.toLocaleLowerCase("de-DE");
  const marker = ACCESS_BLOCK_MARKERS.find(candidate => haystack.includes(candidate));
  return marker ? `"${marker}"` : null;
}

function blockedNetworkError(signal) {
  return new Error(
    `Kleinanzeigen blockiert diesen Netzwerkpfad (${signal}). ` +
    "Der Login wurde ohne automatische Wiederholung beendet. " +
    "Bitte VPN/Proxy/iCloud Private Relay deaktivieren und später über eine stabile, normale Heim- oder Mobilfunkverbindung erneut versuchen."
  );
}

async function assertNetworkAccess(page, response = null) {
  const status = response && typeof response.status === "function" ? response.status() : undefined;
  let title = "";
  let bodyText = "";
  try { title = await page.title(); } catch {}
  try { bodyText = (await page.locator("body").innerText({ timeout: 2_000 })).slice(0, 8_000); } catch {}

  const problem = classifyAccessProblem({ status, url: page.url(), title, bodyText });
  if (problem) throw blockedNetworkError(problem);
}

async function waitForCompletedLogin(page, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertNetworkAccess(page);
    const currentUrl = page.url();
    if (!currentUrl.includes("login.kleinanzeigen.de") && !currentUrl.includes("m-einloggen")) {
      return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("Login-Zeitlimit erreicht. Es wurden keine Sitzungsdaten gespeichert.");
}

function saveToEnv(updates) {
  let lines = (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Ungültiger .env-Key: ${key}`);
    lines = lines.filter(l => !l.startsWith(`${key}=`));
    if (value) {
      const safeValue = String(value);
      if (/[\r\n]/.test(safeValue)) throw new Error(`Ungültiger Zeilenumbruch in ${key}.`);
      lines.push(`${key}=${safeValue}`);
    }
  }
  const tempFile = `${ENV_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, lines.join("\n").trimEnd() + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, ENV_FILE);
}

function extractKaCookieString(cookies) {
  const values = new Map();
  for (const cookie of cookies || []) {
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    const allowedDomain = domain === "kleinanzeigen.de" || domain.endsWith(".kleinanzeigen.de");
    if (!allowedDomain || !cookie.name) continue;
    values.set(String(cookie.name), String(cookie.value || ""));
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function userIdFromAccessToken(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(accessToken || "").split(".")[1], "base64url").toString("utf8")
    );
    for (const [key, value] of Object.entries(payload || {})) {
      if ((key === "user_id" || /\/user_id$/i.test(key)) && /^\d+$/.test(String(value))) {
        return String(value);
      }
    }
  } catch {}
  return null;
}

function missingSessionParts(values) {
  const missing = [];
  if (!values.get("CSRF-TOKEN")) missing.push("CSRF-TOKEN");
  const userId = values.get("user_id") || userIdFromAccessToken(values.get("access_token"));
  if (!userId) missing.push("user_id oder ableitbare access_token-Identität");
  return missing;
}

function validatedSessionCookieString(cookies) {
  const values = new Map((cookies || []).map(cookie => [cookie.name, cookie.value]));
  const missing = missingSessionParts(values);
  if (missing.length) {
    throw new Error(`Sitzung unvollständig (${missing.join(", ")} fehlt).`);
  }
  const cookieString = extractKaCookieString(cookies);
  if (!cookieString) throw new Error("Keine Kleinanzeigen-Cookies gefunden.");
  return cookieString;
}

function validatedCookieHeader(rawHeader) {
  const header = String(rawHeader || "").trim();
  if (!header || header.length > 65_536 || /[\r\n]/.test(header)) {
    throw new Error("Cookie-Header fehlt, ist zu groß oder enthält Zeilenumbrüche.");
  }

  const values = new Map();
  for (const part of header.split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Cookie-Header enthält einen ungültigen Eintrag.");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || value.length > 16_384) {
      throw new Error("Cookie-Header enthält einen ungültigen Namen oder Wert.");
    }
    values.set(name, value);
  }

  const missing = missingSessionParts(values);
  if (missing.length) throw new Error(`Sitzung unvollständig (${missing.join(", ")} fehlt).`);
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rawCookieHeaderFromCurl(input) {
  const text = String(input || "");
  if (!text || text.length > 1024 * 1024) {
    throw new Error("Die Zwischenablage ist leer oder größer als 1 MB.");
  }
  const normalized = text.replace(/\\\r?\n/g, " ");

  const headerPattern = /(?:^|\s)(?:-H|--header)\s+(['"])(.*?)\1(?=\s|$)/gis;
  for (const match of normalized.matchAll(headerPattern)) {
    const header = match[2];
    if (/^cookie\s*:/i.test(header)) {
      return header.replace(/^cookie\s*:\s*/i, "");
    }
  }

  const cookieFlagPattern = /(?:^|\s)(?:-b|--cookie)\s+(['"])(.*?)\1(?=\s|$)/gis;
  const cookieFlag = cookieFlagPattern.exec(normalized);
  if (cookieFlag) return cookieFlag[2];

  const rawHeader = normalized.match(/(?:^|\n)cookie\s*:\s*([^\r\n]+)/i);
  if (rawHeader) return rawHeader[1];

  throw new Error(
    "Kein Cookie-Header gefunden. Kopiere in Chrome eine angemeldete Kleinanzeigen-Anfrage als cURL (bash)."
  );
}

function extractCookieHeaderFromCurl(input) {
  return validatedCookieHeader(rawCookieHeaderFromCurl(input));
}

function cookieNamesFromCurl(input) {
  return rawCookieHeaderFromCurl(input)
    .split(";")
    .map(part => part.trim().split("=")[0])
    .filter(name => /^[A-Za-z0-9_.-]{1,128}$/.test(name))
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
}

function importSessionFromClipboard() {
  if (process.platform !== "darwin") {
    throw new Error("login:clipboard ist derzeit für macOS ausgelegt.");
  }
  let clipboard;
  try {
    clipboard = execFileSync("/usr/bin/pbpaste", [], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Die macOS-Zwischenablage konnte nicht gelesen werden.");
  }
  const cookies = extractCookieHeaderFromCurl(clipboard);
  saveToEnv({ KA_COOKIES: cookies, KA_BEARER_TOKEN: null });
  console.log("[auth] Kleinanzeigen-Sitzung aus Copy-as-cURL sicher in .env importiert.");
  console.log(`[auth] Bearer-Cookie: ${/(?:^|;\s*)access_token=/.test(cookies) ? "vorhanden" : "fehlt"}.`);
  return cookies;
}

function importSessionFromFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error("Die cURL-Datei wurde nicht gefunden."); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    throw new Error("Die cURL-Datei muss eine normale Datei zwischen 1 Byte und 1 MB sein.");
  }
  const contents = fs.readFileSync(resolved, "utf8");
  let cookies;
  try {
    cookies = extractCookieHeaderFromCurl(contents);
  } catch (error) {
    const names = cookieNamesFromCurl(contents);
    throw new Error(`${error.message} Vorhandene Cookie-Namen: ${names.join(", ") || "keine"}.`);
  }
  saveToEnv({ KA_COOKIES: cookies, KA_BEARER_TOKEN: null });
  console.log("[auth] Kleinanzeigen-Sitzung aus der cURL-Datei sicher in .env importiert.");
  console.log(`[auth] Bearer-Cookie: ${/(?:^|;\s*)access_token=/.test(cookies) ? "vorhanden" : "fehlt"}.`);
  return cookies;
}

function findChromeExecutable() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function launchProfile(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PROFILE_DIR, 0o700);
  const options = {
    headless,
    viewport: { width: 1280, height: 800 },
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    options.channel = process.env.PLAYWRIGHT_CHANNEL;
  } else {
    const executablePath = findChromeExecutable();
    if (executablePath) options.executablePath = executablePath;
  }
  return chromium.launchPersistentContext(PROFILE_DIR, options);
}

function waitForEnter() {
  if (!process.stdin.isTTY) {
    throw new Error("Der native Login muss in einem interaktiven Terminal ausgeführt werden.");
  }
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise(resolve => process.stdin.once("data", () => {
    process.stdin.pause();
    resolve();
  }));
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Das dedizierte Chrome-Profil wurde nicht rechtzeitig freigegeben."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function importSessionFromProfile() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("Kein dediziertes Browser-Profil gefunden.");
  }

  let context;
  try {
    context = await launchProfile(true);
    const cookies = await context.cookies("https://www.kleinanzeigen.de");
    const cs = validatedSessionCookieString(cookies);
    saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
    console.log("[auth] Session aus dem dedizierten Profil gespeichert.");
    return cs;
  } catch (error) {
    if (/singleton|profile.*(?:in use|locked)|browser.*closed/i.test(String(error.message))) {
      throw new Error(
        "Das dedizierte Chrome-Fenster ist noch geöffnet. Bitte vollständig schließen und den Import erneut starten."
      );
    }
    throw error;
  } finally {
    if (context) await context.close();
  }
}

async function inspectProfileSession() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  const context = await launchProfile(true);
  try {
    const cookies = await context.cookies();
    return cookies
      .filter(cookie => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return domain === "kleinanzeigen.de" || domain.endsWith(".kleinanzeigen.de");
      })
      .map(cookie => ({ domain: cookie.domain, name: cookie.name }))
      .sort((left, right) => `${left.domain}/${left.name}`.localeCompare(`${right.domain}/${right.name}`));
  } finally {
    await context.close();
  }
}

async function loginWithSystemChrome() {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error("Google Chrome/Chromium wurde nicht gefunden.");
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PROFILE_DIR, 0o700);
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    `--app=${CSRF_URL}`,
  ];

  const child = spawn(executablePath, args, {
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });

  console.log("[auth] Das dedizierte NemoClaw-Chrome-App-Fenster wurde geöffnet.");
  console.log("[auth] Bitte manuell einloggen und 2FA/CAPTCHA selbst abschließen.");
  console.log("[auth] Warte, bis die Seite zum Aufgeben einer Anzeige sichtbar ist. Nichts absenden.");
  console.log("[auth] Danach hier ENTER drücken; das Skript beendet ausschließlich dieses dedizierte Fenster.");
  await waitForEnter();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForChildExit(child);
  return importSessionFromProfile();
}

async function login() {
  console.log("[auth] Opening browser. Log in and complete 2FA.");
  const context = await launchProfile(false);
  try {
    const page = context.pages()[0] || await context.newPage();
    const loginResponse = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertNetworkAccess(page, loginResponse);
    await waitForCompletedLogin(page);

    const csrfResponse = await page.goto(CSRF_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertNetworkAccess(page, csrfResponse);

    const cookies = await context.cookies("https://www.kleinanzeigen.de");
    const cs = validatedSessionCookieString(cookies);

    saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
    console.log("[auth] Session gespeichert.");
  } finally {
    await context.close();
  }
}

async function refreshCookies() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("Kein Browser-Profil gefunden — bitte zuerst 'npm run login' ausführen.");
  }

  const context = await launchProfile(true);
  try {
    await context.route("**/*", (route, req) => {
      if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) return route.abort();
      route.continue();
    });

    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(CSRF_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await assertNetworkAccess(page, response);

    const cookies = await context.cookies("https://www.kleinanzeigen.de");
    const cs = validatedSessionCookieString(cookies);

    saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
    console.log("[auth] Cookies refreshed.");
    return cs;
  } finally {
    await context.close();
  }
}

module.exports = {
  assertNetworkAccess,
  classifyAccessProblem,
  cookieNamesFromCurl,
  extractKaCookieString,
  extractCookieHeaderFromCurl,
  findChromeExecutable,
  importSessionFromClipboard,
  importSessionFromFile,
  importSessionFromProfile,
  inspectProfileSession,
  login,
  loginWithSystemChrome,
  refreshCookies,
  saveToEnv,
  userIdFromAccessToken,
  validatedCookieHeader,
  validatedSessionCookieString,
};
