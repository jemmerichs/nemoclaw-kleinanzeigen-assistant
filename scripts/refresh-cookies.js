#!/usr/bin/env node
/**
 * Headless cookie refresh — no login or 2FA required.
 * Opens the saved browser profile, visits KA, writes fresh cookies to .env.
 * Run this if CSRF errors appear. Agent can call this automatically.
 */

"use strict";

const { refreshCookies } = require("../tools/auth");

refreshCookies()
  .then(() => console.log("Done."))
  .catch(e => { console.error("Error:", e.message); process.exit(1); });
