"use strict";

const https = require("https");

class TelegramGateway {
  constructor(token) {
    this.token = token;
    this.lastUpdateId = 0;
  }

  _request(method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const opts = {
        hostname: "api.telegram.org",
        path:     `/bot${this.token}/${method}`,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };
      const req = https.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  async send(chatId, text) {
    await this._request("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
  }

  async getUpdates() {
    const res = await this._request("getUpdates", { offset: this.lastUpdateId + 1, timeout: 10 });
    const updates = res.result || [];
    for (const u of updates) this.lastUpdateId = Math.max(this.lastUpdateId, u.update_id);
    return updates;
  }

  /** Resolve a file_id to a download URL, then download the raw bytes. */
  async downloadPhoto(fileId) {
    const res = await this._request("getFile", { file_id: fileId });
    if (!res.ok || !res.result?.file_path) {
      throw new Error(`Telegram getFile fehlgeschlagen: ${JSON.stringify(res)}`);
    }
    const filePath = res.result.file_path;
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    return this._download(url);
  }

  /** Download raw bytes from a full URL (used internally). Returns Buffer. */
  _download(url) {
    return new Promise((resolve, reject) => {
      const proto = url.startsWith("https") ? require("https") : require("http");
      proto.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(this._download(res.headers.location));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    });
  }

  /**
   * Send a photo from a local file path to a Telegram chat.
   * @param {string} chatId
   * @param {string} filePath  absolute local path to the image
   * @param {string} [caption]
   */
  async sendPhoto(chatId, filePath, caption = "") {
    const fs = require("fs");
    const path = require("path");
    const https = require("https");

    const fileBuffer = fs.readFileSync(filePath);
    const filename   = path.basename(filePath);
    const boundary   = "----TGBoundary" + Math.random().toString(36).slice(2);

    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
    ));
    if (caption) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`
      ));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "api.telegram.org",
        path:     `/bot${this.token}/sendPhoto`,
        method:   "POST",
        headers:  {
          "Content-Type":   `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      };
      const req = https.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = TelegramGateway;
