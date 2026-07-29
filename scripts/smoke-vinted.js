#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const {
  executeTool,
  loadVintedSession,
} = require("../workspace/agent");

async function check(label, task, summarize) {
  try {
    const result = await task();
    console.log(`✓ ${label}: ${summarize(result)}`);
    return true;
  } catch (error) {
    console.error(`✗ ${label}: ${error.message}`);
    if (error.code) console.error(`  Code: ${error.code}`);
    return false;
  }
}

async function main() {
  if (!process.env.VINTED_COOKIES) {
    throw new Error("VINTED_COOKIES fehlt. Führe zuerst 'npm run login:vinted' aus.");
  }
  loadVintedSession({ required: true });
  const results = [];
  results.push(await check(
    "Angemeldetes Vinted-Profil",
    () => executeTool("vinted_get_account", {}),
    profile => `${profile.login || "Benutzer"} (ID ${profile.id})`
  ));

  if (process.argv.includes("--full")) {
    results.push(await check(
      "Eigene Vinted-Artikel",
      () => executeTool("vinted_get_my_items", { limit: 5 }),
      rows => `${rows.length} abgerufen`
    ));
    results.push(await check(
      "Vinted-Konversationen",
      () => executeTool("vinted_get_conversations", { limit: 5 }),
      rows => `${rows.length} abgerufen`
    ));
  } else {
    console.log("• Artikel und Inbox nicht abgefragt, um den Konto-Smoke-Test minimal zu halten (--full für alle Reads).");
  }

  if (results.some(ok => !ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Vinted-Smoke-Test fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
