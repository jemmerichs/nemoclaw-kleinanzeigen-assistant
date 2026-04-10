/**
 * Kleinanzeigen API client
 *
 *   www.kleinanzeigen.de     cookie auth   getMyAds, getDrafts, searchAds, uploadImage, createAd
 *   gateway.kleinanzeigen.de Bearer JWT    getConversations, getMessages, sendMessage, getAdBundles
 *
 * api.kleinanzeigen.de uses HTTP Digest auth — not used.
 * Tokens (access_token, refresh_token) are extracted from the cookie string automatically.
 */

"use strict";

const https  = require("https");
const crypto = require("crypto");

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
    const { body } = await this._gatewayRequest("GET", `/messagebox/api/users/${this.userId}/conversations?limit=${limit}&offset=${offset}`);
    const isMe = (c) => c.userIdBuyer === Number(this.userId) ? c.role === "buyer" : c.role === "seller";
    return (body.conversations || []).map(c => ({
      id:          c.id,
      adId:        c.adId,
      adTitle:     c.adTitle || "",
      adStatus:    c.adStatus,
      otherParty:  isMe(c) ? c.sellerName : c.buyerName,
      lastMessage: c.textShortTrimmed || "",
      unread:      c.unread || false,
      updatedAt:   c.receivedDate,
    }));
  }

  async getMessages(conversationId, { limit = 20 } = {}) {
    const { body } = await this._gatewayRequest("GET", `/messagebox/api/users/${this.userId}/conversations/${conversationId}/messages?limit=${limit}`);
    return (body.messages || []).map(m => ({
      id:     m.id,
      text:   m.text || "",
      sentAt: m.sentAt,
      isMe:   String(m.senderUserId) === String(this.userId),
    }));
  }

  /** Only after explicit "Go" from Jannik */
  async sendMessage(conversationId, text) {
    const { status, body } = await this._gatewayRequest(
      "POST",
      `/messagebox/api/users/${this.userId}/conversations/${conversationId}/messages`,
      { message: text }
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
  async searchAds({ keyword, categoryId, page = 1, limit = 20 } = {}) {
    // URL format: /s-{keyword}/seite:N/k0c{catId}  (keyword present)
    //             /s-k0c{catId}                     (category only)
    const pageSegment = page > 1 ? `/seite:${page}` : "";
    const catSuffix   = categoryId ? `c${categoryId}` : "";
    const path = keyword
      ? `/s-${encodeURIComponent(keyword)}${pageSegment}/k0${catSuffix}`
      : `/s-k0${catSuffix}`;

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

  /** Active published ads (cookie auth, www JSON endpoint) */
  async getMyAds({ limit = 20 } = {}) {
    const { body } = await this._wwwRequest("GET", "/m-meine-anzeigen-verwalten.json");
    return (body.ads || []).slice(0, limit).map(a => ({
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

  // ── Internal: CSRF token from cookies ────────────────────────────────────

  _extractCsrfToken() {
    const match = this.cookies.match(/(?:^|;\s*)CSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1].trim()) : null;
  }

  /**
   * Refresh cookies via the persistent stealth browser profile.
   * Passes Akamai bot detection — no login or 2FA required.
   * Updates this.cookies in place from the freshly written .env.
   * @returns {Promise<string>} new CSRF token
   */
  async refreshCsrfToken() {
    const { refreshCookies } = require("./auth");
    const freshCookies = await refreshCookies();
    this.cookies = freshCookies;
    // Re-extract bearer token from fresh cookies
    const at = freshCookies.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (at) this.bearerToken = at[1].trim();
    const csrf = this._extractCsrfToken();
    if (!csrf) throw new Error("CSRF-TOKEN nicht nach Refresh gefunden.");
    return csrf;
  }

  // ── Internal: multipart/form-data builder (text fields only) ─────────────

  _buildMultipartTextBody(fields) {
    const boundary = "----KABoundary" + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    }
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
    return { boundary, body };
  }

  // ── Ad creation ───────────────────────────────────────────────────────────

  /**
   * Upload a single image before ad creation — returns imageId to pass to createAd.
   * Requires CSRF-TOKEN cookie (set by the browser session on login).
   * @returns {{ imageId: string }}
   */
  uploadImage(fileBuffer, filename = "photo.jpg", mimeType = "image/jpeg") {
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");

    const boundary = "----KABoundary" + Math.random().toString(36).slice(2);

    const typePart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}`
    );
    const filePre  = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const filePost = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([typePart, filePre, fileBuffer, filePost]);

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "www.kleinanzeigen.de",
        path:     "/p-bild-hochladen.html",
        method:   "POST",
        headers: {
          "Accept":         "*/*",
          "Content-Type":   `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          "Cookie":         this.cookies,
          "x-csrf-token":   csrfToken,
          "x-xsrf-token":   csrfToken,
          "User-Agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          "Origin":         "https://www.kleinanzeigen.de",
          "Referer":        "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
        },
      };
      const req = https.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`CSRF abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' ausführen.`));
          }
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            // Response may be wrapped in yamsAdImage
            const img    = parsed.yamsAdImage || parsed;
            // Extract UUID from any URL field (e.g. largeUrl, thumbnailUrl)
            const anyUrl = img.largeUrl || img.largeTeaserUrl || img.thumbnailUrl || img.XLargeUrl || "";
            const uuidMatch = anyUrl.match(/\/([0-9a-f-]{36})\?/);
            const imageId  = String(parsed.imageId || parsed.id || parsed.pictureId || parsed.uuid || (uuidMatch ? uuidMatch[1] : "") || "");
            const imageUrl = String(img.largeUrl || img.largeTeaserUrl || parsed.url || parsed.imageUrl || parsed.link || "");
            if (!imageId && !imageUrl) return reject(new Error(`uploadImage: kein imageId/url in Antwort (${res.statusCode}): ${raw.slice(0, 200)}`));
            resolve({ imageId, imageUrl, status: res.statusCode });
          } catch {
            reject(new Error(`uploadImage: ungültige Antwort (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Create a new Kleinanzeigen listing.
   * Only call after explicit "Go" from Jannik.
   *
   * Endpoint: POST https://www.kleinanzeigen.de/_actions/postListingWeb.submitListing/
   * Content-Type: multipart/form-data (text fields only — images pre-uploaded via uploadImage)
   *
   * @param {object}            adData
   * @param {string}            adData.title
   * @param {string}            adData.description
   * @param {number}            adData.categoryId        e.g. 217 = Fahrräder
   * @param {number}            adData.price             in EUR
   * @param {string}            [adData.priceType]       "FIXED" | "NEGOTIABLE" | "GIVE_AWAY"
   * @param {string}            [adData.zipCode]         e.g. "80636"
   * @param {string}            [adData.locationId]      KA internal location ID, e.g. "16360" for München-Neuhausen
   * @param {string}            [adData.contactName]     display name on the listing
   * @param {string[]}          [adData.imageUrls]       URLs returned by uploadImage, in order
   * @param {Record<string,string>} [adData.attributes]  category-specific attributeMap entries
   * @returns {{ id: string, link: string }}
   */
  createAd({ title, description, categoryId, price, priceType = "NEGOTIABLE", zipCode, locationId, contactName, imageUrls = [], attributes = {} }) {
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");

    const fields = {
      adType:                 "OFFER",
      title,
      description,
      categoryId:             String(categoryId),
      priceAmount:            String(Math.round(price)),
      priceType,
      buyNowEligible:         "false",
      zipCode:                zipCode    || "",
      locationId:             locationId || "",
      contactName:            contactName || "",
      adId:                   "",
      trackingId:             crypto.randomUUID(),
      postAdWenkseSessionId:  crypto.randomUUID(),
      _csrf:                  csrfToken,
    };

    for (const [key, value] of Object.entries(attributes)) {
      fields[`attributeMap[${key}]`] = value;
    }
    imageUrls.forEach((url, i) => { fields[`adImages[${i}].url`] = url; });

    const { boundary, body } = this._buildMultipartTextBody(fields);

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "www.kleinanzeigen.de",
        path:     "/_actions/postListingWeb.submitListing/",
        method:   "POST",
        headers: {
          "Accept":         "application/json",
          "Content-Type":   `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          "Cookie":         this.cookies,
          "x-csrf-token":   csrfToken,
          "x-xsrf-token":   csrfToken,
          "Origin":         "https://www.kleinanzeigen.de",
          "Referer":        "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
          "User-Agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        },
      };
      const req = https.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`CSRF abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' ausführen.`));
          }
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode !== 200 && res.statusCode !== 201) {
              return reject(new Error(`createAd fehlgeschlagen (${res.statusCode}): ${raw.slice(0, 300)}`));
            }
            // Success response is an indexed array:
            // [{"success":1,"redirectUrl":2}, true, "/p-anzeige-aufgeben-bestaetigung.html?adId=123&..."]
            // Error response: [{"errors":1}, [...], ...]
            if (Array.isArray(parsed)) {
              const meta = parsed[0];
              if (meta && meta.errors !== undefined) {
                // Decode error messages from indexed format
                const msgs = [];
                const indices = parsed[meta.errors] || [];
                for (const idx of indices) {
                  const errObj = parsed[idx];
                  if (errObj && errObj.field !== undefined && errObj.message !== undefined) {
                    msgs.push(`${parsed[errObj.field]}: ${parsed[errObj.message]}`);
                  }
                }
                return reject(new Error(`createAd Validierungsfehler: ${msgs.join("; ") || raw.slice(0, 200)}`));
              }
              if (meta && meta.redirectUrl !== undefined) {
                const redirectUrl = String(parsed[meta.redirectUrl] || "");
                const adIdMatch   = redirectUrl.match(/[?&]adId=(\d+)/);
                const adId        = adIdMatch ? adIdMatch[1] : "";
                resolve({ id: adId, link: `https://www.kleinanzeigen.de/s-anzeige/${adId}` });
                return;
              }
            }
            // Fallback: plain JSON object
            const adUrl = parsed.url || parsed.adLink || parsed.link || "";
            const adId  = String(parsed.id || parsed.adId || (adUrl.match(/\/(\d+)(?:[/?]|$)/) || [])[1] || "");
            resolve({ id: adId, link: adUrl || `https://www.kleinanzeigen.de/s-anzeige/${adId}` });
          } catch {
            reject(new Error(`createAd Parse-Fehler (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Delete an existing ad by its KA ad ID.
   * Endpoint: POST https://www.kleinanzeigen.de/m-anzeigen-loeschen.json?ids={adId}
   * No request body — ad ID is passed as query param.
   * @param {string} adId  KA ad ID (numeric string)
   */
  async deleteAd(adId) {
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies.");
    const { status, body } = await new Promise((resolve, reject) => {
      const opts = {
        hostname: "www.kleinanzeigen.de",
        path:     `/m-anzeigen-loeschen.json?ids=${encodeURIComponent(adId)}`,
        method:   "POST",
        headers: {
          "Accept":         "application/json, text/plain, */*",
          "Content-Length": "0",
          "Cookie":         this.cookies,
          "x-csrf-token":   csrfToken,
          "x-xsrf-token":   csrfToken,
          "Origin":         "https://www.kleinanzeigen.de",
          "Referer":        "https://www.kleinanzeigen.de/m-meine-anzeigen.html?tab=PROJECTS",
          "User-Agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        },
      };
      const req = https.request(opts, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (status !== 200 && status !== 204) {
      throw new Error(`deleteAd fehlgeschlagen (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
    return { deleted: adId, status };
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
