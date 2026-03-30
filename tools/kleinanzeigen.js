/**
 * Kleinanzeigen API client
 *
 * Three hostnames, two auth mechanisms:
 *
 *   api.kleinanzeigen.de     cookie auth   getConversations, getMessages, sendMessage, getMyAds
 *   www.kleinanzeigen.de     cookie auth   getDrafts  (access_token cookie doubles as bearer)
 *   gateway.kleinanzeigen.de Bearer JWT    getAdBundles
 *
 * Tokens are stored as cookies by the browser, so Playwright captures them automatically.
 * bearerToken / refreshToken are extracted from the cookie string if not passed explicitly.
 */

"use strict";

const https = require("https");

const KA_AUTH0_CLIENT_ID = "aOq74Cm5fUBoM1JifHTHhlZ2JHXlVUCq";

class KleinanzeigenClient {
  /**
   * @param {string}      cookieString  KA_COOKIES — written by tools/auth.js
   * @param {string|null} bearerToken   optional override; extracted from cookies if omitted
   * @param {string|null} refreshToken  optional override; extracted from cookies if omitted
   */
  constructor(cookieString, bearerToken = null, refreshToken = null) {
    if (!cookieString) throw new Error("KA_COOKIES fehlt. Bitte 'node scripts/login.js' ausführen.");
    this.cookies = cookieString;

    // Tokens live in cookies — extract them so gateway requests work without extra env vars
    const at = cookieString.match(/(?:^|;\s*)access_token=([^;]+)/);
    const rt = cookieString.match(/(?:^|;\s*)refresh_token=([^;]+)/);
    this.bearerToken  = bearerToken  || (at ? at[1].trim() : null);
    this.refreshToken = refreshToken || (rt ? rt[1].trim() : null);

    // Extract user ID — prefer cookie, fall back to JWT payload
    const uid = cookieString.match(/(?:^|;\s*)user_id=(\d+)/);
    if (uid) {
      this.userId = uid[1];
    } else if (this.bearerToken) {
      try {
        const payload = JSON.parse(Buffer.from(this.bearerToken.split('.')[1], 'base64').toString());
        this.userId = String(payload['https://www.kleinanzeigen.de/user_id'] || '');
      } catch { this.userId = null; }
    } else {
      this.userId = null;
    }
  }

  // ── Internal: shared cookie-auth request ──────────────────────────────────

  _cookieRequest(hostname, path, method, body = null) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const options = {
        hostname,
        path,
        method,
        headers: {
          "Accept":        "application/json",
          "Content-Type":  "application/json",
          "Cookie":        this.cookies,
          "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
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

  _request(method, path, body = null) {
    return this._cookieRequest("api.kleinanzeigen.de", `/api${path}`, method, body);
  }

  _wwwRequest(method, path, body = null) {
    return this._cookieRequest("www.kleinanzeigen.de", path, method, body);
  }

  // ── Internal: Bearer-auth request (gateway) ───────────────────────────────

  _gatewayRequest(method, path, body = null) {
    if (!this.bearerToken) throw new Error("Bearer token fehlt. Bitte 'node scripts/login.js' ausführen.");
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const options = {
        hostname: "gateway.kleinanzeigen.de",
        path,
        method,
        headers: {
          "Accept":        "application/json, text/plain, */*",
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${this.bearerToken}`,
          "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          "Origin":        "https://www.kleinanzeigen.de",
          "Referer":       "https://www.kleinanzeigen.de/",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      };

      const req = https.request(options, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`Bearer token abgelaufen (${res.statusCode}).`));
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

  // ── Token refresh ─────────────────────────────────────────────────────────

  /**
   * Exchange the stored refresh token for a new Bearer token.
   * Updates this.bearerToken in place. Caller should persist to .env.
   */
  refreshBearerToken() {
    if (!this.refreshToken) throw new Error("Refresh token fehlt. Bitte 'node scripts/login.js' ausführen.");
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}&client_id=${KA_AUTH0_CLIENT_ID}`;
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "login.kleinanzeigen.de",
        path:     "/oauth/token",
        method:   "POST",
        headers: {
          "Content-Type":   "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (!data.access_token) return reject(new Error(`Token-Refresh fehlgeschlagen: ${raw}`));
            this.bearerToken = data.access_token;
            if (data.refresh_token) this.refreshToken = data.refresh_token;
            resolve(data);
          } catch {
            reject(new Error(`Token-Refresh Parse-Fehler: ${raw}`));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────

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

  async getMessages(conversationId, { limit = 20 } = {}) {
    const { body } = await this._request("GET", `/users/${this.userId}/conversations/${conversationId}/messages?limit=${limit}`);
    return (body.messages || body._embedded?.messages || []).map(m => ({
      id:     m.id,
      text:   m.text || "",
      sentAt: m.sentAt,
      isMe:   m.senderUserId === this.userId,
    }));
  }

  /** Only after explicit "Go" from Jannik */
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

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search public listings by keyword and/or category.
   * Uses the www JSON endpoint (no auth required, but cookies help with personalisation).
   *
   * URL pattern: /s-{categorySlug}/seite:{page}/{keyword}/k0c{categoryId}
   * Falls back to /s-anzeigen/{keyword}/k0 when no category given.
   *
   * @param {object} opts
   * @param {string}  opts.keyword
   * @param {number}  [opts.categoryId]   e.g. 217 = Fahrräder
   * @param {string}  [opts.categorySlug] e.g. "fahrraeder" (used in URL, defaults to "anzeigen")
   * @param {number}  [opts.page=1]
   * @param {number}  [opts.limit=20]     max items to return from the page
   */
  async searchAds({ keyword, categoryId, categorySlug = "anzeigen", page = 1, limit = 20 } = {}) {
    const pageSegment = page > 1 ? `/seite:${page}` : "";
    const kwSegment   = keyword ? `/${encodeURIComponent(keyword)}` : "";
    const catSegment  = categoryId ? `c${categoryId}` : "";
    const path        = `/s-${categorySlug}${pageSegment}${kwSegment}/k0${catSegment}`;

    const { body } = await this._wwwRequest("GET", path);
    const list = body?.result?.resultList || [];

    return list
      .filter(item => item.organicAdPreview)
      .slice(0, limit)
      .map(item => {
        const a = item.organicAdPreview;
        return {
          id:          a.id,
          title:       a.title,
          price:       a.price,
          description: a.description?.slice(0, 200),
          location:    a.location,
          topAd:       a.topAd,
          link:        `https://www.kleinanzeigen.de${a.seoLink}`,
        };
      });
  }

  // ── My Ads ────────────────────────────────────────────────────────────────

  /** Active published ads (cookie auth, api subdomain) */
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

  /**
   * All ad bundles incl. paused/inactive (Bearer auth, gateway).
   * Response shape TBD — no live ad available yet to map fields.
   */
  async getAdBundles() {
    const { body } = await this._gatewayRequest("GET", "/private-bundles/me/ads/bundles");
    return body;
  }

  /**
   * Draft ads.
   * Endpoint: GET https://www.kleinanzeigen.de/users/{userId}/ad-drafts.json
   */
  async getDrafts() {
    const { body } = await this._wwwRequest("GET", `/users/${this.userId}/ad-drafts.json`);
    return (body.listOfAdDrafts || []).map(d => ({
      id:          d.id,
      title:       d.title,
      category:    d.categoryDisplayName,
      categoryId:  d.categoryId,
      priceType:   d.priceType,
      description: d.description,
      images:      d.adImages?.length || 0,
      expiresAt:   d.expiryDate,
    }));
  }

}

module.exports = KleinanzeigenClient;
