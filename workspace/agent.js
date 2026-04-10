#!/usr/bin/env node
"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs   = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");
const TelegramGateway      = require("../tools/telegram");
const KleinanzeigenClient  = require("../tools/kleinanzeigen");
const { saveToEnv } = require("../tools/auth");
const { saveTemp, processImages } = require("../tools/image");
const { query: dbQuery }          = require("../tools/adstore");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!TOKEN) { console.error("[agent] TELEGRAM_BOT_TOKEN fehlt."); process.exit(1); }

const tg = new TelegramGateway(TOKEN);
let ka;  // initialised after login

function makeClient(cookies) {
  return new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
}

async function ensureLogin() {
  const cookies = process.env.KA_COOKIES || "";
  if (!cookies) {
    console.error("[agent] KA_COOKIES fehlt — bitte 'node scripts/login.js' ausführen.");
    process.exit(1);
  }
  ka = makeClient(cookies);
}

async function relogin() {
  require("dotenv").config({ path: require("path").resolve(__dirname, "../.env"), override: true });
  const cookies = process.env.KA_COOKIES || "";
  if (!cookies) throw new Error("KA_COOKIES fehlt — bitte 'node scripts/login.js' ausführen.");
  ka = makeClient(cookies);
  console.log("[agent] Cookies neu geladen aus .env");
}

async function refreshCsrf() {
  const newToken = await ka.refreshCsrfToken();
  saveToEnv({ KA_COOKIES: ka.cookies });
  process.env.KA_COOKIES = ka.cookies;
  console.log(`[agent] CSRF erneuert (${newToken.slice(0, 8)}…)`);
}

async function refreshBearer() {
  const data = await ka.refreshBearerToken();
  let cookies = process.env.KA_COOKIES || "";
  cookies = cookies.replace(/(^|; )access_token=[^;]+/, `$1access_token=${data.access_token}`);
  if (data.refresh_token) cookies = cookies.replace(/(^|; )refresh_token=[^;]+/, `$1refresh_token=${data.refresh_token}`);
  process.env.KA_COOKIES = cookies;
  saveToEnv({ KA_COOKIES: cookies, KA_BEARER_TOKEN: null });
  ka = makeClient(cookies);
  console.log("[agent] Bearer erneuert.");
}

const TOOLS = {
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
  ka_save_draft: {
    description: "Anzeigen-Entwurf auf KA speichern (kein Go nötig — wird NICHT veröffentlicht). Gibt draftId zurück.",
    args: "{ title?: string, description?: string, categoryId?: number, priceAmount?: number, priceType?: string, zipCode?: string, locationId?: string, imageUrls?: string[], attributes?: Record<string,string> }",
    fn:   (a) => ka.saveDraft(a),
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
  ka_upload_image: {
    description: "Bild vor der Anzeigenerstellung hochladen — gibt imageId und imageUrl zurück (imageUrl für ka_create_ad)",
    args: "{ filePath: string, filename?: string, mimeType?: string }",
    fn:   async (a) => {
      const buffer = fs.readFileSync(a.filePath);
      const mime   = a.mimeType || { png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" }[a.filePath.match(/\.(\w+)$/i)?.[1]?.toLowerCase()] || "image/jpeg";
      return ka.uploadImage(buffer, a.filename || path.basename(a.filePath), mime);
    },
  },
  ka_create_ad: {
    description: "Neue Anzeige erstellen — NUR nach explizitem Go von Jannik",
    args: "{ title: string, description: string, categoryId: number, price: number, priceType?: string, zipCode?: string, locationId?: string, contactName?: string, imageUrls?: string[], attributes?: Record<string,string> }",
    fn:   (a) => ka.createAd(a),
  },

  processImages: {
    description: "Fotos via Gemini aufbereiten — minimale, ehrliche Bearbeitung (Hintergrund, Helligkeit), keine Mängel verstecken",
    args: "{ paths: string[], instructions?: string }",
    fn:   (a) => processImages({ paths: a.paths, instructions: a.instructions || "" }),
  },

  db_query: {
    description: "SQL auf der lokalen Asset-Datenbank ausführen. Tabellen: assets, ka_listings, ka_snapshots (Preis+Views-Verlauf). SELECT/INSERT/UPDATE erlaubt.",
    args: "{ sql: string, params?: any[] }",
    fn: (a) => dbQuery({ sql: a.sql, params: a.params || [] }),
  },
  saveImages: {
    description: "Bildpfade zu einem Asset speichern (append). Liest bestehende image_paths, merged, schreibt zurück. Kein JSON.stringify nötig.",
    args: "{ assetId: number, paths: string[] }",
    fn: (a) => {
      const rows    = dbQuery({ sql: "SELECT image_paths FROM assets WHERE id=?", params: [a.assetId] });
      if (!rows.length) throw new Error(`Asset ${a.assetId} nicht gefunden`);
      const existing = rows[0].image_paths ? JSON.parse(rows[0].image_paths) : [];
      const merged   = [...new Set([...existing, ...a.paths])];
      dbQuery({ sql: "UPDATE assets SET image_paths=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
                params: [JSON.stringify(merged), a.assetId] });
      return { assetId: a.assetId, imageCount: merged.length, paths: merged };
    },
  },

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

function findClaude() {
  try { execSync('"claude" --version', { stdio: "pipe" }); return "claude"; } catch (_) { return null; }
}

const CLAUDE_BIN = findClaude();
if (!CLAUDE_BIN) { console.error("[agent] claude CLI nicht gefunden."); process.exit(1); }

function callClaude(systemPrompt, userPrompt) {
  const r = spawnSync(
    CLAUDE_BIN,
    ["-p", userPrompt, "--model", "claude-sonnet-4-6", "--system-prompt", systemPrompt, "--tools", ""],
    { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp" }
  );
  if (r.error) throw new Error(r.error.message);
  const raw = (r.stdout || "").trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  try { return JSON.parse(raw); } catch { return { message: raw }; }
}

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

async function runAgent(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push(`Jannik: ${userMessage}`);

  const systemPrompt = loadContext();

  for (let i = 0; i < 10; i++) {
    const userPrompt =
      `## Session\nJannik's Telegram Chat-ID: ${chatId}\n\n` +
      `## Konversation\n${history.join("\n")}\n\n` +
      `Antworte ausschließlich als JSON:\n` +
      `Mit Tool-Aufruf: {"message":"...","action":{"tool":"TOOLNAME","args":{...}}}\n` +
      `Mit Foto-Antwort: {"message":"...","photo":"/lokaler/pfad.jpg"}\n` +
      `Ohne Tool-Aufruf: {"message":"..."}\n` +
      `message ist was Jannik sieht (darf leer sein wenn du nur ein Tool aufrufst).`;

    console.log(`[claude →] thinking... (step ${i + 1})`);
    const response = callClaude(systemPrompt, userPrompt);

    if (response.action) {
      const tool = TOOLS[response.action.tool];
      if (!tool) {
        console.warn(`[tool ✗] unknown tool: ${response.action.tool}`);
        history.push(`System: Unbekanntes Tool "${response.action.tool}"`);
        break;
      }
      console.log(`[tool →] ${response.action.tool}(${JSON.stringify(response.action.args || {})})`);
      if (response.message) {
        console.log(`[claude interim] ${response.message}`);
      }
      try {
        let result;
        try {
          result = await tool.fn(response.action.args || {});
        } catch (e) {
          if (e.message.includes("CSRF abgelaufen")) {
            await refreshCsrf();
            result = await tool.fn(response.action.args || {});
          } else if (e.message.includes("Bearer token abgelaufen")) {
            await refreshBearer();
            result = await tool.fn(response.action.args || {});
          } else if (e.message.includes("Session abgelaufen")) {
            await relogin();
            result = await tool.fn(response.action.args || {});
          } else {
            throw e;
          }
        }
        const resultStr = JSON.stringify(result);
        console.log(`[tool ←] ${response.action.tool}: ${resultStr.slice(0, 200)}${resultStr.length > 200 ? "…" : ""}`);
        history.push(`Tool(${response.action.tool}): ${resultStr}`);
      } catch (e) {
        console.error(`[tool ✗] ${response.action.tool}: ${e.message}`);
        history.push(`System: Tool "${response.action.tool}" fehlgeschlagen — ${e.message}. Erneut versuchen oder Jannik informieren.`);
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

  if (history.length > 40) sessions[chatId] = history.slice(-40);
  saveSession(chatId);
}

function randomPollIntervalMs() {
  return Math.floor(3 * 60 * 60 * 1000 + Math.random() * 3 * 60 * 60 * 1000);
}

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
