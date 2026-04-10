#!/usr/bin/env node
/**
 * One-time setup: opens a real Chrome window with a persistent profile.
 * Log in manually, solve captcha / 2FA. Session is saved permanently.
 * After this, cookies stay fresh via 'node scripts/refresh-cookies.js' — no re-login needed.
 */

"use strict";

const { login } = require("../tools/auth");

(async () => {
  try {
    await login();
    console.log("Done. Start the agent with: bash scripts/start.sh");
  } catch (e) {
    console.error("Login failed:", e.message);
    process.exit(1);
  }
})();
