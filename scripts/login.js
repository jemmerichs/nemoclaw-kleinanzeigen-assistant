#!/usr/bin/env node
/**
 * One-time setup: opens a real Chrome window with a persistent profile.
 * Log in manually, solve captcha / 2FA. Session is saved permanently.
 * A later refresh can renew a still-valid session; an expired account session requires login again.
 */

"use strict";

const {
  importSessionFromProfile,
  importSessionFromClipboard,
  importSessionFromFile,
  inspectProfileSession,
  login,
  loginWithSystemChrome,
  archiveNativeProfile,
} = require("../tools/auth");

(async () => {
  try {
    const fileIndex = process.argv.indexOf("--file");
    if (fileIndex >= 0) {
      const filePath = process.argv[fileIndex + 1];
      if (!filePath) throw new Error("Pfad zur cURL-Datei fehlt.");
      console.log("[auth] Importiere die cURL-Datei; Inhalte werden nicht ausgegeben.");
      await importSessionFromFile(filePath);
    } else if (process.argv.includes("--clipboard")) {
      console.log("[auth] Lese einmalig die aktuelle Zwischenablage; Inhalte werden nicht ausgegeben.");
      await importSessionFromClipboard();
    } else if (process.argv.includes("--inspect-only")) {
      const cookies = await inspectProfileSession();
      console.log(cookies.length ? cookies : "Keine Kleinanzeigen-Cookies im dedizierten Profil.");
      return;
    } else if (process.argv.includes("--import-only")) {
      console.log("[auth] Importiere die bestehende dedizierte Chrome-Sitzung ohne Navigation.");
      await importSessionFromProfile();
    } else if (process.argv.includes("--automated")) {
      console.log("[auth] Expliziter Playwright-Fallback gewählt.");
      await login();
    } else {
      if (process.argv.includes("--fresh-profile")) {
        const archived = await archiveNativeProfile();
        console.log(
          archived
            ? "[auth] Das bisherige dedizierte Profil wurde als lokale Sicherung archiviert."
            : "[auth] Es gab noch kein dediziertes Profil; ein frisches Profil wird angelegt."
        );
      }
      await loginWithSystemChrome();
    }
    console.log("Done. Verify with: npm run smoke:ka");
  } catch (e) {
    console.error("Login failed:", e.message);
    process.exit(1);
  }
})();
