#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { kleinanzeigenListingConfig } = require("../tools/listing-config");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env") });
const { OpenRouterClient } = require("../tools/openrouter");
const {
  findChromeExecutable,
  systemChromeUserAgent,
  userIdFromAccessToken,
} = require("../tools/auth");
const { PROFILE_DIR: VINTED_PROFILE_DIR } = require("../tools/vinted-auth");
const {
  normalizeInboxPollMinutes,
  normalizeListingPollMinutes,
} = require("../workspace/runtime");
let requiredFailures = 0;
const requireTelegram = process.argv.includes("--telegram");
const requireAccount = process.argv.includes("--account");

function hasCookie(name) {
  return new RegExp(`(?:^|;\\s*)${name}=`).test(process.env.KA_COOKIES || "");
}

function cookieValue(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(process.env.KA_COOKIES || "").match(
    new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`)
  );
  return match ? match[1] : "";
}

function accessTokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token || "").split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

function line(label, ok, detail) {
  if (!ok) requiredFailures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
}

function optionalLine(label, configured, detail) {
  console.log(`${configured ? "✓" : "•"} ${label}: ${detail}`);
}

function accountLine(label, ok, detail) {
  if (requireAccount) line(label, ok, detail);
  else optionalLine(label, ok, detail);
}

function main() {
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 20;
  line("Node", nodeOk, process.version);

  const mode = String(process.env.NEMOCLAW_MODE || "dry-run");
  const modeOk = ["dry-run", "live"].includes(mode);
  line("Modus", modeOk, mode);

  const apiKeyOk = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(process.env.OPENROUTER_API_KEY || "");
  line("OpenRouter-Key", apiKeyOk, apiKeyOk ? "gesetzt" : "fehlt/ungültig");
  line("Modell", true, process.env.OPENROUTER_MODEL || "google/gemini-3.6-flash");
  line("Reasoning", true, process.env.OPENROUTER_REASONING_EFFORT || "medium");
  const routing = process.env.NEMOCLAW_COMPLEXITY_ROUTING || "auto";
  line("Komplexitätsrouting", ["off", "manual", "auto"].includes(routing), routing);
  if (routing !== "off") {
    line("High-Modell", true, process.env.OPENROUTER_HIGH_MODEL || "moonshotai/kimi-k3");
    const highBudget = Number(process.env.OPENROUTER_HIGH_DAILY_BUDGET_USD || 0.25);
    line("High-Modellbudget", Number.isFinite(highBudget) && highBudget >= 0.01, `$${highBudget.toFixed(2)} / Tag`);
  }

  if (apiKeyOk) {
    try {
      const client = new OpenRouterClient();
      const usage = client.usageSummary();
      line("Tagesbudget", usage.remainingUsd > 0, `$${usage.costUsd.toFixed(4)} / $${usage.dailyBudgetUsd.toFixed(2)} genutzt`);
      line("Gesamtbudget", usage.totalRemainingUsd > 0, `$${usage.totalCostUsd.toFixed(4)} / $${usage.totalBudgetUsd.toFixed(2)} genutzt`);
      optionalLine(
        "Unklare Modellkosten",
        usage.ambiguousRequests === 0,
        usage.ambiguousRequests === 0
          ? "keine"
          : `${usage.ambiguousRequests} Request(s) konservativ reserviert`
      );
    } catch (error) {
      line("OpenRouter-Konfiguration", false, error.message);
    }
  }

  const telegramTokenOk = /^\d+:[A-Za-z0-9_-]{20,}$/.test(process.env.TELEGRAM_BOT_TOKEN || "");
  const chatIdsOk = /^-?\d+(,-?\d+)*$/.test(
    String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_ID || "").replace(/\s/g, "")
  );
  if (requireTelegram) {
    line("Telegram-Token", telegramTokenOk, telegramTokenOk ? "gesetzt" : "fehlt/ungültig");
    line("Telegram-Chat-ID", chatIdsOk, chatIdsOk ? "gesetzt" : "fehlt/ungültig");
  } else {
    optionalLine("Telegram-Token", telegramTokenOk, telegramTokenOk ? "gesetzt" : "optional; für npm run chat nicht nötig");
    optionalLine("Telegram-Chat-ID", chatIdsOk, chatIdsOk ? "gesetzt" : "optional; für npm run chat nicht nötig");
  }
  try {
    const inboxMinutes = normalizeInboxPollMinutes(process.env.NEMOCLAW_INBOX_POLL_MINUTES);
    line(
      "Inbox-Monitor",
      true,
      inboxMinutes === 0 ? "deaktiviert" : `Startcheck + etwa alle ${inboxMinutes} min (±20%)`
    );
  } catch (error) {
    line("Inbox-Monitor", false, error.message);
  }
  try {
    const listingMinutes = normalizeListingPollMinutes(process.env.NEMOCLAW_LISTING_POLL_MINUTES);
    line(
      "Anzeigen-Lifecycle",
      true,
      listingMinutes === 0 ? "deaktiviert" : `Startcheck + etwa alle ${listingMinutes} min (±15%)`
    );
  } catch (error) {
    line("Anzeigen-Lifecycle", false, error.message);
  }
  try {
    const sharp = require("sharp");
    line("Bildbearbeitung", Boolean(sharp?.versions?.sharp), `Sharp ${sharp?.versions?.sharp || "nicht verfügbar"}`);
  } catch (error) {
    line("Bildbearbeitung", false, error.message);
  }

  const kaCookies = Boolean(process.env.KA_COOKIES);
  accountLine(
    "Kleinanzeigen-Session",
    kaCookies,
    kaCookies ? "gesetzt" : "fehlt — Bot startet trotzdem; Kontoaktionen benötigen später einen Login"
  );
  const csrfOk = hasCookie("CSRF-TOKEN");
  const derivedUserId = userIdFromAccessToken(cookieValue("access_token"));
  const userIdOk = hasCookie("user_id") || Boolean(derivedUserId);
  const bearerOk = hasCookie("access_token") || Boolean(process.env.KA_BEARER_TOKEN);
  const refreshOk = hasCookie("refresh_token");
  const bearerExpiry = accessTokenExpiry(cookieValue("access_token") || process.env.KA_BEARER_TOKEN);
  const chromeMatch = String(process.env.KA_USER_AGENT || "").match(/\bChrome\/(\d+(?:\.\d+)*)/);
  const browserFingerprintOk = Boolean(chromeMatch);
  const installedChromeMatch = systemChromeUserAgent().match(/\bChrome\/(\d+(?:\.\d+)*)/);
  const browserVersionAligned = Boolean(
    chromeMatch
    && installedChromeMatch
    && chromeMatch[1].split(".")[0] === installedChromeMatch[1].split(".")[0]
  );
  if (kaCookies) {
    accountLine("CSRF", csrfOk, csrfOk ? "vorhanden" : "fehlt");
    accountLine(
      "User-ID",
      userIdOk,
      hasCookie("user_id") ? "vorhanden" : (derivedUserId ? "aus Bearer abgeleitet" : "fehlt")
    );
    accountLine(
      "Bearer",
      bearerOk,
      !bearerOk
        ? "fehlt"
        : bearerExpiry && bearerExpiry <= Date.now()
          ? `abgelaufen seit ${new Date(bearerExpiry).toISOString()}; wird vor dem nächsten privaten Request erneuert`
          : bearerExpiry
            ? `gültig bis ${new Date(bearerExpiry).toISOString()}`
            : "vorhanden"
    );
    accountLine(
      "Session-Refresh",
      refreshOk,
      refreshOk
        ? "Refresh-Kontext vorhanden; Gültigkeit mit npm run smoke:ka prüfen"
        : "Refresh-Token fehlt — einmal neu anmelden"
    );
    accountLine(
      "Browser-Fingerabdruck",
      browserFingerprintOk,
      browserFingerprintOk ? `Chrome ${chromeMatch[1]}` : "fehlt — Login oder cURL-Import erneut ausführen"
    );
    accountLine(
      "Chrome-Abgleich",
      browserVersionAligned,
      browserVersionAligned
        ? `gespeicherte und installierte Hauptversion ${chromeMatch[1].split(".")[0]}`
        : `gespeichert ${chromeMatch?.[1] || "fehlt"}, installiert ${installedChromeMatch?.[1] || "fehlt"} — Sitzung auf diesem Mac neu importieren`
    );
  }
  const chromePath = findChromeExecutable();
  accountLine("Chrome", Boolean(chromePath), chromePath || "nicht gefunden; Browserfunktionen bleiben deaktiviert");
  const profile = path.join(root, "workspace", "browser-profile");
  optionalLine("Login-Profil", fs.existsSync(profile), fs.existsSync(profile) ? "vorhanden" : "wird bei Bedarf angelegt");
  const vintedCookies = Boolean(process.env.VINTED_COOKIES);
  const vintedProfile = fs.existsSync(VINTED_PROFILE_DIR);
  optionalLine(
    "Vinted-Session",
    vintedCookies && vintedProfile,
    vintedCookies && vintedProfile
      ? `importiert${process.env.VINTED_USER_ID ? `; Benutzer-ID ${process.env.VINTED_USER_ID}` : "; Benutzer-ID wird beim Smoke-Test ermittelt"}`
      : "fehlt — npm run login:vinted"
  );
  optionalLine(
    "Vinted-Profil",
    vintedProfile,
    vintedProfile ? VINTED_PROFILE_DIR : "wird beim Vinted-Login angelegt"
  );

  const localReady = nodeOk && modeOk && apiKeyOk;
  const accountReady = localReady && kaCookies && csrfOk && userIdOk && bearerOk && refreshOk
    && browserFingerprintOk && browserVersionAligned;
  const listingConfig = kleinanzeigenListingConfig();
  const publishReady = listingConfig.ready;
  line("Lokaler Dry-run", localReady, localReady ? "bereit — npm run chat" : "nicht bereit");
  accountLine(
    "Kontoaktionen",
    accountReady,
    accountReady ? "Basis-Session bereit — mit npm run smoke:ka verifizieren" : "nicht bereit; Bot und öffentliche Suche können trotzdem starten"
  );
  optionalLine(
    "Vinted-Kontoaktionen",
    localReady && vintedCookies && vintedProfile,
    localReady && vintedCookies && vintedProfile
      ? "Basis-Session bereit — mit npm run smoke:vinted minimal verifizieren"
      : "nicht bereit — npm run login:vinted"
  );
  optionalLine(
    "Anzeigen-Veröffentlichung",
    publishReady,
    publishReady
      ? "PLZ, Orts-ID und Kontaktname gesetzt"
      : `vor Live-Veröffentlichung korrigieren: ${listingConfig.problems.join(", ")}`
  );
  if (requireTelegram) {
    line(
      "Telegram-Betrieb",
      telegramTokenOk && chatIdsOk,
      telegramTokenOk && chatIdsOk ? "bereit — npm run launch" : "nicht bereit"
    );
  } else {
    optionalLine(
    "Telegram-Betrieb",
    telegramTokenOk && chatIdsOk,
    telegramTokenOk && chatIdsOk ? "bereit — npm start" : "optional; Token und Chat-ID fehlen"
    );
  }
  if (requiredFailures) process.exitCode = 1;
}

main();
