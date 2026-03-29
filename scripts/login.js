#!/usr/bin/env node
/**
 * Manual login fallback — opens a visible browser.
 * Use this if auto-login fails (captcha, 2FA, etc.)
 *
 * Requires KA_EMAIL and KA_PASSWORD in .env
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { login } = require("../tools/auth");

(async () => {
  try {
    await login({
      email:    process.env.KA_EMAIL,
      password: process.env.KA_PASSWORD,
      headless: false,
    });
    console.log("Fertig. Starte den Agenten mit: bash scripts/start.sh");
  } catch (e) {
    console.error("Login fehlgeschlagen:", e.message);
    process.exit(1);
  }
})();
