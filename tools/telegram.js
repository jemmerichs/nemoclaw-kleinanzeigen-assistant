"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const MAX_MESSAGE_LENGTH = 4000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function telegramPlainText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/^```[^\n]*$/gm, "")
    .replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_match, title) => (
      /[:.!?]$/.test(title) ? title : `${title}:`
    ))
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMessage(text, maxLength = MAX_MESSAGE_LENGTH) {
  const input = String(text || "");
  if (!input) return [];

  const chunks = [];
  let remaining = input;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < 1) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function mimeTypeFor(filePath) {
  return {
    ".gif": "image/gif",
    ".png": "image/png",
    ".webp": "image/webp",
  }[path.extname(filePath).toLowerCase()] || "image/jpeg";
}

class TelegramGateway {
  constructor(token, { lastUpdateId = 0 } = {}) {
    if (!token) throw new Error("Telegram bot token fehlt.");
    this.token = token;
    this.lastUpdateId = Number(lastUpdateId) || 0;
  }

  _request(method, body, socketTimeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const opts = {
        hostname: "api.telegram.org",
        path: `/bot${this.token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };
      const req = https.request(opts, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 2 * 1024 * 1024) req.destroy(new Error(`Telegram ${method}: Antwort zu groß`));
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            return reject(new Error(`Telegram ${method}: ungültige JSON-Antwort (${res.statusCode})`));
          }
          if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.ok) {
            const detail = parsed.description || raw.slice(0, 300) || "unbekannter Fehler";
            return reject(new Error(`Telegram ${method} fehlgeschlagen (${res.statusCode}): ${detail}`));
          }
          resolve(parsed.result);
        });
      });
      req.setTimeout(socketTimeoutMs, () => req.destroy(new Error(`Telegram ${method}: Timeout`)));
      req.on("error", reject);
      req.end(data);
    });
  }

  async send(chatId, text) {
    const results = [];
    for (const chunk of splitMessage(telegramPlainText(text))) {
      results.push(await this._request("sendMessage", { chat_id: chatId, text: chunk }));
    }
    return results;
  }

  async getUpdates({ timeoutSeconds = 25 } = {}) {
    const timeout = Math.max(0, Math.min(50, Number(timeoutSeconds) || 0));
    const updates = await this._request(
      "getUpdates",
      { offset: this.lastUpdateId + 1, timeout, allowed_updates: ["message"] },
      (timeout + 10) * 1000
    );
    for (const update of updates || []) {
      this.lastUpdateId = Math.max(this.lastUpdateId, Number(update.update_id) || 0);
    }
    return updates || [];
  }

  async downloadPhoto(fileId) {
    const file = await this._request("getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("Telegram getFile lieferte keinen Dateipfad.");
    return this._download(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
  }

  _download(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;
      const req = transport.get(parsedUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft < 1) return reject(new Error("Telegram Foto-Download: zu viele Weiterleitungen"));
          return resolve(this._download(new URL(res.headers.location, parsedUrl).toString(), redirectsLeft - 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`Telegram Foto-Download fehlgeschlagen (${res.statusCode})`));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_DOWNLOAD_BYTES) req.destroy(new Error("Telegram Foto ist größer als 20 MB"));
          else chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(30000, () => req.destroy(new Error("Telegram Foto-Download: Timeout")));
      req.on("error", reject);
    });
  }

  async sendPhoto(chatId, filePath, caption = "") {
    const fileBuffer = fs.readFileSync(filePath);
    if (fileBuffer.length > MAX_DOWNLOAD_BYTES) throw new Error("Telegram Foto ist größer als 20 MB");
    const filename = path.basename(filePath).replace(/["\r\n]/g, "_");
    const boundary = "----TGBoundary" + Math.random().toString(36).slice(2);
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    ];
    if (caption) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption).slice(0, 1024)}\r\n`
      ));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeTypeFor(filePath)}\r\n\r\n`
    ));
    parts.push(fileBuffer, Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.telegram.org",
        path: `/bot${this.token}/sendPhoto`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : {}; }
          catch { return reject(new Error(`Telegram sendPhoto: ungültige JSON-Antwort (${res.statusCode})`)); }
          if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.ok) {
            return reject(new Error(`Telegram sendPhoto fehlgeschlagen (${res.statusCode}): ${parsed.description || raw.slice(0, 300)}`));
          }
          resolve(parsed.result);
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error("Telegram sendPhoto: Timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }
}

module.exports = TelegramGateway;
module.exports.splitMessage = splitMessage;
module.exports.mimeTypeFor = mimeTypeFor;
module.exports.telegramPlainText = telegramPlainText;
