#!/usr/bin/env node
/**
 * Headless refresh of an existing still-valid browser session.
 * Opens the saved browser profile, visits KA, writes fresh cookies to .env.
 * Run this if CSRF errors appear. A fully expired session still needs `npm run login`.
 */

"use strict";

const { refreshCookies } = require("../tools/auth");

refreshCookies()
  .then(() => console.log("Done."))
  .catch(e => { console.error("Error:", e.message); process.exit(1); });
