#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { refreshStoredSession } = require("../tools/auth");

async function main() {
  const refreshed = await refreshStoredSession();
  const verificationClient = new KleinanzeigenClient(refreshed.cookieString);
  const conversations = await verificationClient.getConversations({ limit: 1 });
  console.log(`✓ OIDC-Refresh bis ${refreshed.expiresAt} gespeichert; ${conversations.length} Konversation(en) verifiziert.`);
}

if (require.main === module) {
  main().catch(error => {
    const refreshRejected = ["KA_REFRESH_EXPIRED", "KA_REFRESH_FAILED", "KA_ACCESS_DENIED"]
      .includes(error?.code);
    const detail = refreshRejected
      ? "Die vorsorgliche OIDC-Erneuerung ist derzeit nicht verfügbar."
      : error.message;
    console.error(`Auth-Refresh-Smoke-Test fehlgeschlagen: ${detail}`);
    console.error(
      "Dieser Entwickler-Smoke ist kein Setup-Gate. Meldet 'npm run onboard' bereit, " +
      "funktioniert die aktuelle private Session und ein sofortiger Login ist nicht nötig."
    );
    process.exitCode = 1;
  });
}

module.exports = { main };
