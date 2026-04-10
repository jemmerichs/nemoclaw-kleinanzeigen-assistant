"use strict";

/**
 * Kleinanzeigen authentication
 *
 * - login()          one-time headed setup — log in manually, solve 2FA/captcha
 *                    session + fingerprint saved to workspace/browser-profile
 * - refreshCookies() headless refresh — no login needed, call whenever CSRF is stale
 */

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
    lines = lines.filter(l => !l.startsWith(`${key}=`));
    if (value) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n").trimEnd() + "\n");
  fs.chmodSync(ENV_FILE, 0o600);
}

function extractKaCookieString(cookies) {
  return cookies
    .filter(c => c.domain.includes("kleinanzeigen.de"))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function launchProfile(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args:     ["--no-sandbox"],
    viewport: { width: 1280, height: 800 },
  });
}

async function login() {
  console.log("[auth] Opening browser — log in and complete any 2FA. Cookies are saved automatically.");
  const context = await launchProfile(false);
  const page    = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait up to 5 min for the user to finish login + 2FA
  await page.waitForURL(
    url => !url.includes("login.kleinanzeigen.de") && !url.includes("m-einloggen"),
    { timeout: 300_000 }
  );

  const cs = extractKaCookieString(await context.cookies("https://www.kleinanzeigen.de"));
  if (!cs) throw new Error("No KA cookies found — did the login succeed?");

  saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
  console.log("[auth] Session saved.");
  await context.close();
}

async function refreshCookies() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("No browser profile found — run 'node scripts/login.js' first.");
  }

  const context = await launchProfile(true);
  try {
    await context.route("**/*", (route, req) => {
      if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) return route.abort();
      route.continue();
    });

    const page = await context.newPage();
    await page.goto(CSRF_URL, { waitUntil: "domcontentloaded" });

    const cs = extractKaCookieString(await context.cookies("https://www.kleinanzeigen.de"));
    if (!cs) throw new Error("No KA cookies after refresh — run 'node scripts/login.js'.");

    saveToEnv({ KA_COOKIES: cs, KA_BEARER_TOKEN: null });
    console.log("[auth] Cookies refreshed.");
    return cs;
  } finally {
    await context.close();
  }
}

/**
 * Delete an ad by its KA ID using the stealth browser profile.
 * Navigates to the ad management page and clicks the delete button.
 * @param {string} adId  KA ad ID (numeric string)
 */
async function deleteAdBrowser(adId) {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error("No browser profile found — run 'node scripts/login.js' first.");
  }
  const context = await launchProfile(true);
  try {
    await context.route("**/*", (route, req) => {
      if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) return route.abort();
      route.continue();
    });
    const page = await context.newPage();
    await page.goto(`https://www.kleinanzeigen.de/m-anzeigen/${adId}/loeschen.html`, { waitUntil: "domcontentloaded" });
    // Click the confirmation/submit button if present
    const confirmBtn = page.locator("button[type='submit'], input[type='submit']").first();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForLoadState("domcontentloaded");
    }
    console.log(`[auth] Ad ${adId} deleted via browser.`);
    return { deleted: adId };
  } finally {
    await context.close();
  }
}

module.exports = { login, saveToEnv, refreshCookies, deleteAdBrowser };
