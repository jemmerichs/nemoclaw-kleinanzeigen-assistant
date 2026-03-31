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
  // ── Kleinanzeigen ─────────────────────────────────────────────────────────
  ka_get_conversations: {
    description: "Ungelesene Konversationen aus dem KA-Postfach abrufen",
    args: "{ limit?: number }",
    fn:   (a) => ka.getConversations(a),
  },
  ka_get_messages: {
    description: "Nachrichten einer Konversation abrufen",
    args: "{ conversationId: string, limit?: number }",
    fn:   (a) => ka.getMessages(a.conversationId, a),
  },
  ka_send_message: {
    description: "Nachricht auf Kleinanzeigen senden — NUR nach explizitem Go von Jannik",
    args: "{ conversationId: string, text: string }",
    fn:   (a) => ka.sendMessage(a.conversationId, a.text),
  },
  ka_get_my_ads: {
    description: "Eigene aktive Anzeigen auflisten (cookie-auth)",
    args: "{ limit?: number }",
    fn:   (a) => ka.getMyAds(a),
  },
  ka_get_ad_bundles: {
    description: "Alle eigenen Anzeigen inkl. pausierte abrufen (Bearer-auth)",
    args: "{}",
    fn:   () => ka.getAdBundles(),
  },
  ka_get_drafts: {
    description: "Eigene Anzeigen-Entwürfe abrufen (Bearer-auth)",
    args: "{}",
    fn:   () => ka.getDrafts(),
  },
  ka_search_ads: {
    description: "Öffentliche Anzeigen nach Keyword/Kategorie durchsuchen — für Preisrecherche",
    args: "{ keyword: string, categoryId?: number, categorySlug?: string, page?: number, limit?: number }",
    fn:   (a) => ka.searchAds(a),
  },
  ka_create_ad: {
    description: "Neue Anzeige erstellen — NUR nach explizitem Go von Jannik",
    args: "{ title: string, description: string, categoryId: number, price: number, priceType?: string, zipCode?: string }",
    fn:   (a) => ka.createAd(a),
  },
  ka_upload_photo: {
    description: "Foto (lokaler Dateipfad) zu einer bestehenden KA-Anzeige hochladen",
    args: "{ adId: string, filePath: string, filename?: string }",
    fn:   async (a) => {
      const buffer = fs.readFileSync(a.filePath);
      return ka.uploadPhoto(a.adId, buffer, a.filename || path.basename(a.filePath));
    },
  },

  // ── Foto-Aufbereitung ─────────────────────────────────────────────────────
  processImages: {
    description: "Fotos via Gemini aufbereiten — minimale, ehrliche Bearbeitung (Hintergrund, Helligkeit), keine Mängel verstecken",
    args: "{ paths: string[], instructions?: string }",
    fn:   (a) => processImages({ paths: a.paths, instructions: a.instructions || "" }),
  },

  // ── Datenbank ─────────────────────────────────────────────────────────────
  db_query: {
    description: "SQL auf der lokalen Asset-Datenbank ausführen. Tabellen: assets, ka_listings. SELECT/INSERT/UPDATE erlaubt.",
    args: "{ sql: string, params?: any[] }",
    fn: (a) => dbQuery({ sql: a.sql, params: a.params || [] }),
  },

  // ── Skill-Verwaltung ──────────────────────────────────────────────────────
  updateSkillFile: {
    description: "Skill-Datei in workspace/skills/ schreiben — NUR nach explizitem Go von Jannik. Immer zuerst den geplanten Inhalt zeigen und warten.",
    args: "{ filename: string, content: string }",
    fn: (a) => {
      const allowed = path.resolve(__dirname, "skills");
      const target  = path.resolve(allowed, path.basename(a.filename));
      if (!target.startsWith(allowed + path.sep)) throw new Error("Ungültiger Dateipfad");
      if (!target.endsWith(".md")) throw new Error("Nur .md-Dateien erlaubt");
      fs.writeFileSync(target, a.content, "utf8");
      return { written: path.basename(target) };
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
    { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
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
  return (
    `${agentMd}\n\n` +
    `## Verfügbare Tools (Hard Skills)\n${toolManifest()}\n\n` +
    `## Skill-Dokumentation (Soft Skills)\n\n${skills}`
  );
}

// ── Session: conversation history per chatId ──────────────────────────────────
const sessions = {};
function getHistory(chatId) {
  if (!sessions[chatId]) sessions[chatId] = [];
  return sessions[chatId];
}

// ── Agentic loop: message → Claude → optional tool → Claude → reply ───────────
async function runAgent(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push(`Jannik: ${userMessage}`);

  const context = loadContext();

  for (let i = 0; i < 5; i++) {
    const prompt =
      `${context}\n\n` +
      `## Konversation\n${history.join("\n")}\n\n` +
      `Antworte ausschließlich als JSON:\n` +
      `Mit Tool-Aufruf: {"message":"...","action":{"tool":"TOOLNAME","args":{...}}}\n` +
      `Mit Foto-Antwort: {"message":"...","photo":"/lokaler/pfad.jpg"}\n` +
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
        console.log(`[tg →] ${response.message}`);
        await tg.send(chatId, response.message);
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

    if (response.photo) {
      console.log(`[tg →] [FOTO] ${response.photo}`);
      await tg.sendPhoto(chatId, response.photo, response.message || "");
      history.push(`Agent: [Foto gesendet: ${response.photo}]${response.message ? " " + response.message : ""}`);
    } else if (response.message) {
      console.log(`[tg →] ${response.message}`);
      await tg.send(chatId, response.message);
      history.push(`Agent: ${response.message}`);
    }
    break;
  }

  // Keep history bounded
  if (history.length > 40) sessions[chatId] = history.slice(-40);
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
        // Pick highest resolution, auto-download to local disk.
        const best = msg.photo[msg.photo.length - 1];
        const caption = msg.caption ? ` ${msg.caption}` : "";
        const buffer = await tg.downloadPhoto(best.file_id);
        const localPath = saveTemp(buffer, ".jpg");
        console.log(`[tg ←] [FOTO → ${localPath}]${caption}`);
        await runAgent(msg.chat.id, `[FOTO path:${localPath}]${caption}`);
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
