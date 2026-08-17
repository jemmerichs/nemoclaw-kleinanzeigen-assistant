"use strict";

// Manual login/bootstrap plus standards-based renewal of a still-valid session.

const { chromium } = require("playwright");
const { execFileSync, spawn } = require("child_process");
const http = require("http");
const net = require("net");

const fs   = require("fs");
const path = require("path");
const { hasFreshAccessToken } = require("./kleinanzeigen-session");

const ENV_FILE    = path.resolve(__dirname, "../.env");
const PROFILE_DIR = path.resolve(__dirname, "../workspace/browser-profile");
const LOGIN_URL   = "https://www.kleinanzeigen.de/m-einloggen.html";
const CSRF_URL    = "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html";
const DEVTOOLS_ACTIVE_PORT_FILE = path.join(PROFILE_DIR, "DevToolsActivePort");
const LOGIN_TIMEOUT_MS = 300_000;
const TRANSIENT_ACCESS_RETRY_ATTEMPTS = 2;
const TRANSIENT_ACCESS_RETRY_DELAY_MS = 2_000;

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
const DEFAULT_ACCEPT_LANGUAGE = "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";

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
  const error = new Error(
    `Kleinanzeigen blockiert diesen Netzwerkpfad (${signal}). ` +
    "Der Login wurde beendet. " +
    "Bitte VPN/Proxy/iCloud Private Relay deaktivieren und später über eine stabile, normale Heim- oder Mobilfunkverbindung erneut versuchen."
  );
  error.code = "KA_ACCESS_DENIED";
  return error;
}

function rejectedPrivateBrowserError(status = null) {
  const hasStatus = status !== null && status !== undefined && Number.isInteger(Number(status));
  const suffix = hasStatus ? ` (HTTP ${Number(status)})` : "";
  const error = new Error(
    `Der Aufruf dieser Kleinanzeigen-Seite wurde im angemeldeten Browser abgelehnt${suffix}. ` +
    "Dieser einzelne Seitenaufruf belegt weder eine allgemeine IP-Sperre noch eine abgelaufene Sitzung."
  );
  error.code = "KA_BROWSER_REJECTED";
  if (hasStatus) error.status = Number(status);
  return error;
}

async function assertNetworkAccess(page, response = null, { authenticated = false } = {}) {
  const status = response && typeof response.status === "function" ? response.status() : undefined;
  let title = "";
  let bodyText = "";
  try { title = await page.title(); } catch {}
  try { bodyText = (await page.locator("body").innerText({ timeout: 2_000 })).slice(0, 8_000); } catch {}

  const problem = classifyAccessProblem({ status, url: page.url(), title, bodyText });
  if (!problem) return;
  if (authenticated) {
    throw rejectedPrivateBrowserError(status);
  }
  throw blockedNetworkError(problem);
}

function isTransientNavigationFailure(error) {
  return ["KA_ACCESS_DENIED", "KA_BROWSER_REJECTED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT"]
    .includes(String(error?.code || ""))
    || /(?:ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(?:CLOSED|RESET|TIMED_OUT)|getaddrinfo|\bDNS\b)/i.test(
      String(error?.message || "")
    );
}

async function navigateWithAccessRetry(page, url, {
  authenticated = false,
  timeoutMs = 60_000,
  attempts = TRANSIENT_ACCESS_RETRY_ATTEMPTS,
  retryDelayMs = TRANSIENT_ACCESS_RETRY_DELAY_MS,
} = {}) {
  const normalizedAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  let lastError;
  for (let attempt = 1; attempt <= normalizedAttempts; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await assertNetworkAccess(page, response, { authenticated });
      return response;
    } catch (error) {
      lastError = error;
      if (!isTransientNavigationFailure(error) || attempt >= normalizedAttempts) throw error;
      console.warn(
        `[auth] Temporärer Kleinanzeigen-Zugriff (${String(error.code || "Netzwerkfehler")}); ` +
        "die schreibgeschützte Seitennavigation wird einmal kurz wiederholt."
      );
      await delay(Math.max(0, Number(retryDelayMs) || 0));
    }
  }
  throw lastError;
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

function adoptNewerObservedSession(cookieHeader) {
  const observed = validatedCookieHeader(cookieHeader);
  const current = String(process.env.KA_COOKIES || "");
  const { shouldPreferStoredSession } = require("./kleinanzeigen-session");
  if (current && !shouldPreferStoredSession(current, observed)) return false;
  const userAgent = systemChromeUserAgent();
  saveToEnv({
    KA_COOKIES: observed,
    KA_BEARER_TOKEN: null,
    KA_USER_AGENT: userAgent,
  });
  process.env.KA_COOKIES = observed;
  process.env.KA_USER_AGENT = userAgent;
  delete process.env.KA_BEARER_TOKEN;
  return true;
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
  if (!values.get("access_token")) missing.push("access_token");
  if (!values.get("refresh_token")) missing.push("refresh_token");
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

function validatedFreshSessionCookieString(cookies, minimumLifetimeSeconds = 60) {
  const cookieString = validatedSessionCookieString(cookies);
  if (!hasFreshAccessToken(cookieString, minimumLifetimeSeconds)) {
    throw new Error("Der Access-Token der sichtbaren Sitzung ist noch nicht frisch.");
  }
  return cookieString;
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

function requestHeaderFromCurl(input, requestedName) {
  const text = String(input || "");
  if (!text || text.length > 1024 * 1024) return "";
  const normalized = text.replace(/\\\r?\n/g, " ");
  const headerPattern = /(?:^|\s)(?:-H|--header)\s+(['"])(.*?)\1(?=\s|$)/gis;
  const expected = String(requestedName || "").toLowerCase();
  for (const match of normalized.matchAll(headerPattern)) {
    const separator = match[2].indexOf(":");
    if (separator < 1) continue;
    if (match[2].slice(0, separator).trim().toLowerCase() !== expected) continue;
    return match[2].slice(separator + 1).trim();
  }
  return "";
}

function validatedUserAgent(value) {
  const userAgent = String(value || "").trim();
  if (
    !userAgent ||
    userAgent.length > 512 ||
    /[\r\n]/.test(userAgent) ||
    !/^Mozilla\/5\.0 \(.+\) AppleWebKit\/[\d.]+ .+Chrome\/[\d.]+ Safari\/[\d.]+$/.test(userAgent)
  ) {
    return "";
  }
  return userAgent;
}

function validatedAcceptLanguage(value) {
  const acceptLanguage = String(value || "").trim();
  if (!acceptLanguage || acceptLanguage.length > 256 || /[\r\n]/.test(acceptLanguage)) {
    return DEFAULT_ACCEPT_LANGUAGE;
  }
  return acceptLanguage;
}

function validatedClientHint(value, pattern) {
  const hint = String(value || "").trim();
  if (!hint || hint.length > 512 || /[\r\n]/.test(hint) || !pattern.test(hint)) return "";
  return hint;
}

function systemChromeUserAgent() {
  const executablePath = findChromeExecutable();
  if (!executablePath) return "";
  try {
    const versionOutput = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const majorVersion = (versionOutput.match(/(\d+)(?:\.\d+){1,3}/) || [])[1];
    if (!majorVersion) return "";
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ` +
      `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
  } catch {
    return "";
  }
}

function requestMetadataFromCurl(input) {
  return {
    userAgent: validatedUserAgent(requestHeaderFromCurl(input, "user-agent")) || systemChromeUserAgent(),
    acceptLanguage: validatedAcceptLanguage(requestHeaderFromCurl(input, "accept-language")),
    secChUa: validatedClientHint(
      requestHeaderFromCurl(input, "sec-ch-ua"),
      /^(?:"[^"\r\n]{1,80}";v="\d{1,3}"(?:,\s*)?)+$/
    ),
    secChUaMobile: validatedClientHint(requestHeaderFromCurl(input, "sec-ch-ua-mobile"), /^\?[01]$/),
    secChUaPlatform: validatedClientHint(requestHeaderFromCurl(input, "sec-ch-ua-platform"), /^"[^"\r\n]{1,80}"$/),
  };
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
  const metadata = requestMetadataFromCurl(clipboard);
  saveToEnv({
    KA_COOKIES: cookies,
    KA_BEARER_TOKEN: null,
    KA_USER_AGENT: metadata.userAgent,
    KA_ACCEPT_LANGUAGE: metadata.acceptLanguage,
    KA_SEC_CH_UA: metadata.secChUa,
    KA_SEC_CH_UA_MOBILE: metadata.secChUaMobile,
    KA_SEC_CH_UA_PLATFORM: metadata.secChUaPlatform,
  });
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
  const metadata = requestMetadataFromCurl(contents);
  saveToEnv({
    KA_COOKIES: cookies,
    KA_BEARER_TOKEN: null,
    KA_USER_AGENT: metadata.userAgent,
    KA_ACCEPT_LANGUAGE: metadata.acceptLanguage,
    KA_SEC_CH_UA: metadata.secChUa,
    KA_SEC_CH_UA_MOBILE: metadata.secChUaMobile,
    KA_SEC_CH_UA_PLATFORM: metadata.secChUaPlatform,
  });
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
    // Native Chrome encrypts this dedicated profile with the macOS keychain.
    // Playwright otherwise injects mock-keychain flags and makes the same
    // persisted cookies appear missing on the next headless refresh.
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    options.channel = process.env.PLAYWRIGHT_CHANNEL;
  } else {
    const executablePath = findChromeExecutable();
    if (executablePath) options.executablePath = executablePath;
  }
  return chromium.launchPersistentContext(PROFILE_DIR, options);
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

function delay(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs));
}

function armClosingDeadline(close, timeoutMs) {
  if (typeof close !== "function") throw new Error("Deadline-Cleanup fehlt.");
  const normalizedTimeout = Math.max(1, Math.min(10 * 60_000, Number(timeoutMs) || 1));
  let expired = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    expired = true;
    Promise.resolve().then(close).catch(() => {});
  }, normalizedTimeout);
  timer.unref?.();
  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
    expired() { return expired; },
  };
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(error => {
        if (error) return reject(error);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          return reject(new Error("Kein lokaler Chrome-Debug-Port verfügbar."));
        }
        resolve(port);
      });
    });
  });
}

function devToolsEndpointReady(endpoint) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ready => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = http.get(`${endpoint}/json/version`, { timeout: 500 }, response => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(false));
  });
}

async function waitForDevToolsEndpoint(child, {
  port = 0,
  timeoutMs = 15_000,
  activePortFile = DEVTOOLS_ACTIVE_PORT_FILE,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const fixedEndpoint = Number.isInteger(port) && port > 0
    ? `http://127.0.0.1:${port}`
    : null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Das dedizierte Chrome-Fenster wurde vor dem Verbindungsaufbau geschlossen.");
    }
    if (fixedEndpoint) {
      if (await devToolsEndpointReady(fixedEndpoint)) return fixedEndpoint;
    } else {
      try {
        const [activePort] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
        if (/^\d{2,5}$/.test(activePort) && Number(activePort) <= 65_535) {
          return `http://127.0.0.1:${activePort}`;
        }
      } catch {}
    }
    await delay(100);
  }
  throw new Error("Das dedizierte Chrome-Fenster konnte nicht lokal validiert werden.");
}

async function waitForValidatedNativeSession(context, page, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("Sitzung noch nicht vollständig.");
  while (Date.now() < deadline) {
    await assertNetworkAccess(page, null, { authenticated: true });
    try {
      const cookies = await context.cookies("https://www.kleinanzeigen.de");
      const cookieString = validatedFreshSessionCookieString(cookies);
      if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
        throw new Error("Der sichtbare Browser befindet sich noch im Login.");
      }
      return {
        cookies,
        cookieString,
      };
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Login-Zeitlimit erreicht: ${lastError.message}`);
}

async function validateNativeMarketplaceSession(context, page, {
  url = CSRF_URL,
  timeoutMs = 60_000,
  retryDelayMs = TRANSIENT_ACCESS_RETRY_DELAY_MS,
} = {}) {
  await navigateWithAccessRetry(page, url, {
    authenticated: true,
    timeoutMs,
    retryDelayMs,
  });
  if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
    throw new Error("Die sichtbare Sitzung ist im privaten Anzeigenbereich nicht angemeldet.");
  }
  const cookies = await context.cookies("https://www.kleinanzeigen.de");
  return {
    cookies,
    cookieString: validatedFreshSessionCookieString(cookies),
  };
}

function profileInUseError(error) {
  if (!/singleton|profile.*(?:in use|locked)|browser.*closed/i.test(String(error?.message || error))) {
    return null;
  }
  return new Error(
    "Das dedizierte NemoClaw-Chrome-Profil ist noch geöffnet. " +
    "Login dort abschließen, das Fenster vollständig schließen und den Vorgang einmal wiederholen."
  );
}

async function openNativeProfile({
  headless = false,
  url = "about:blank",
  profileDir = PROFILE_DIR,
} = {}) {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Google Chrome/Chromium wurde nicht gefunden.");
  // Port 0 marks Chrome as WebDriver-controlled. A reserved non-zero loopback
  // port keeps the visible native browser internally consistent without JS,
  // Canvas, WebGL, UA, or navigator-property spoofing.
  const debugPort = headless ? 0 : await reserveLoopbackPort();

  const resolvedProfileDir = path.resolve(profileDir);
  const activePortFile = path.join(resolvedProfileDir, "DevToolsActivePort");
  fs.mkdirSync(resolvedProfileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolvedProfileDir, 0o700);
  try { fs.unlinkSync(activePortFile); } catch {}

  const args = [
    `--user-data-dir=${resolvedProfileDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    ...(headless ? ["--headless=new"] : ["--new-window"]),
    url,
  ];
  const child = spawn(executablePath, args, { stdio: "ignore" });
  let browser;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });

  try {
    const endpoint = await waitForDevToolsEndpoint(child, { port: debugPort, activePortFile });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Das dedizierte Chrome-Profil konnte nicht geöffnet werden.");
    const pages = context.pages();
    const page = pages.find(candidate => candidate.url().includes("kleinanzeigen.de")) || pages[0];
    if (!page) throw new Error("Das dedizierte Chrome-Tab wurde nicht gefunden.");
    return { browser, child, context, page, activePortFile, profileDir: resolvedProfileDir };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForChildExit(child).catch(() => {});
    const friendlyError = profileInUseError(error);
    if (friendlyError) throw friendlyError;
    throw error;
  }
}

async function closeNativeProfile(nativeProfile, {
  browserCloseTimeoutMs = 3_000,
  childExitTimeoutMs = 5_000,
} = {}) {
  if (!nativeProfile) return;
  if (nativeProfile.closePromise) return nativeProfile.closePromise;
  nativeProfile.closePromise = (async () => {
    const { browser, child } = nativeProfile;
    if (browser) {
      await Promise.race([
        browser.close().catch(() => {}),
        delay(Math.max(1, Number(browserCloseTimeoutMs) || 3_000)),
      ]);
    }
    try {
      await waitForChildExit(child, Math.max(1, Number(childExitTimeoutMs) || 5_000));
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForChildExit(child, Math.max(1, Number(childExitTimeoutMs) || 5_000)).catch(() => {});
    } finally {
      try { fs.unlinkSync(nativeProfile.activePortFile || DEVTOOLS_ACTIVE_PORT_FILE); } catch {}
    }
  })();
  return nativeProfile.closePromise;
}

async function archiveNativeProfile({
  profileDir = PROFILE_DIR,
  now = Date.now(),
  endpointReady = devToolsEndpointReady,
} = {}) {
  if (!fs.existsSync(profileDir)) return null;
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  let activePort = "";
  try {
    [activePort] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (/^\d{2,5}$/.test(activePort) && Number(activePort) <= 65_535) {
    const active = await endpointReady(`http://127.0.0.1:${activePort}`);
    if (active) {
      throw new Error(
        "Das dedizierte NemoClaw-Chrome-Profil ist noch geöffnet und kann nicht sicher erneuert werden."
      );
    }
  }
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(path.dirname(profileDir), "profile-backups");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupRoot, 0o700);
  let backupPath = path.join(backupRoot, `${path.basename(profileDir)}-${timestamp}`);
  for (let suffix = 2; fs.existsSync(backupPath); suffix++) {
    backupPath = path.join(backupRoot, `${path.basename(profileDir)}-${timestamp}-${suffix}`);
  }
  fs.renameSync(profileDir, backupPath);
  return backupPath;
}

async function importSessionFromProfile() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("Kein dediziertes Browser-Profil gefunden.");
  }

  let nativeProfile;
  try {
    nativeProfile = await openNativeProfile({ headless: true, url: "about:blank" });
    const cookies = await nativeProfile.context.cookies("https://www.kleinanzeigen.de");
    const cs = validatedSessionCookieString(cookies);
    saveToEnv({
      KA_COOKIES: cs,
      KA_BEARER_TOKEN: null,
      KA_USER_AGENT: systemChromeUserAgent(),
      KA_ACCEPT_LANGUAGE: DEFAULT_ACCEPT_LANGUAGE,
      KA_SEC_CH_UA: null,
      KA_SEC_CH_UA_MOBILE: null,
      KA_SEC_CH_UA_PLATFORM: null,
    });
    console.log("[auth] Session aus dem dedizierten Profil gespeichert.");
    return cs;
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

async function inspectProfileSession() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  let nativeProfile;
  try {
    nativeProfile = await openNativeProfile({ headless: true, url: "about:blank" });
    const cookies = await nativeProfile.context.cookies();
    return cookies
      .filter(cookie => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return domain === "kleinanzeigen.de" || domain.endsWith(".kleinanzeigen.de");
      })
      .map(cookie => ({ domain: cookie.domain, name: cookie.name }))
      .sort((left, right) => `${left.domain}/${left.name}`.localeCompare(`${right.domain}/${right.name}`));
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

async function loginWithSystemChrome() {
  let nativeProfile;
  nativeProfile = await openNativeProfile({ url: LOGIN_URL });
  try {
    await navigateWithAccessRetry(nativeProfile.page, LOGIN_URL);
    console.log("[auth] Das dedizierte NemoClaw-Chrome-Fenster wurde geöffnet.");
    console.log("[auth] Bitte manuell einloggen und 2FA/CAPTCHA selbst abschließen.");
    console.log("[auth] Die Sitzung wird im selben Fenster automatisch validiert; nichts absenden.");
    await waitForValidatedNativeSession(
      nativeProfile.context,
      nativeProfile.page
    );
    const { cookieString } = await validateNativeMarketplaceSession(
      nativeProfile.context,
      nativeProfile.page
    );
    saveToEnv({
      KA_COOKIES: cookieString,
      KA_BEARER_TOKEN: null,
      KA_USER_AGENT: systemChromeUserAgent(),
      KA_ACCEPT_LANGUAGE: DEFAULT_ACCEPT_LANGUAGE,
      KA_SEC_CH_UA: null,
      KA_SEC_CH_UA_MOBILE: null,
      KA_SEC_CH_UA_PLATFORM: null,
    });
    console.log("[auth] Dedizierte Sitzung validiert und gespeichert.");
    return cookieString;
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

async function login() {
  console.log("[auth] Opening browser. Log in and complete 2FA.");
  const context = await launchProfile(false);
  try {
    const page = context.pages()[0] || await context.newPage();
    await navigateWithAccessRetry(page, LOGIN_URL);
    await waitForCompletedLogin(page);

    await navigateWithAccessRetry(page, CSRF_URL, { authenticated: true });

    const cookies = await context.cookies("https://www.kleinanzeigen.de");
    const cs = validatedSessionCookieString(cookies);

    saveToEnv({
      KA_COOKIES: cs,
      KA_BEARER_TOKEN: null,
      KA_USER_AGENT: systemChromeUserAgent(),
      KA_ACCEPT_LANGUAGE: DEFAULT_ACCEPT_LANGUAGE,
      KA_SEC_CH_UA: null,
      KA_SEC_CH_UA_MOBILE: null,
      KA_SEC_CH_UA_PLATFORM: null,
    });
    console.log("[auth] Session gespeichert.");
  } finally {
    await context.close();
  }
}

async function refreshStoredSession() {
  require("dotenv").config({ path: ENV_FILE, override: true });
  const KleinanzeigenClient = require("./kleinanzeigen");
  const cookies = process.env.KA_COOKIES || "";
  if (!cookies) throw new Error("KA_COOKIES fehlt — bitte zuerst 'npm run login' ausführen.");
  const client = new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
  const refreshed = await client.refreshAccessToken();
  saveToEnv({
    KA_COOKIES: client.cookies,
    KA_BEARER_TOKEN: null,
  });
  process.env.KA_COOKIES = client.cookies;
  delete process.env.KA_BEARER_TOKEN;
  return {
    cookieString: client.cookies,
    expiresAt: refreshed.expiresAt,
    refreshTokenRotated: refreshed.refreshTokenRotated,
  };
}

module.exports = {
  adoptNewerObservedSession,
  armClosingDeadline,
  archiveNativeProfile,
  assertNetworkAccess,
  classifyAccessProblem,
  closeNativeProfile,
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
  navigateWithAccessRetry,
  openNativeProfile,
  requestMetadataFromCurl,
  refreshStoredSession,
  saveToEnv,
  systemChromeUserAgent,
  userIdFromAccessToken,
  validatedAcceptLanguage,
  validatedCookieHeader,
  validatedFreshSessionCookieString,
  validateNativeMarketplaceSession,
  validatedSessionCookieString,
  validatedUserAgent,
};
