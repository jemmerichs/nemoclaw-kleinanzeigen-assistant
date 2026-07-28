#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const KleinanzeigenClient = require("../tools/kleinanzeigen");

function smokeDiagnosis(errors) {
  const failures = (errors || []).filter(Boolean);
  const codes = new Set(failures.map(error => error.code).filter(Boolean));
  const messages = failures.map(error => String(error.message || error)).join("\n");

  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN") || /\b(?:ENOTFOUND|EAI_AGAIN)\b/i.test(messages)) {
    return [
      "DNS-Diagnose: macOS/Node kann mindestens einen Kleinanzeigen-Host nicht auflösen.",
      "Das ist kein Loginfehler; ein Browser kann wegen eigenem Secure-DNS trotzdem funktionieren.",
      "Prüfe den DNS des aktiven Netzwerks oder verwende einen vertrauenswürdigen System-DNS und starte danach 'npm run smoke:ka' erneut.",
    ].join(" ");
  }
  if (
    codes.has("KA_ACCESS_DENIED") ||
    codes.has("KA_PUBLIC_ACCESS_DENIED") ||
    /\b(?:IP-Bereich|IP range|unusual traffic|ungewöhnlichen Datenverkehr|HTTP 403|HTTP 429)\b/i.test(messages)
  ) {
    return [
      "Zugriffsdiagnose: Kleinanzeigen lehnt oder drosselt den aktuellen Netzwerkpfad.",
      "Keine Login- oder Request-Schleife starten; VPN, Proxy und Private Relay deaktivieren und später über eine stabile Heim- oder Mobilfunkverbindung testen.",
    ].join(" ");
  }
  if (
    codes.has("KA_SESSION_EXPIRED") ||
    codes.has("KA_CSRF_EXPIRED") ||
    codes.has("KA_BEARER_EXPIRED") ||
    /\b(?:Session|CSRF|Bearer token) abgelaufen\b/i.test(messages)
  ) {
    return "Session-Diagnose: Die Netzwerkverbindung steht, aber die Anmeldung muss mit 'npm run login' erneuert werden.";
  }
  if (codes.has("ETIMEDOUT") || /\bTimeout\b/i.test(messages)) {
    return "Netzwerkdiagnose: Kleinanzeigen war nicht rechtzeitig erreichbar. Nicht schnell wiederholen; Verbindung prüfen und später einmal erneut testen.";
  }
  return null;
}

async function check(label, task, summarize) {
  try {
    const result = await task();
    console.log(`✓ ${label}: ${summarize(result)}`);
    return { ok: true, error: null };
  } catch (error) {
    console.error(`✗ ${label}: ${error.message}`);
    return { ok: false, error };
  }
}

async function main() {
  const cookies = process.env.KA_COOKIES || "";
  const client = new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
  const results = [];
  results.push(await check(
    "Öffentliche Suche",
    () => client.searchAds({ keyword: "ThinkPad T14", limit: 3 }),
    rows => `${rows.length} Ergebnisse; Kategorie-IDs: ${[...new Set(rows.map(row => row.categoryId).filter(Boolean))].join(", ") || "keine"}`
  ));

  if (!cookies) {
    console.log("• Kein Konto-Smoke-Test: KA_COOKIES fehlt. Führe 'npm run login' aus.");
    const diagnosis = smokeDiagnosis(results.map(result => result.error));
    if (diagnosis) console.error(`→ ${diagnosis}`);
    if (results.some(result => !result.ok)) process.exitCode = 1;
    return;
  }

  results.push(await check("Eigene Anzeigen", () => client.getMyAds({ limit: 5 }), rows => `${rows.length} abgerufen`));
  results.push(await check("Entwürfe", () => client.getDrafts(), rows => `${rows.length} abgerufen`));
  results.push(await check(
    "Konversationen",
    () => client.getConversations({ limit: 5 }),
    rows => `${rows.length} abgerufen, ${rows.filter(row => row.unread).length} ungelesen`
  ));
  const diagnosis = smokeDiagnosis(results.map(result => result.error));
  if (diagnosis) console.error(`→ ${diagnosis}`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Kleinanzeigen-Smoke-Test fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, smokeDiagnosis };
