#!/usr/bin/env node
/**
 * nemoclaw-kleinanzeigen — thin bridge
 *
 * Telegram ←→ Claude (reasoning + skill docs) ←→ tool execution
 * No skill logic here. Skills live in workspace/skills/*.md
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs   = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");
const TelegramGateway      = require("../tools/telegram");
const KleinanzeigenClient  = require("../tools/kleinanzeigen");
const { login, saveToEnv } = require("../tools/auth");
const { saveTemp, processImages } = require("../tools/image");
const { query: dbQuery }          = require("../tools/adstore");

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!TOKEN) { console.error("[agent] TELEGRAM_BOT_TOKEN fehlt."); process.exit(1); }

const tg = new TelegramGateway(TOKEN);
let ka;  // initialised after login

function makeClient(cookies) {
  // Tokens are extracted from cookies by the client automatically.
  // KA_BEARER_TOKEN may be set after a token refresh to override the cookie value.
  return new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
}

async function ensureLogin() {
  let cookies = process.env.KA_COOKIES || "";

  if (!cookies) {
    console.log("[agent] Keine Cookies — versuche automatischen Login...");
    const creds = await login({
      email:    process.env.KA_EMAIL,
      password: process.env.KA_PASSWORD,
      headless: true,
    }).catch(async (e) => {
      console.warn(`[agent] Headless-Login fehlgeschlagen: ${e.message}`);
      console.log("[agent] Versuche mit sichtbarem Browser...");
      return login({
        email:    process.env.KA_EMAIL,
        password: process.env.KA_PASSWORD,
        headless: false,
      });
    });
    process.env.KA_COOKIES = creds.cookies;
    cookies = creds.cookies;
  }

  ka = makeClient(cookies);
}

async function relogin() {
  console.log("[agent] Session abgelaufen — erneuere Login...");
  const creds = await login({
    email:    process.env.KA_EMAIL,
    password: process.env.KA_PASSWORD,
    headless: true,
  });
  process.env.KA_COOKIES      = creds.cookies;
  process.env.KA_BEARER_TOKEN = ""; // cleared — fresh token now in cookies
  saveToEnv({ KA_COOKIES: creds.cookies, KA_BEARER_TOKEN: null });
  ka = makeClient(creds.cookies);
}

async function refreshBearer() {
  console.log("[agent] Bearer token abgelaufen — erneuere via Refresh-Token...");
  const data = await ka.refreshBearerToken();
  // Persist so next restart uses the refreshed token (cookie still has old one)
  saveToEnv({ KA_BEARER_TOKEN: data.access_token });
  process.env.KA_BEARER_TOKEN = data.access_token;
  console.log("[agent] Bearer token erneuert.");
}

// ── Hard skills — tool registry ───────────────────────────────────────────────
// Each entry: description (shown to Claude), args schema, fn (executed by bridge)
// To add a hard skill: add API method to tools/kleinanzeigen.js + register here + add/update skill doc
const TOOLS = {
  getConversations: {
    description: "Ungelesene Konversationen aus dem KA-Postfach abrufen",
    args: "{ limit?: number }",
    fn:   (a) => ka.getConversations(a),
  },
  getMessages: {
    description: "Nachrichten einer Konversation abrufen",
    args: "{ conversationId: string, limit?: number }",
    fn:   (a) => ka.getMessages(a.conversationId, a),
  },
  sendKAMessage: {
    description: "Nachricht auf Kleinanzeigen senden — NUR nach explizitem Go von Jannik",
    args: "{ conversationId: string, text: string }",
    fn:   (a) => ka.sendMessage(a.conversationId, a.text),
  },
  getMyAds: {
    description: "Eigene aktive Kleinanzeigen-Anzeigen auflisten (cookie-auth)",
    args: "{ limit?: number }",
    fn:   (a) => ka.getMyAds(a),
  },
  getAdBundles: {
    description: "Alle eigenen Anzeigen abrufen inkl. aktive und pausierte (Bearer-auth, gateway)",
    args: "{}",
    fn:   () => ka.getAdBundles(),
  },
  getDrafts: {
    description: "Eigene Anzeigen-Entwürfe abrufen (Bearer-auth, gateway)",
    args: "{}",
    fn:   () => ka.getDrafts(),
  },
  searchAds: {
    description: "Öffentliche Kleinanzeigen nach Keyword und/oder Kategorie durchsuchen — für Preisrecherche",
    args: "{ keyword: string, categoryId?: number, categorySlug?: string, page?: number, limit?: number }",
    fn: (a) => ka.searchAds(a),
  },
  // ── Foto-Verwaltung ───────────────────────────────────────────────────────
  downloadTelegramPhoto: {
    description: "Telegram-Foto anhand seiner file_id herunterladen und lokal speichern — gibt lokalen Dateipfad zurück",
    args: "{ fileId: string }",
    fn: async (a) => {
      const buffer = await tg.downloadPhoto(a.fileId);
      const localPath = saveTemp(buffer, ".jpg");
      return { path: localPath };
    },
  },
  sendTelegramPhoto: {
    description: "Lokales Bild via Telegram an Jannik senden (für Vorschau im Proposal)",
    args: "{ chatId: string, filePath: string, caption?: string }",
    fn: (a) => tg.sendPhoto(a.chatId, a.filePath, a.caption || ""),
  },
  processImages: {
    description: "Fotos via Gemini aufbereiten — minimale, ehrliche Bearbeitung (Hintergrund, Helligkeit), keine Mängel verstecken",
    args: "{ paths: string[], instructions?: string }",
    fn: (a) => processImages({ paths: a.paths, instructions: a.instructions || "" }),
  },

  // ── Anzeige erstellen / verwalten ─────────────────────────────────────────
  createAd: {
    description: "Neue Kleinanzeigen-Anzeige erstellen — NUR nach explizitem Go von Jannik",
    args: "{ title: string, description: string, categoryId: number, price: number, priceType?: string, zipCode?: string }",
    fn: (a) => ka.createAd(a),
  },
  uploadPhoto: {
    description: "Foto (lokaler Dateipfad) zu einer bestehenden KA-Anzeige hochladen",
    args: "{ adId: string, filePath: string, filename?: string }",
    fn: async (a) => {
      const buffer = require("fs").readFileSync(a.filePath);
      return ka.uploadPhoto(a.adId, buffer, a.filename || require("path").basename(a.filePath));
    },
  },
  // Hard skills to be added: deleteAd, setAdStatus

  // ── Ad-Store ──────────────────────────────────────────────────────────────
  db: {
    description: "Lokale SQLite-Anzeigendatenbank — SELECT/INSERT/UPDATE/WITH. KEIN DELETE, nur soft-delete via status='deleted'. Tabellen: ads, price_history, market_research. Preise als Cent-Integer (1€=100). Siehe Skill manage-ads für Schema.",
    args: "{ sql: string, params?: any[] }",
    fn: (a) => {
      const upper = a.sql.trimStart().toUpperCase();
      if (upper.startsWith("DELETE") || upper.startsWith("DROP") || upper.startsWith("TRUNCATE")) {
        throw new Error("DELETE/DROP/TRUNCATE not allowed — use status='deleted' for soft-delete");
      }
      return dbQuery({ sql: a.sql, params: a.params });
    },
  },

  // ── Memory ────────────────────────────────────────────────────────────────
  memoryWrite: {
    description: "Erkenntnis oder Fakt dauerhaft speichern (überschreibt vorhandene Datei mit gleichem key). key = kurzer Dateiname ohne Endung, z.B. 'buyer-prefs' oder 'price-insights'.",
    args: "{ key: string, content: string }",
    fn: (a) => {
      const dir = path.join(__dirname, "memory");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, `${a.key}.md`), a.content, "utf8");
      return { ok: true, key: a.key };
    },
  },
  memoryRead: {
    description: "Memory-Datei(en) lesen. Ohne key: alle Memory-Dateien auflisten. Mit key: Inhalt einer bestimmten Datei zurückgeben.",
    args: "{ key?: string }",
    fn: (a) => {
      const dir = path.join(__dirname, "memory");
      if (!fs.existsSync(dir)) return { files: [] };
      if (!a.key) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
        return { files };
      }
      const file = path.join(dir, `${a.key}.md`);
      if (!fs.existsSync(file)) return { error: `Memory '${a.key}' nicht gefunden` };
      return { key: a.key, content: fs.readFileSync(file, "utf8") };
    },
  },
  memoryDelete: {
    description: "Memory-Eintrag löschen. Nur verwenden wenn eine Erkenntnis veraltet oder falsch ist.",
    args: "{ key: string }",
    fn: (a) => {
      const file = path.join(__dirname, "memory", `${a.key}.md`);
      if (!fs.existsSync(file)) return { error: `Memory '${a.key}' nicht gefunden` };
      fs.unlinkSync(file);
      return { ok: true, deleted: a.key };
    },
  },
};

function toolManifest() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}(${t.args}): ${t.description}`)
    .join("\n");
}

// ── Claude ────────────────────────────────────────────────────────────────────
function findClaude() {
  for (const c of ["claude"]) {
    try { execSync(`"${c}" --version`, { stdio: "pipe" }); return c; } catch (_) {}
  }
  return null;
}

const CLAUDE_BIN = findClaude();
if (!CLAUDE_BIN) { console.error("[agent] claude CLI nicht gefunden."); process.exit(1); }

function callClaude(prompt) {
  const r = spawnSync(CLAUDE_BIN, ["-p", prompt, "--model", "claude-sonnet-4-6"],
    { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(r.error.message);
  const raw = (r.stdout || "").trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  try { return JSON.parse(raw); } catch { return { message: raw }; }
}

// ── Context: agent identity + skill docs + tool manifest ─────────────────────
function loadContext() {
  const agentMd   = fs.readFileSync(path.join(__dirname, "agent.md"), "utf8");
  const skillsDir = path.join(__dirname, "skills");
  const skills    = fs.readdirSync(skillsDir)
    .filter(f => f.endsWith(".md"))
    .map(f => fs.readFileSync(path.join(skillsDir, f), "utf8"))
    .join("\n\n---\n\n");

  const memoryDir = path.join(__dirname, "memory");
  let memory = "";
  const MEMORY_CONTEXT_LIMIT = 8000;
  if (fs.existsSync(memoryDir)) {
    const entries = fs.readdirSync(memoryDir).filter(f => f.endsWith(".md"));
    if (entries.length) {
      const full = entries.map(f => {
        const key = f.replace(".md", "");
        const content = fs.readFileSync(path.join(memoryDir, f), "utf8");
        return `### ${key}\n${content}`;
      }).join("\n\n");
      if (full.length <= MEMORY_CONTEXT_LIMIT) {
        memory = "\n\n## Dein Gedächtnis (Memory)\n\n" + full;
      } else {
        // Too large — only show keys, agent can use memoryRead to fetch specific entries
        const keys = entries.map(f => f.replace(".md", "")).join(", ");
        memory = `\n\n## Dein Gedächtnis (Memory)\n\nZu viele Einträge für den Context. Verfügbare Keys: ${keys}\nNutze memoryRead({ key }) um einzelne Einträge abzurufen.`;
      }
    }
  }

  return (
    `${agentMd}\n\n` +
    `## Verfügbare Tools (Hard Skills)\n${toolManifest()}\n\n` +
    `## Skill-Dokumentation (Soft Skills)\n\n${skills}` +
    memory
  );
}

// ── Session: conversation history per chatId (persisted to disk) ──────────────
const SESSION_FILE = path.join(__dirname, "../.sessions.json");
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch (_) {}

function getHistory(chatId) {
  if (!sessions[chatId]) sessions[chatId] = [];
  return sessions[chatId];
}

function saveSession(chatId) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions)); } catch (_) {}
}

// ── Agentic loop: message → Claude → optional tool → Claude → reply ───────────
async function runAgent(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push(`Jannik: ${userMessage}`);

  const context = loadContext();

  for (let i = 0; i < 10; i++) {
    const prompt =
      `${context}\n\n` +
      `## Session\nJannik's Telegram Chat-ID: ${chatId}\n\n` +
      `## Konversation\n${history.join("\n")}\n\n` +
      `Antworte ausschließlich als JSON:\n` +
      `Mit Tool-Aufruf: {"message":"...","action":{"tool":"TOOLNAME","args":{...}}}\n` +
      `Ohne Tool-Aufruf: {"message":"..."}\n` +
      `message ist was Jannik sieht (darf leer sein wenn du nur ein Tool aufrufst).`;

    console.log(`[claude →] thinking... (step ${i + 1})`);
    const response = callClaude(prompt);

    if (response.action) {
      const tool = TOOLS[response.action.tool];
      if (!tool) {
        console.warn(`[tool ✗] unknown tool: ${response.action.tool}`);
        history.push(`System: Unbekanntes Tool "${response.action.tool}"`);
        break;
      }
      console.log(`[tool →] ${response.action.tool}(${JSON.stringify(response.action.args || {})})`);
      if (response.message) {
        console.log(`[claude interim] ${response.message}`); // not sent to Telegram
      }
      try {
        let result;
        try {
          result = await tool.fn(response.action.args || {});
        } catch (e) {
          if (e.message.includes("Session abgelaufen")) {
            await relogin();
            result = await tool.fn(response.action.args || {}); // retry once
          } else if (e.message.includes("Bearer token abgelaufen")) {
            await refreshBearer();
            result = await tool.fn(response.action.args || {}); // retry once
          } else {
            throw e;
          }
        }
        const resultStr = JSON.stringify(result);
        console.log(`[tool ←] ${response.action.tool}: ${resultStr.slice(0, 200)}${resultStr.length > 200 ? "…" : ""}`);
        history.push(`Tool(${response.action.tool}): ${resultStr}`);
      } catch (e) {
        console.error(`[tool ✗] ${response.action.tool}: ${e.message}`);
        history.push(`Tool(${response.action.tool}) Fehler: ${e.message}`);
      }
      continue;
    }

    if (response.message) {
      console.log(`[tg →] ${response.message}`);
      await tg.send(chatId, response.message);
      history.push(`Agent: ${response.message}`);
    }
    break;
  }

  // Keep history bounded
  if (history.length > 40) sessions[chatId] = history.slice(-40);
  saveSession(chatId);
}

// ── Timing ────────────────────────────────────────────────────────────────────
function randomPollIntervalMs() {
  return Math.floor(3 * 60 * 60 * 1000 + Math.random() * 3 * 60 * 60 * 1000);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("[agent] nemoclaw-kleinanzeigen gestartet");
  await ensureLogin();

  let defaultChatId = null;

  async function tick() {
    const updates = await tg.getUpdates();
    for (const u of updates) {
      const msg = u.message;
      if (!msg?.chat?.id) continue;

      if (!defaultChatId) {
        defaultChatId = msg.chat.id;
        console.log(`[agent] Chat-ID: ${defaultChatId}`);
        await tg.send(defaultChatId, "Kleinanzeigen-Manager bereit. Schreib mir einfach was du brauchst.");
      }

      if (msg.text) {
        console.log(`[tg ←] ${msg.text}`);
        await runAgent(msg.chat.id, msg.text);
      } else if (msg.photo) {
        // Telegram sends one message per photo in an album, each with all resolutions.
        // Pick the highest resolution (last in array).
        const best = msg.photo[msg.photo.length - 1];
        const caption = msg.caption ? ` ${msg.caption}` : "";
        console.log(`[tg ←] [FOTO]${caption}`);
        // Pass the file_id as a structured token so Claude can call downloadTelegramPhoto.
        await runAgent(msg.chat.id, `[FOTO file_id:${best.file_id}]${caption}`);
      }
    }
  }

  async function safeTick() {
    try { await tick(); } catch (e) { console.error("[agent] Fehler:", e.message); }
  }

  await safeTick();
  setInterval(safeTick, 5000);

  // Inbox heartbeat every 3–6h
  function scheduleHeartbeat() {
    const delay = randomPollIntervalMs();
    console.log(`[agent] Nächster Inbox-Check in ${(delay / 3600000).toFixed(1)}h`);
    setTimeout(async () => {
      if (defaultChatId) await runAgent(defaultChatId, "Prüfe das Postfach auf neue Nachrichten.");
      scheduleHeartbeat();
    }, delay);
  }
  scheduleHeartbeat();
})();
