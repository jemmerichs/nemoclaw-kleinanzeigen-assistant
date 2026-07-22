#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ENV_FILE = path.resolve(__dirname, "../.env");
require("dotenv").config({ path: ENV_FILE });

const TelegramGateway = require("../tools/telegram");
const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { saveToEnv } = require("../tools/auth");
const { saveTemp, processImages } = require("../tools/image");
const { query: dbQuery } = require("../tools/adstore");
const {
  atomicWriteJson,
  boundedJson,
  createSerialExecutor,
  isExplicitApproval,
  parseAllowedChatIds,
  parseClaudeResponse,
  validateStorageKey,
} = require("./runtime");

const SESSION_FILE = path.resolve(__dirname, "../.sessions.json");
const STATE_FILE = path.resolve(__dirname, "../.state.json");
const IMAGE_ROOT = process.env.NEMOCLAW_IMAGE_DIR
  ? path.resolve(process.env.NEMOCLAW_IMAGE_DIR)
  : path.resolve(__dirname, "images");
const MAX_AGENT_STEPS = 12;
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_CHARS = 60000;

let ka = null;
let telegram = null;
let sessions = readJson(SESSION_FILE, {});

function readJson(filePath, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function makeClient(cookies) {
  return new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
}

function loadKleinanzeigenSession({ required = false } = {}) {
  require("dotenv").config({ path: ENV_FILE, override: true });
  const cookies = process.env.KA_COOKIES || "";
  if (!cookies) {
    ka = null;
    if (required) throw new Error("KA_COOKIES fehlt — bitte 'npm run login' ausführen.");
    return false;
  }
  ka = makeClient(cookies);
  return true;
}

function requireKa() {
  if (!ka) loadKleinanzeigenSession({ required: true });
  return ka;
}

async function refreshCsrf() {
  const client = requireKa();
  const newToken = await client.refreshCsrfToken();
  saveToEnv({ KA_COOKIES: client.cookies });
  process.env.KA_COOKIES = client.cookies;
  console.log(`[agent] CSRF erneuert (${newToken.slice(0, 8)}…)`);
}

function setCookie(cookieString, name, value) {
  const pairs = String(cookieString || "").split(";").map(part => part.trim()).filter(Boolean);
  const next = pairs.filter(part => !part.startsWith(`${name}=`));
  if (value) next.push(`${name}=${value}`);
  return next.join("; ");
}

async function refreshBearer() {
  const client = requireKa();
  const data = await client.refreshBearerToken();
  let cookies = process.env.KA_COOKIES || client.cookies || "";
  cookies = setCookie(cookies, "access_token", data.access_token);
  if (data.refresh_token) cookies = setCookie(cookies, "refresh_token", data.refresh_token);
  process.env.KA_COOKIES = cookies;
  saveToEnv({ KA_COOKIES: cookies, KA_BEARER_TOKEN: null });
  ka = makeClient(cookies);
  console.log("[agent] Bearer erneuert.");
}

function assertImagePath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (resolved !== IMAGE_ROOT && !resolved.startsWith(IMAGE_ROOT + path.sep)) {
    throw new Error("Bildpfad liegt außerhalb des erlaubten Bildverzeichnisses.");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Bild nicht gefunden: ${resolved}`);
  if (!/^\.(?:jpe?g|png|gif|webp|bmp)$/i.test(path.extname(resolved))) throw new Error("Nicht unterstütztes Bildformat.");
  return resolved;
}

function memoryFile(key) {
  const safeKey = validateStorageKey(key);
  return path.join(__dirname, "memory", `${safeKey}.md`);
}

const TOOLS = {
  ka_get_conversations: {
    description: "Ungelesene Konversationen aus dem KA-Postfach abrufen",
    args: "{ limit?: number }",
    fn: (args) => requireKa().getConversations(args),
  },
  ka_get_messages: {
    description: "Nachrichten einer Konversation abrufen",
    args: "{ conversationId: string, limit?: number }",
    fn: (args) => requireKa().getMessages(args.conversationId, args),
  },
  ka_send_message: {
    description: "Nachricht auf Kleinanzeigen senden — NUR nach explizitem Go von Jannik",
    args: "{ conversationId: string, text: string }",
    requiresApproval: true,
    fn: (args) => requireKa().sendMessage(args.conversationId, args.text),
  },
  ka_get_my_ads: {
    description: "Eigene aktive Anzeigen auflisten (cookie-auth)",
    args: "{ limit?: number }",
    fn: (args) => requireKa().getMyAds(args),
  },
  ka_get_ad_bundles: {
    description: "Alle eigenen Anzeigen inkl. pausierte abrufen (Bearer-auth)",
    args: "{}",
    fn: () => requireKa().getAdBundles(),
  },
  ka_save_draft: {
    description: "Anzeigen-Entwurf auf KA speichern (kein Go nötig — wird NICHT veröffentlicht). Bilder zuerst mit ka_upload_image(forDraft:true) hochladen, imageUrls hier übergeben.",
    args: "{ title?: string, description?: string, categoryId?: number, priceAmount?: number, priceType?: string, zipCode?: string, locationId?: string, imageUrls?: string[], attributes?: Record<string,string> }",
    fn: (args) => requireKa().saveDraft(args),
  },
  ka_get_drafts: {
    description: "Eigene Anzeigen-Entwürfe abrufen (cookie-auth)",
    args: "{}",
    fn: () => requireKa().getDrafts(),
  },
  ka_delete_draft: {
    description: "Einen KA-Entwurf löschen — NUR nach explizitem Go von Jannik. draftId aus ka_get_drafts.",
    args: "{ draftId: string }",
    requiresApproval: true,
    fn: (args) => requireKa().deleteDraft(args.draftId),
  },
  ka_search_ads: {
    description: "Öffentliche Anzeigen nach Keyword/Kategorie durchsuchen — für Preisrecherche",
    args: "{ keyword: string, categoryId?: number, categorySlug?: string, page?: number, limit?: number }",
    fn: (args) => requireKa().searchAds(args),
  },
  ka_upload_image: {
    description: "Bild hochladen — gibt imageId und imageUrl zurück. imageUrl für ka_create_ad oder ka_save_draft. forDraft:true setzen wenn für Entwurf.",
    args: "{ filePath: string, filename?: string, mimeType?: string, forDraft?: boolean }",
    fn: async (args) => {
      const filePath = assertImagePath(args.filePath);
      const buffer = fs.readFileSync(filePath);
      const mime = args.mimeType || {
        ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
      }[path.extname(filePath).toLowerCase()] || "image/jpeg";
      return requireKa().uploadImage(buffer, args.filename || path.basename(filePath), mime, { forDraft: !!args.forDraft });
    },
  },
  ka_create_ad: {
    description: "Neue Anzeige erstellen — NUR nach explizitem Go von Jannik",
    args: "{ title: string, description: string, categoryId: number, price: number, priceType?: string, zipCode?: string, locationId?: string, contactName?: string, imageUrls?: string[], attributes?: Record<string,string> }",
    requiresApproval: true,
    fn: (args) => requireKa().createAd(args),
  },
  processImages: {
    description: "Fotos via Gemini aufbereiten — minimale, ehrliche Bearbeitung (Hintergrund, Helligkeit), keine Mängel verstecken",
    args: "{ paths: string[], instructions?: string }",
    fn: (args) => processImages({
      paths: (args.paths || []).map(assertImagePath),
      instructions: String(args.instructions || "").slice(0, 2000),
    }),
  },
  db_query: {
    description: "SQL auf der lokalen Asset-Datenbank ausführen. Tabellen: assets, ka_listings, ka_snapshots. Nur SELECT/WITH/INSERT/UPDATE.",
    args: "{ sql: string, params?: any[] }",
    fn: (args) => dbQuery({ sql: args.sql, params: args.params || [] }),
  },
  saveImages: {
    description: "Bildpfade zu einem Asset speichern (append). Liest bestehende image_paths, merged, schreibt zurück. Kein JSON.stringify nötig.",
    args: "{ assetId: number, paths: string[] }",
    fn: (args) => {
      const assetId = Number(args.assetId);
      if (!Number.isInteger(assetId) || assetId < 1) throw new Error("Ungültige assetId.");
      const imagePaths = (args.paths || []).map(assertImagePath);
      const rows = dbQuery({ sql: "SELECT image_paths FROM assets WHERE id=?", params: [assetId] });
      if (!rows.length) throw new Error(`Asset ${assetId} nicht gefunden`);
      let existing = [];
      try { existing = rows[0].image_paths ? JSON.parse(rows[0].image_paths) : []; }
      catch { throw new Error(`Asset ${assetId} enthält ungültige image_paths.`); }
      const merged = [...new Set([...existing, ...imagePaths])];
      dbQuery({
        sql: "UPDATE assets SET image_paths=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
        params: [JSON.stringify(merged), assetId],
      });
      return { assetId, imageCount: merged.length, paths: merged };
    },
  },
  updateSkillFile: {
    description: "Skill-Datei in workspace/skills/ schreiben — NUR nach explizitem Go von Jannik. Immer zuerst den geplanten Inhalt zeigen und warten.",
    args: "{ filename: string, content: string }",
    requiresApproval: true,
    fn: (args) => {
      const filename = path.basename(String(args.filename || ""));
      if (!/^[a-z0-9][a-z0-9_-]*\.md$/i.test(filename)) throw new Error("Ungültiger Skill-Dateiname.");
      const content = String(args.content || "");
      if (!content || content.length > 100000) throw new Error("Skill-Inhalt fehlt oder ist zu lang.");
      const target = path.join(__dirname, "skills", filename);
      fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
      return { written: filename };
    },
  },
  memoryWrite: {
    description: "Erkenntnis oder Fakt dauerhaft speichern. key = kurzer Dateiname ohne Endung.",
    args: "{ key: string, content: string }",
    fn: (args) => {
      const file = memoryFile(args.key);
      const content = String(args.content || "");
      if (!content || content.length > 100000) throw new Error("Memory-Inhalt fehlt oder ist zu lang.");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
      return { ok: true, key: validateStorageKey(args.key) };
    },
  },
  memoryRead: {
    description: "Memory-Datei(en) lesen. Ohne key: alle Memory-Dateien auflisten. Mit key: Inhalt lesen.",
    args: "{ key?: string }",
    fn: (args) => {
      const directory = path.join(__dirname, "memory");
      if (!fs.existsSync(directory)) return { files: [] };
      if (!args.key) {
        return { files: fs.readdirSync(directory).filter(file => /^[a-z0-9][a-z0-9_-]*\.md$/i.test(file)).map(file => file.slice(0, -3)) };
      }
      const key = validateStorageKey(args.key);
      const file = memoryFile(key);
      if (!fs.existsSync(file)) return { error: `Memory '${key}' nicht gefunden` };
      return { key, content: fs.readFileSync(file, "utf8").slice(0, 100000) };
    },
  },
  memoryDelete: {
    description: "Memory-Eintrag löschen. Nur verwenden wenn eine Erkenntnis veraltet oder falsch ist.",
    args: "{ key: string }",
    fn: (args) => {
      const key = validateStorageKey(args.key);
      const file = memoryFile(key);
      if (!fs.existsSync(file)) return { error: `Memory '${key}' nicht gefunden` };
      fs.unlinkSync(file);
      return { ok: true, deleted: key };
    },
  },
};

function toolManifest() {
  return Object.entries(TOOLS)
    .map(([name, tool]) => `- ${name}(${tool.args}): ${tool.description}`)
    .join("\n");
}

function findClaude() {
  const configured = process.env.CLAUDE_BIN;
  const candidates = [configured, "claude"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", stdio: "pipe" });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function safeClaudeEnv() {
  const env = { ...process.env };
  for (const key of ["TELEGRAM_BOT_TOKEN", "KA_COOKIES", "KA_BEARER_TOKEN", "KA_EMAIL", "KA_PASSWORD", "GEMINI_API_KEY"]) {
    delete env[key];
  }
  return env;
}

function callClaude(claudeBin, systemPrompt, userPrompt) {
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const configuredTimeout = Number(process.env.CLAUDE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(10000, Math.min(600000, configuredTimeout))
    : 120000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      claudeBin,
      ["-p", userPrompt, "--model", model, "--system-prompt", systemPrompt, "--tools", ""],
      { cwd: os.tmpdir(), env: safeClaudeEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI Timeout nach ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Claude CLI fehlgeschlagen (${code}): ${stderr.trim().slice(0, 500)}`));
      try { resolve(parseClaudeResponse(stdout)); }
      catch (error) { reject(error); }
    });
  });
}

function loadContext() {
  const agentMd = fs.readFileSync(path.join(__dirname, "agent.md"), "utf8");
  const skillsDir = path.join(__dirname, "skills");
  const skills = fs.readdirSync(skillsDir)
    .filter(file => file.endsWith(".md"))
    .sort()
    .map(file => fs.readFileSync(path.join(skillsDir, file), "utf8").slice(0, 50000))
    .join("\n\n---\n\n");

  const memoryDir = path.join(__dirname, "memory");
  let memory = "";
  if (fs.existsSync(memoryDir)) {
    const entries = fs.readdirSync(memoryDir).filter(file => /^[a-z0-9][a-z0-9_-]*\.md$/i.test(file)).sort();
    if (entries.length) {
      const full = entries.map(file => `### ${file.slice(0, -3)}\n${fs.readFileSync(path.join(memoryDir, file), "utf8")}`).join("\n\n");
      memory = full.length <= 8000
        ? "\n\n## Dein Gedächtnis (Memory)\n\n" + full
        : `\n\n## Dein Gedächtnis (Memory)\n\nVerfügbare Keys: ${entries.map(file => file.slice(0, -3)).join(", ")}\nNutze memoryRead({ key }).`;
    }
  }

  return `${agentMd}\n\n## Verfügbare Tools (Hard Skills)\n${toolManifest()}\n\n## Skill-Dokumentation (Soft Skills)\n\n${skills}${memory}`;
}

function getHistory(chatId) {
  const key = String(chatId);
  if (!Array.isArray(sessions[key])) sessions[key] = [];
  return sessions[key];
}

function trimHistory(chatId) {
  const key = String(chatId);
  let history = getHistory(key).slice(-MAX_HISTORY_ENTRIES);
  while (history.length > 1 && history.join("\n").length > MAX_HISTORY_CHARS) history.shift();
  sessions[key] = history;
}

function saveSession(chatId) {
  trimHistory(chatId);
  try { atomicWriteJson(SESSION_FILE, sessions); }
  catch (error) { console.error(`[agent] Session konnte nicht gespeichert werden: ${error.message}`); }
}

async function executeTool(toolName, args) {
  const tool = TOOLS[toolName];
  if (!tool) throw new Error(`Unbekanntes Tool "${toolName}"`);
  try {
    return await tool.fn(args || {});
  } catch (error) {
    if (error.message.includes("CSRF abgelaufen")) {
      await refreshCsrf();
      return tool.fn(args || {});
    }
    if (error.message.includes("Bearer token abgelaufen")) {
      await refreshBearer();
      return tool.fn(args || {});
    }
    if (error.message.includes("Session abgelaufen")) {
      await refreshCsrf();
      return tool.fn(args || {});
    }
    throw error;
  }
}

async function runAgent(chatId, userMessage, { claudeBin } = {}) {
  if (!telegram) throw new Error("Telegram Gateway ist nicht initialisiert.");
  const history = getHistory(chatId);
  history.push(`Jannik: ${String(userMessage).slice(0, 12000)}`);
  const systemPrompt = loadContext();
  const hasApproval = isExplicitApproval(userMessage);
  let approvalConsumed = false;
  let answered = false;

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const userPrompt =
        `## Session\nJannik's Telegram Chat-ID: ${chatId}\n\n` +
        `## Konversation\n${history.join("\n")}\n\n` +
        `Antworte ausschließlich als JSON:\n` +
        `Mit Tool-Aufruf: {"message":"...","action":{"tool":"TOOLNAME","args":{...}}}\n` +
        `Mit Foto-Antwort: {"message":"...","photo":"/lokaler/pfad.jpg"}\n` +
        `Ohne Tool-Aufruf: {"message":"..."}\n` +
        `message ist was Jannik sieht (darf leer sein wenn du nur ein Tool aufrufst).`;

      console.log(`[claude →] thinking... (step ${step + 1})`);
      const response = await callClaude(claudeBin, systemPrompt, userPrompt);

      if (response.action) {
        const toolName = String(response.action.tool || "");
        const tool = TOOLS[toolName];
        if (!tool) {
          history.push(`System: Unbekanntes Tool "${toolName}". Nutze nur Tools aus dem Manifest.`);
          continue;
        }
        if (tool.requiresApproval && (!hasApproval || approvalConsumed)) {
          history.push(`System: Tool "${toolName}" wurde NICHT ausgeführt. Diese Aktion erfordert als aktuelle Nachricht ein eigenständiges \"Go\" von Jannik.`);
          continue;
        }
        if (tool.requiresApproval) approvalConsumed = true;

        const args = response.action.args || {};
        console.log(`[tool →] ${toolName}(${boundedJson(args, 2000)})`);
        try {
          const result = await executeTool(toolName, args);
          const resultJson = boundedJson(result);
          console.log(`[tool ←] ${toolName}: ${resultJson.slice(0, 300)}${resultJson.length > 300 ? "…" : ""}`);
          history.push(`Tool(${toolName}): ${resultJson}`);
        } catch (error) {
          console.error(`[tool ✗] ${toolName}: ${error.message}`);
          history.push(`System: Tool "${toolName}" fehlgeschlagen — ${error.message}. Informiere Jannik kurz und stoppe.`);
        }
        continue;
      }

      if (response.photo) {
        const photoPath = assertImagePath(response.photo);
        const caption = String(response.message || "").slice(0, 1024);
        await telegram.sendPhoto(chatId, photoPath, caption);
        history.push(`Agent: [Foto gesendet: ${photoPath}]${caption ? " " + caption : ""}`);
        answered = true;
      } else if (response.message) {
        const message = String(response.message).slice(0, 12000);
        await telegram.send(chatId, message);
        history.push(`Agent: ${message}`);
        answered = true;
      }
      if (!answered) {
        await telegram.send(chatId, "Ich konnte keine gültige Antwort erzeugen. Bitte versuche es noch einmal.");
        answered = true;
      }
      break;
    }

    if (!answered) {
      const fallback = "Ich konnte die Aufgabe nicht innerhalb eines Durchlaufs abschließen. Es wurde keine weitere bestätigungspflichtige Aktion ausgeführt.";
      await telegram.send(chatId, fallback);
      history.push(`Agent: ${fallback}`);
    }
  } finally {
    saveSession(chatId);
  }
}

function randomHeartbeatIntervalMs() {
  return Math.floor(3 * 60 * 60 * 1000 + Math.random() * 3 * 60 * 60 * 1000);
}

function validateConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_ID);
  const errors = [];
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) errors.push("TELEGRAM_BOT_TOKEN fehlt oder ist ungültig");
  if (!allowedChatIds.size || [...allowedChatIds].some(id => !/^-?\d+$/.test(id))) {
    errors.push("TELEGRAM_ALLOWED_CHAT_ID fehlt oder ist ungültig");
  }
  const configuredHeartbeatId = String(process.env.TELEGRAM_HEARTBEAT_CHAT_ID || "").trim();
  if (configuredHeartbeatId && !allowedChatIds.has(configuredHeartbeatId)) {
    errors.push("TELEGRAM_HEARTBEAT_CHAT_ID muss in TELEGRAM_ALLOWED_CHAT_ID(S) enthalten sein");
  }
  const claudeBin = findClaude();
  if (!claudeBin) errors.push("Claude CLI nicht gefunden (CLAUDE_BIN setzen oder 'claude' in PATH bereitstellen)");
  if (errors.length) throw new Error(errors.join("; "));
  return { token, allowedChatIds, claudeBin };
}

async function main() {
  const { token, allowedChatIds, claudeBin } = validateConfig();
  const state = readJson(STATE_FILE, {});
  telegram = new TelegramGateway(token, { lastUpdateId: state.lastUpdateId });
  loadKleinanzeigenSession();

  console.log("[agent] nemoclaw-kleinanzeigen gestartet");
  if (!ka) console.warn("[agent] Keine KA-Session. Bot läuft, aber KA-Tools benötigen zuerst 'npm run login'.");

  const enqueue = createSerialExecutor();
  const heartbeatChatId = String(process.env.TELEGRAM_HEARTBEAT_CHAT_ID || [...allowedChatIds][0]);
  let stopped = false;
  let heartbeatTimer = null;
  let consecutiveErrors = 0;

  function scheduleHeartbeat() {
    const delay = randomHeartbeatIntervalMs();
    console.log(`[agent] Nächster Inbox-Check in ${(delay / 3600000).toFixed(1)}h`);
    heartbeatTimer = setTimeout(() => {
      if (stopped) return;
      enqueue(heartbeatChatId, () => runAgent(heartbeatChatId, "Prüfe das Postfach auf neue Nachrichten.", { claudeBin }))
        .catch(error => console.error(`[heartbeat] ${error.message}`))
        .finally(scheduleHeartbeat);
    }, delay);
  }
  scheduleHeartbeat();

  const shutdown = () => {
    stopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (!stopped) {
    try {
      const updates = await telegram.getUpdates({ timeoutSeconds: 25 });
      consecutiveErrors = 0;
      for (const update of updates) {
        const message = update.message;
        if (!message?.chat?.id) continue;
        const chatId = String(message.chat.id);
        if (!allowedChatIds.has(chatId)) {
          console.warn(`[agent] Nachricht von nicht autorisierter Chat-ID ${chatId} ignoriert.`);
          continue;
        }

        try {
          if (message.text) {
            console.log(`[tg ←] ${message.text}`);
            await enqueue(chatId, () => runAgent(chatId, message.text, { claudeBin }));
          } else if (message.photo) {
            const best = message.photo[message.photo.length - 1];
            const caption = message.caption ? ` ${message.caption}` : "";
            const buffer = await telegram.downloadPhoto(best.file_id);
            const localPath = saveTemp(buffer, ".jpg");
            console.log(`[tg ←] [FOTO → ${localPath}]${caption}`);
            await enqueue(chatId, () => runAgent(chatId, `[FOTO path:${localPath}]${caption}`, { claudeBin }));
          }
        } catch (error) {
          console.error(`[agent] Nachricht fehlgeschlagen: ${error.message}`);
          await telegram.send(chatId, `Die Verarbeitung ist fehlgeschlagen: ${error.message}`).catch(() => {});
        }
      }
      atomicWriteJson(STATE_FILE, { lastUpdateId: telegram.lastUpdateId });
    } catch (error) {
      consecutiveErrors++;
      const delay = Math.min(60000, 1000 * 2 ** Math.min(consecutiveErrors - 1, 6));
      if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
        console.error(`[agent] Telegram-Verbindung (${consecutiveErrors}x): ${error.message}. Neuer Versuch in ${delay / 1000}s.`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[agent] Start fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  TOOLS,
  assertImagePath,
  callClaude,
  findClaude,
  loadContext,
  loadKleinanzeigenSession,
  main,
  runAgent,
  setCookie,
  validateConfig,
};
