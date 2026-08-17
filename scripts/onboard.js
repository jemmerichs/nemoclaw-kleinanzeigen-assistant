#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), override: true });

const TelegramGateway = require("../tools/telegram");
const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { inspectCategoryForm } = require("../tools/kleinanzeigen-form");
const { kleinanzeigenListingConfig } = require("../tools/listing-config");
const { adoptNewerObservedSession, saveToEnv } = require("../tools/auth");
const { evaluatePrivateRead } = require("../tools/session-readiness");
const { formatFinalStatus, runOnboarding } = require("../tools/target-mac-setup");

function fixture() {
  if (!process.env.NEMOCLAW_ONBOARD_FIXTURE) return null;
  return JSON.parse(process.env.NEMOCLAW_ONBOARD_FIXTURE);
}

async function main() {
  const synthetic = fixture();
  const result = await runOnboarding({
    ensureDryRun: async () => {
      saveToEnv({ NEMOCLAW_MODE: "dry-run" });
      process.env.NEMOCLAW_MODE = "dry-run";
    },
    checkLocal: async () => {
      if (synthetic) return synthetic.local;
      const config = kleinanzeigenListingConfig();
      const apiKeyOk = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(process.env.OPENROUTER_API_KEY || "");
      return apiKeyOk && config.ready
        ? { ok: true }
        : {
          ok: false,
          detail: "Die nicht geheime Grundkonfiguration ist unvollständig.",
          action: "OpenRouter-Key, Standard-PLZ und Profilname in .env vervollständigen.",
        };
    },
    verifyTelegram: async () => {
      if (synthetic) return synthetic.telegram;
      const token = process.env.TELEGRAM_BOT_TOKEN || "";
      const chatId = process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_ID || "";
      if (!token || !chatId) return { ok: false, detail: "Telegram ist nicht vollständig konfiguriert.", action: "Telegram-Token und eigene Chat-ID in .env setzen." };
      try {
        const gateway = new TelegramGateway(token);
        await gateway._request("getMe", {});
        return { ok: true };
      } catch {
        return { ok: false, detail: "Telegram konnte nicht verifiziert werden.", action: "Telegram-Token prüfen und npm run onboard erneut ausführen." };
      }
    },
    ensureSession: async () => {
      if (synthetic || process.env.KA_COOKIES) return { ok: true };
      const login = spawnSync(process.execPath, [path.join(root, "scripts", "login.js")], {
        cwd: root,
        encoding: "utf8",
      });
      require("dotenv").config({ path: path.join(root, ".env"), override: true });
      return login.status === 0 && process.env.KA_COOKIES
        ? { ok: true }
        : {
          ok: false,
          detail: "Die lokale Marktplatz-Sitzung ist noch nicht angemeldet.",
          action: "Den manuellen Login im geöffneten Chrome-Profil abschließen und npm run onboard erneut ausführen.",
        };
    },
    evaluateAccount: async () => {
      if (synthetic) return synthetic.evidence;
      const cookies = process.env.KA_COOKIES || "";
      if (!cookies) return { state: "unavailable" };
      const client = new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
      return evaluatePrivateRead({
        cookieHeader: () => client.cookies,
        userAgent: process.env.KA_USER_AGENT || "",
        privateRead: () => client.getMyAds({ limit: 1 }),
        refresh: async () => {
          await client.refreshAccessToken();
          saveToEnv({ KA_COOKIES: client.cookies, KA_BEARER_TOKEN: null });
          process.env.KA_COOKIES = client.cookies;
          delete process.env.KA_BEARER_TOKEN;
        },
      });
    },
    verifyVisibleForm: async () => {
      if (synthetic) return synthetic.form;
      try {
        const result = await inspectCategoryForm({
          categoryPath: [],
          onSessionObserved: adoptNewerObservedSession,
        });
        return result?.status === "selection_required" || result?.status === "ready"
          ? { ok: true, formFingerprint: result.formState?.formFingerprint || null }
          : { ok: false, detail: "Die sichtbare Anzeigenvorbereitung ist nicht verfügbar.", action: "Im lokalen Chrome-Profil anmelden und npm run onboard erneut ausführen." };
      } catch {
        return { ok: false, detail: "Die sichtbare Anzeigenvorbereitung ist nicht verfügbar.", action: "Im lokalen Chrome-Profil anmelden und npm run onboard erneut ausführen." };
      }
    },
    startDryRunService: async () => {
      if (synthetic) return synthetic.service;
      const command = spawnSync(process.execPath, [path.join(root, "scripts", "launch-agent.js"), "install"], {
        cwd: root,
        encoding: "utf8",
      });
      return command.status === 0
        ? { ok: true }
        : { ok: false, detail: "Der Dry-run-Dienst konnte nicht gestartet werden.", action: "macOS-Automationsfreigabe prüfen und npm run onboard erneut ausführen." };
    },
  });
  process.stdout.write(`${formatFinalStatus(result)}\n`);
  if (result.status === "blockiert") process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
