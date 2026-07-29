#!/usr/bin/env node
"use strict";

const {
  importSessionFromProfile,
  inspectProfileSession,
  loginWithSystemChrome,
  refreshSession,
} = require("../tools/vinted-auth");

(async () => {
  try {
    if (process.argv.includes("--inspect-only")) {
      const cookies = await inspectProfileSession();
      console.log(cookies.length ? cookies : "Keine Vinted-Cookies im dedizierten Profil.");
      return;
    }
    if (process.argv.includes("--import-only")) {
      await importSessionFromProfile();
      console.log("Done. Verify with: npm run smoke:vinted");
      return;
    }
    if (process.argv.includes("--refresh")) {
      await refreshSession();
      console.log("Done. Verify with: npm run smoke:vinted");
      return;
    }
    await loginWithSystemChrome();
    console.log("Done. Verify with: npm run smoke:vinted");
  } catch (error) {
    console.error(`Vinted login failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
