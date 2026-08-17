#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = {
    marker: `canary-${crypto.randomBytes(5).toString("hex")}`,
    timeoutSeconds: 300,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--marker") {
      options.marker = String(argv[++index] || "").trim();
      if (!/^[a-z0-9][a-z0-9_-]{5,63}$/i.test(options.marker)) {
        throw new Error("--marker muss aus 6–64 Buchstaben, Zahlen, '-' oder '_' bestehen.");
      }
    } else if (arg === "--timeout-seconds") {
      options.timeoutSeconds = Number(argv[++index]);
      if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 900) {
        throw new Error("--timeout-seconds muss zwischen 30 und 900 liegen.");
      }
    } else {
      throw new Error(`Unbekanntes Argument: ${arg}`);
    }
  }
  return options;
}

function readJson(filePath, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && !Array.isArray(value) && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function messageText(message = {}) {
  return String(message.caption || message.text || "");
}

function selectCanaryUpdates(updates, allowedChatIds, marker) {
  const allowed = (updates || []).filter(update => (
    update?.message?.chat?.id !== undefined
    && allowedChatIds.has(String(update.message.chat.id))
  ));
  const seeds = allowed.filter(update => messageText(update.message).includes(marker));
  if (!seeds.length) return { selected: [], unexpected: allowed };
  if (seeds.length !== 1) {
    throw new Error(`Der Canary-Marker kam ${seeds.length}x statt genau einmal vor.`);
  }
  const seed = seeds[0];
  const chatId = String(seed.message.chat.id);
  const groupId = String(seed.message.media_group_id || "");
  const selected = allowed.filter(update => (
    String(update.message.chat.id) === chatId
    && (groupId
      ? String(update.message.media_group_id || "") === groupId
      : Number(update.update_id) === Number(seed.update_id))
  ));
  const selectedIds = new Set(selected.map(update => Number(update.update_id)));
  return {
    selected,
    unexpected: allowed.filter(update => !selectedIds.has(Number(update.update_id))),
  };
}

function explainTelegramPollError(error) {
  const message = String(error?.message || error || "");
  if (/Telegram getUpdates fehlgeschlagen \(409\):.*Conflict/i.test(message)) {
    return new Error(
      "Telegram-Canary blockiert: Eine andere Bot-Instanz fragt denselben Token bereits ab. " +
      "Den anderen Bot kurz stoppen oder für den Dev-Mac einen separaten Telegram-Bot verwenden. " +
      "Es wurde keine Testnachricht verarbeitet."
    );
  }
  return error instanceof Error ? error : new Error(message || "Telegram-Polling ist fehlgeschlagen.");
}

function isRetryableTelegramPollError(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  return ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(code)
    || /Telegram getUpdates: Timeout/i.test(String(error?.message || error || ""));
}

async function getCanaryUpdates(gateway, {
  timeoutSeconds = 25,
  deadline = Date.now() + 60_000,
  retryDelayMs = 500,
} = {}) {
  do {
    try {
      return await gateway.getUpdates({ timeoutSeconds });
    } catch (error) {
      if (!isRetryableTelegramPollError(error) || Date.now() >= deadline) {
        throw explainTelegramPollError(error);
      }
      if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  } while (Date.now() < deadline);
  throw new Error("Zeitüberschreitung beim sicheren Telegram-Polling.");
}

async function createCanaryImage(filePath) {
  const sharp = require("sharp");
  const svg = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">',
    '<rect width="1200" height="900" fill="#f3efe4"/>',
    '<rect x="190" y="700" width="820" height="50" rx="25" fill="#403b36"/>',
    '<path d="M600 700 L600 330 L820 170" stroke="#292725" stroke-width="42" fill="none" stroke-linecap="round"/>',
    '<path d="M740 115 L955 210 L850 390 L635 295 Z" fill="#2e5d62"/>',
    '<circle cx="670" cy="305" r="42" fill="#f6ce68"/>',
    '<text x="600" y="825" text-anchor="middle" font-family="Arial, sans-serif" font-size="44" fill="#403b36">DEV CANARY – SCHREIBTISCHLAMPE</text>',
    '</svg>',
  ].join(""));
  await sharp(svg).jpeg({ quality: 88 }).toFile(filePath);
}

function canaryCaption(marker) {
  return [
    marker,
    "Dev-Mac Dry-run-Canary: Das Bild zeigt eine Testgrafik einer Schreibtischlampe, keinen realen Verkaufsgegenstand.",
    "Analysiere das Bild, recherchiere vergleichbare Angebote und bereite autonom einen vollständigen Kleinanzeigen-Vorschlag vor.",
    "Verwende ka_prepare_listing und merke bei ready mit ka_publish_prepared_listing nur die Dry-run-Aktion vor. Nichts hochladen oder veröffentlichen.",
  ].join("\n");
}

function assertCanaryResult(pending, outbound) {
  if (!pending || pending.tool !== "ka_publish_prepared_listing") {
    const detail = String(outbound.at(-1) || "keine Bot-Antwort").slice(0, 800);
    throw new Error(`Der Agent hat keine veröffentlichungsbereite Dry-run-Aktion vorgemerkt. Letzte Antwort: ${detail}`);
  }
  const listing = pending.args?.listing || {};
  const failures = [];
  if (pending.mode !== "dry-run") failures.push("Aktion ist nicht an Dry-run gebunden");
  if (!/^\d{5}$/.test(String(listing.zipCode || "")) || listing.zipCode === "00000") {
    failures.push("sichtbare PLZ fehlt oder ist ungültig");
  }
  if (!String(listing.locationId || "").trim() || !String(listing.locationName || "").trim()) {
    failures.push("sichtbarer Ort ist nicht vollständig gebunden");
  }
  if (!String(listing.contactName || "").trim()) failures.push("sichtbarer Profilname fehlt");
  if (!/^[a-f0-9]{64}$/.test(String(listing.formFingerprint || ""))) {
    failures.push("Formular-Fingerprint fehlt");
  }
  if (!String(listing.sessionRevision || "").trim()) failures.push("Session-Revision fehlt");
  if (!Array.isArray(listing.imagePaths) || listing.imagePaths.length !== 1) {
    failures.push("genau ein Telegram-Bild wurde nicht gebunden");
  }
  if (!Array.isArray(pending.materials) || pending.materials.length !== 1) {
    failures.push("Foto-Hash-Manifest fehlt");
  }
  const proposal = outbound.join("\n");
  for (const expected of [listing.title, pending.args.category, listing.locationName]) {
    if (expected && !proposal.includes(String(expected))) failures.push(`Vorschau enthält nicht: ${expected}`);
  }
  if (!/Dry-run ist aktiv/i.test(proposal)) failures.push("Telegram-Antwort enthält keinen Dry-run-Hinweis");
  if (failures.length) throw new Error(`Canary unvollständig: ${failures.join("; ")}.`);
  return listing;
}

async function main() {
  require("dotenv").config({ path: path.join(root, ".env"), override: true });
  const options = parseArgs(process.argv.slice(2));
  const realStateFile = process.env.NEMOCLAW_STATE_FILE
    ? path.resolve(process.env.NEMOCLAW_STATE_FILE)
    : path.join(root, ".state.json");
  const lastUpdateId = Number(readJson(realStateFile).lastUpdateId || 0);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-agent-canary-"));
  const imagePath = path.join(temporary, "telegram-canary.jpg");

  process.env.NEMOCLAW_MODE = "dry-run";
  process.env.NEMOCLAW_COMPLEXITY_ROUTING = "off";
  process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
  process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");
  process.env.NEMOCLAW_READINESS_FILE = path.join(temporary, "readiness.json");
  process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
  process.env.NEMOCLAW_IMAGE_DIR = path.join(temporary, "images");
  process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE = path.join(temporary, "category-contracts.json");

  const TelegramGateway = require("../tools/telegram");
  const agent = require("../workspace/agent");
  const store = require("../tools/adstore");
  const { createSerialExecutor } = require("../workspace/runtime");
  let releaseLock;
  let chatId = null;
  const outbound = [];
  try {
    releaseLock = agent.acquireProcessLock();
    const { token, allowedChatIds } = agent.validateConfig();
    if (!agent.loadKleinanzeigenSession({ required: true })) {
      throw new Error("Die lokale Kleinanzeigen-Sitzung fehlt. Zuerst npm run login ausführen.");
    }
    await createCanaryImage(imagePath);
    const gateway = new TelegramGateway(token, { lastUpdateId });
    const realSend = gateway.send.bind(gateway);
    gateway.send = async (targetChatId, text) => {
      outbound.push(String(text || ""));
      return realSend(targetChatId, text);
    };
    const llmClient = agent.createLlmClientFromEnv();
    const enqueue = createSerialExecutor();
    const albumBuffer = new Map();
    const deadline = Date.now() + options.timeoutSeconds * 1000;

    process.stdout.write([
      "Telegram-Agent-Canary wartet auf genau ein Foto.",
      `Marker: ${options.marker}`,
      `Bild: ${imagePath}`,
      "Caption:",
      canaryCaption(options.marker),
      "",
    ].join("\n"));

    let selected = [];
    while (Date.now() < deadline && !selected.length) {
      const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const updates = await getCanaryUpdates(gateway, {
        timeoutSeconds: Math.min(25, remainingSeconds),
        deadline,
      });
      const batch = selectCanaryUpdates(updates, allowedChatIds, options.marker);
      if (batch.unexpected.length) {
        throw new Error(
          "Während des Canarys wartet eine andere erlaubte Telegram-Nachricht. " +
          "Sie wurde nicht bestätigt; zuerst mit dem normalen Bot verarbeiten und den Canary danach wiederholen."
        );
      }
      selected = batch.selected;
    }
    if (!selected.length) throw new Error("Zeitüberschreitung: Die markierte Telegram-Nachricht wurde nicht empfangen.");
    if (selected.some(update => update.message?.media_group_id)) {
      throw new Error("Für diesen Canary genau ein einzelnes Foto statt eines Albums senden.");
    }
    if (selected.length !== 1 || !selected[0].message?.photo?.length) {
      throw new Error("Die Canary-Nachricht enthält nicht genau ein Telegram-Foto.");
    }
    chatId = String(selected[0].message.chat.id);
    await agent.processTelegramUpdates(selected, allowedChatIds, enqueue, llmClient, {
      gateway,
      albumBuffer,
      albumDelayMs: 50,
    });

    // The agent has handled this exact message, even if a later canary assertion
    // fails. Confirm it now so the normal bot cannot answer it a second time.
    // Any newer update returned here remains unconfirmed because no later poll occurs.
    await getCanaryUpdates(gateway, {
      timeoutSeconds: 0,
      deadline: Math.min(deadline, Date.now() + 30_000),
    });
    const pending = agent.getPending(chatId);
    const listing = assertCanaryResult(pending, outbound);
    process.stdout.write([
      "Telegram-Agent-Canary OK",
      `model=${llmClient.model}`,
      `title=${listing.title}`,
      `category=${pending.args.category}`,
      `location=${listing.locationName}`,
      `images=${listing.imagePaths.length}`,
      "upload=not-started",
      "publish=not-started",
      "",
    ].join(" | "));
  } finally {
    if (chatId) agent.clearPending(chatId);
    if (releaseLock) releaseLock();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Telegram-Agent-Canary fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertCanaryResult,
  canaryCaption,
  explainTelegramPollError,
  getCanaryUpdates,
  isRetryableTelegramPollError,
  messageText,
  parseArgs,
  selectCanaryUpdates,
};
