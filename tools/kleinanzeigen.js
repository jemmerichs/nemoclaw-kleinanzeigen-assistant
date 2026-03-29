/**
 * Kleinanzeigen API-Client
 * Nutzt gespeicherte Session-Cookies — kein Browser nötig.
 */

"use strict";

const https = require("https");

const BASE = "https://api.kleinanzeigen.de/api";

class KleinanzeigenClient {
  constructor(cookieString) {
    if (!cookieString) throw new Error("KA_COOKIES fehlt. Bitte 'node scripts/login.js' ausführen.");
    this.cookies = cookieString;
    // User-ID aus dem cookie-String extrahieren (falls vorhanden)
    const m = cookieString.match(/user_id=(\d+)/);
    this.userId = m ? m[1] : null;
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const options = {
        hostname: "api.kleinanzeigen.de",
        path:     `/api${path}`,
        method,
        headers: {
          "Accept":        "application/json",
          "Content-Type":  "application/json",
          "Cookie":        this.cookies,
          "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Referer":       "https://www.kleinanzeigen.de/",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      };

      const req = https.request(options, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`Session abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' erneut ausführen.`));
          }
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      });

      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ── Postfach ──────────────────────────────────────────────────────────────

  /** Konversationsliste abrufen */
  async getConversations({ limit = 20, offset = 0 } = {}) {
    const { body } = await this._request("GET", `/users/${this.userId}/conversations?limit=${limit}&offset=${offset}`);
    return (body.conversations || body._embedded?.conversations || []).map(c => ({
      id:          c.id,
      adId:        c.adId || c.ad?.id,
      adTitle:     c.adTitle || c.ad?.title || "",
      otherParty:  c.interlocutorSummary?.userProfile?.displayName || c.buyerName || "",
      lastMessage: c.latestMessage?.text || "",
      unread:      c.unreadMessageCount > 0,
      updatedAt:   c.latestMessage?.sentAt || c.modificationDate,
    }));
  }

  /** Nachrichten einer Konversation abrufen */
  async getMessages(conversationId, { limit = 20 } = {}) {
    const { body } = await this._request("GET", `/users/${this.userId}/conversations/${conversationId}/messages?limit=${limit}`);
    return (body.messages || body._embedded?.messages || []).map(m => ({
      id:     m.id,
      text:   m.text || "",
      sentAt: m.sentAt,
      isMe:   m.senderUserId === this.userId,
    }));
  }

  /** Nachricht senden (nur nach explizitem "Go") */
  async sendMessage(conversationId, text) {
    const { status, body } = await this._request(
      "POST",
      `/users/${this.userId}/conversations/${conversationId}/messages`,
      { text }
    );
    if (status !== 200 && status !== 201) {
      throw new Error(`sendMessage fehlgeschlagen (${status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  // ── Anzeigen ──────────────────────────────────────────────────────────────

  /** Eigene Anzeigen abrufen */
  async getMyAds({ limit = 20, offset = 0 } = {}) {
    const { body } = await this._request("GET", `/users/${this.userId}/ads?limit=${limit}&offset=${offset}`);
    return (body.ads || body._embedded?.ads || []).map(a => ({
      id:       a.id,
      title:    a.title,
      price:    a.priceAmount,
      status:   a.adStatus,
      views:    a.pageViewCount,
      category: a.categoryTreePath || "",
    }));
  }

  // ── Session-Check ─────────────────────────────────────────────────────────

  async checkSession() {
    try {
      await this.getConversations({ limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = KleinanzeigenClient;
