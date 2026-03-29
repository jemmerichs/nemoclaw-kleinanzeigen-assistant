"use strict";

/**
 * Kleinanzeigen authentication
 *
 * Hard skill — maintained by Claude Code.
 * Logs in via Playwright and saves session cookies to .env.
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const ENV_FILE  = path.resolve(__dirname, "../.env");
const LOGIN_URL = "https://www.kleinanzeigen.de/m-einloggen.html";
const INBOX_URL = "https://www.kleinanzeigen.de/m-nachrichten.html";

function saveCookiesToEnv(cookies) {
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = content.split("\n").filter(l => !l.startsWith("KA_COOKIES="));
  lines.push(`KA_COOKIES=${cookieString}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n").trimEnd() + "\n");
  fs.chmodSync(ENV_FILE, 0o600);
  return cookieString;
}

/**
 * Log in to Kleinanzeigen and return a fresh cookie string.
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {boolean} [opts.headless=true]  false = show browser (manual captcha fallback)
 */
async function login({ email, password, headless = true } = {}) {
  if (!email || !password) throw new Error("KA_EMAIL und KA_PASSWORD müssen in .env gesetzt sein.");

  console.log(`[auth] Logging in (headless=${headless})...`);

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 40 });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // Dismiss cookie banner
    try {
      await page.click(
        '[id*="acceptAllButton"], [class*="accept-all"], button:has-text("Alle akzeptieren")',
        { timeout: 4000 }
      );
    } catch (_) {}

    // Fill credentials
    await page.fill('input[name="loginname"], #loginname', email);
    await page.fill('input[name="password"], #password', password);
    await page.click('button[type="submit"], input[type="submit"]');

    await page.waitForURL((url) => !url.toString().includes("m-einloggen"), { timeout: 12000 })
      .catch(() => {}); // may not redirect if captcha shown

    // Verify by visiting inbox
    await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
    const finalUrl = page.url();

    if (finalUrl.includes("einloggen") || finalUrl.includes("login")) {
      if (!headless) {
        // In headed mode: wait for user to solve captcha manually
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

    const cookieString = saveCookiesToEnv(kaCookies);
    console.log(`[auth] Login erfolgreich — ${kaCookies.length} Cookies gespeichert.`);
    return cookieString;

  } finally {
    await browser.close();
  }
}

module.exports = { login };
