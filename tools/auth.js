"use strict";

/**
 * Kleinanzeigen authentication
 *
 * Hard skill — maintained by Claude Code.
 * Logs in via Playwright, saves session cookies + Auth0 Bearer/refresh tokens to .env.
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const ENV_FILE  = path.resolve(__dirname, "../.env");
const LOGIN_URL = "https://www.kleinanzeigen.de/m-einloggen.html";
const INBOX_URL = "https://www.kleinanzeigen.de/m-nachrichten.html";

/** Upsert one or more key=value pairs in .env without touching unrelated lines. */
function saveToEnv(updates) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  let lines = content.split("\n");
  for (const [key, value] of Object.entries(updates)) {
    lines = lines.filter(l => !l.startsWith(`${key}=`));
    if (value) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n").trimEnd() + "\n");
  fs.chmodSync(ENV_FILE, 0o600);
}

/**
 * Log in to Kleinanzeigen and return fresh credentials.
 * Captures both session cookies (api.kleinanzeigen.de) and
 * the Auth0 Bearer + refresh tokens (gateway.kleinanzeigen.de).
 *
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {boolean} [opts.headless=true]  false = show browser (manual captcha fallback)
 * @returns {{ cookies: string, bearerToken: string|null, refreshToken: string|null }}
 */
async function login({ email, password, headless = true } = {}) {
  if (!email || !password) throw new Error("KA_EMAIL und KA_PASSWORD müssen in .env gesetzt sein.");

  console.log(`[auth] Logging in (headless=${headless})...`);

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 40 });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  let capturedBearerToken  = null;
  let capturedRefreshToken = null;

  // Intercept Auth0 token exchange — fires when the SPA exchanges the auth code
  // for access + refresh tokens during the login redirect flow.
  page.on("response", async res => {
    if (res.url().includes("/oauth/token") && res.status() === 200) {
      try {
        const data = await res.json();
        if (data.access_token) {
          capturedBearerToken  = data.access_token;
          capturedRefreshToken = data.refresh_token || null;
        }
      } catch (_) {}
    }
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // Dismiss cookie banner
    try {
      await page.click(
        '[id*="acceptAllButton"], [class*="accept-all"], button:has-text("Alle akzeptieren")',
        { timeout: 4000 }
      );
    } catch (_) {}

    // Auth0 two-step login: email first, then password
    // Step 1: fill email and press Enter (submit button is aria-hidden, use keyboard)
    await page.fill('#username', email);
    await page.press('#username', 'Enter');

    // Step 2: wait for password field and fill it
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', password);
    await page.press('input[type="password"]', 'Enter');

    await page.waitForURL((url) => !url.toString().includes("login.kleinanzeigen.de"), { timeout: 15000 })
      .catch(() => {});

    // Verify by visiting inbox
    await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
    const finalUrl = page.url();

    if (finalUrl.includes("einloggen") || finalUrl.includes("login.kleinanzeigen.de")) {
      if (!headless) {
        console.log("[auth] Captcha erkannt oder Login fehlgeschlagen.");
        console.log("[auth] Bitte manuell einloggen und Captcha lösen.");
        console.log("[auth] Drücke ENTER sobald du im Postfach bist...");
        await new Promise(r => process.stdin.once("data", r));
        await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
        if (page.url().includes("einloggen")) throw new Error("Login auch nach manuellem Eingriff fehlgeschlagen.");
      } else {
        throw new Error("Headless-Login fehlgeschlagen — Captcha oder falsche Zugangsdaten. Versuche: node scripts/login.js");
      }
    }

    const allCookies = await context.cookies();
    const kaCookies  = allCookies.filter(c => c.domain.includes("kleinanzeigen.de"));
    if (kaCookies.length === 0) throw new Error("Keine Kleinanzeigen-Cookies nach Login gefunden.");

    const cookieString = kaCookies.map(c => `${c.name}=${c.value}`).join("; ");

    // Tokens are embedded in the cookie string (access_token, refresh_token cookies).
    // We also try to capture them explicitly from the OAuth response as a convenience,
    // but the cookie string alone is sufficient for all API calls.
    saveToEnv({ KA_COOKIES: cookieString });

    const hasBearer  = capturedBearerToken  || /access_token=/.test(cookieString);
    const hasRefresh = capturedRefreshToken || /refresh_token=/.test(cookieString);
    console.log(`[auth] Login erfolgreich — ${kaCookies.length} Cookies gespeichert.`);
    if (hasBearer)  console.log("[auth] Bearer token in Cookies enthalten.");
    if (hasRefresh) console.log("[auth] Refresh token in Cookies enthalten.");

    return { cookies: cookieString, bearerToken: capturedBearerToken, refreshToken: capturedRefreshToken };

  } finally {
    await browser.close();
  }
}

module.exports = { login, saveToEnv };
