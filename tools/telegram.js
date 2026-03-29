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
}

module.exports = TelegramGateway;
