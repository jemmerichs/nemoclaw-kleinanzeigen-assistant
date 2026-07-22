"use strict";

// login() — one-time headed setup. refreshCookies() — headless, no 2FA needed.

const { chromium } = require("playwright-extra");
const stealth      = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const fs   = require("fs");
const path = require("path");

const ENV_FILE    = path.resolve(__dirname, "../.env");
const PROFILE_DIR = path.resolve(__dirname, "../workspace/browser-profile");
const LOGIN_URL   = "https://www.kleinanzeigen.de/m-einloggen.html";
const CSRF_URL    = "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt1.html";

function saveToEnv(updates) {
  let lines = (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Ungültiger .env-Key: ${key}`);
    lines = lines.filter(l => !l.startsWith(`${key}=`));
    if (value) lines.push(`${key}=${value}`);
  }
  const tempFile = `${ENV_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, lines.join("\n").trimEnd() + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, ENV_FILE);
}

function extractKaCookieString(cookies) {
  return cookies
    .filter(c => c.domain.includes("kleinanzeigen.de"))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function launchProfile(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const options = {
    headless,
    args:     ["--no-sandbox"],
    viewport: { width: 1280, height: 800 },
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    options.channel = process.env.PLAYWRIGHT_CHANNEL;
  } else {
    const chromeCandidates = process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    const executablePath = chromeCandidates.find(candidate => fs.existsSync(candidate));
    if (executablePath) options.executablePath = executablePath;
  }
  return chromium.launchPersistentContext(PROFILE_DIR, options);
}

async function login() {
  console.log("[auth] Opening browser. Log in and complete 2FA.");
  const context = await launchProfile(false);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    await page.waitForURL(
      url => !url.href.includes("login.kleinanzeigen.de") && !url.href.includes("m-einloggen"),
      { timeout: 300_000 }
    );

    const cs = extractKaCookieString(await context.cookies("https://www.kleinanzeigen.de"));
    if (!cs) throw new Error("Keine Kleinanzeigen-Cookies gefunden — war der Login erfolgreich?");

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
    await page.goto(CSRF_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const cs = extractKaCookieString(await context.cookies("https://www.kleinanzeigen.de"));
    if (!cs) throw new Error("Keine Kleinanzeigen-Cookies nach Refresh — bitte 'npm run login' ausführen.");

    saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
    console.log("[auth] Cookies refreshed.");
    return cs;
  } finally {
    await context.close();
  }
}

module.exports = { login, saveToEnv, refreshCookies };
