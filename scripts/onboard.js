#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), override: true });

const TelegramGateway = require("../tools/telegram");
const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { saveToEnv } = require("../tools/auth");
const { evaluatePrivateRead } = require("../tools/session-readiness");
const { formatFinalStatus, runOnboarding } = require("../tools/target-mac-setup");

function fixture() {
  if (!process.env.NEMOCLAW_ONBOARD_FIXTURE) return null;
  return JSON.parse(process.env.NEMOCLAW_ONBOARD_FIXTURE);
}

function runSessionCommand(args, { failureDetail, failureAction } = {}) {
  const command = spawnSync(process.execPath, [path.join(root, "scripts", "login.js"), ...args], {
    cwd: root,
    stdio: "inherit",
  });
  require("dotenv").config({ path: path.join(root, ".env"), override: true });
  return command.status === 0 && process.env.KA_COOKIES
    ? { ok: true }
    : {
      ok: false,
      detail: failureDetail,
      action: failureAction,
    };
}

function importProfileSession() {
  return runSessionCommand(["--import-only"], {
    failureDetail: "Die vorhandene dedizierte Browser-Sitzung konnte nicht importiert werden.",
    failureAction: "Den geführten Login im anschließend geöffneten Chrome-Profil abschließen.",
  });
}

function runLogin() {
  const result = runSessionCommand([], {
    failureDetail: "Der geführte Login wurde nicht mit einer gültigen Sitzung abgeschlossen.",
    failureAction: "npm run login separat abschließen und danach npm run onboard erneut ausführen.",
  });
  return result.ok ? { ...result, loginPerformed: true } : result;
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
      const apiKeyOk = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(process.env.OPENROUTER_API_KEY || "");
      return apiKeyOk
        ? { ok: true }
        : {
          ok: false,
          detail: "Die lokale Grundkonfiguration ist unvollständig.",
          action: "OpenRouter-Key in .env vervollständigen.",
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
      return { ok: true };
    },
    importSession: async () => {
      if (synthetic) return synthetic.import || { ok: false };
      return importProfileSession();
    },
    recoverSession: async () => {
      if (synthetic) return synthetic.recovery || {
        ok: false,
        detail: "Die synthetische Sitzung erfordert einen Login.",
        action: "Eine erfolgreiche Recovery-Fixture bereitstellen.",
      };
      return runLogin();
    },
    evaluateAccount: async () => {
      if (synthetic) return synthetic.evidence;
      const cookies = process.env.KA_COOKIES || "";
      if (!cookies) return { state: "unavailable", loginRequired: true };
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
  });
  process.stdout.write(`${formatFinalStatus(result)}\n`);
  if (result.status === "blockiert") process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
