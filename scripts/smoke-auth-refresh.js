#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { refreshCookies } = require("../tools/auth");

async function main() {
  const refreshedCookies = await refreshCookies();
  const verificationClient = new KleinanzeigenClient(refreshedCookies);
  const conversations = await verificationClient.getConversations({ limit: 1 });
  console.log(`✓ Profil-Refresh gespeichert; ${conversations.length} Konversation(en) verifiziert.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Auth-Refresh-Smoke-Test fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
