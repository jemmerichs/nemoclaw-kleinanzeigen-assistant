// Kleinanzeigen API client — cookie auth (www) + Bearer JWT (gateway)
"use strict";

const https  = require("https");
const crypto = require("crypto");

const KA_AUTH0_CLIENT_ID = "aOq74Cm5fUBoM1JifHTHhlZ2JHXlVUCq";

class KleinanzeigenClient {
  constructor(cookieString, bearerToken = null, refreshToken = null) {
    if (!cookieString) throw new Error("KA_COOKIES fehlt. Bitte 'node scripts/login.js' ausführen.");
    this.cookies = cookieString;

    const at = cookieString.match(/(?:^|;\s*)access_token=([^;]+)/);
    const rt = cookieString.match(/(?:^|;\s*)refresh_token=([^;]+)/);
    this.bearerToken  = bearerToken  || (at ? at[1].trim() : null);
    this.refreshToken = refreshToken || (rt ? rt[1].trim() : null);

    // user_id: prefer cookie, fall back to JWT payload
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

  _csrfWwwRequest(method, path, body = null, extraHeaders = {}) {
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");
    const data = body instanceof Buffer ? body : (body ? Buffer.from(JSON.stringify(body)) : null);
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "www.kleinanzeigen.de",
        path,
        method,
        headers: {
          "Accept":       "application/json",
          "Content-Type": "application/json",
          "Cookie":       this.cookies,
          "x-csrf-token": csrfToken,
          "x-xsrf-token": csrfToken,
          "Origin":       "https://www.kleinanzeigen.de",
          "Referer":      "https://www.kleinanzeigen.de/",
          "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          ...(data ? { "Content-Length": data.length } : {}),
          ...extraHeaders,
        },
      };
      const req = https.request(opts, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403)
            return reject(new Error(`CSRF abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' ausführen.`));
          try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

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

  async searchAds({ keyword, categoryId, page = 1, limit = 20 } = {}) {
    // /s-{keyword}/seite:N/k0c{catId}  or  /s-k0c{catId}
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

  async getAdBundles() {
    const { body } = await this._gatewayRequest("GET", "/private-bundles/me/ads/bundles");
    return body;
  }

  _extractCsrfToken() {
    const match = this.cookies.match(/(?:^|;\s*)CSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1].trim()) : null;
  }

  async refreshCsrfToken() {
    const { refreshCookies } = require("./auth");
    const freshCookies = await refreshCookies();
    this.cookies = freshCookies;
    const at = freshCookies.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (at) this.bearerToken = at[1].trim();
    const csrf = this._extractCsrfToken();
    if (!csrf) throw new Error("CSRF-TOKEN nicht nach Refresh gefunden.");
    return csrf;
  }

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

  async uploadImage(fileBuffer, filename = "photo.jpg", mimeType = "image/jpeg") {
    const boundary = "----KABoundary" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const { status, body: parsed } = await this._csrfWwwRequest("POST", "/p-bild-hochladen.html", body, {
      "Accept":   "*/*",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Referer":  "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
    });
    const img      = parsed.yamsAdImage || parsed;
    const anyUrl   = img.largeUrl || img.largeTeaserUrl || img.thumbnailUrl || img.XLargeUrl || "";
    const uuidMatch = anyUrl.match(/\/([0-9a-f-]{36})\?/);
    const imageId  = String(parsed.imageId || parsed.id || parsed.pictureId || parsed.uuid || (uuidMatch ? uuidMatch[1] : "") || "");
    const imageUrl = String(img.largeUrl || img.largeTeaserUrl || parsed.url || parsed.imageUrl || parsed.link || "");
    if (!imageId && !imageUrl) throw new Error(`uploadImage: kein imageId/url in Antwort (${status}): ${JSON.stringify(parsed).slice(0, 200)}`);
    return { imageId, imageUrl, status };
  }

  /** Only after explicit "Go" from Jannik. price in EUR. imageUrls from uploadImage. */
  async createAd({ title, description, categoryId, price, priceType = "NEGOTIABLE", zipCode, locationId, contactName, imageUrls = [], attributes = {} }) {
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");

    const fields = {
      adType: "OFFER", title, description,
      categoryId: String(categoryId), priceAmount: String(Math.round(price)),
      priceType, buyNowEligible: "false",
      zipCode: zipCode || "", locationId: locationId || "", contactName: contactName || "",
      adId: "", trackingId: crypto.randomUUID(), postAdWenkseSessionId: crypto.randomUUID(),
      _csrf: csrfToken,
    };
    for (const [key, value] of Object.entries(attributes)) fields[`attributeMap[${key}]`] = value;
    imageUrls.forEach((url, i) => { fields[`adImages[${i}].url`] = url; });

    const { boundary, body } = this._buildMultipartTextBody(fields);
    const { status, body: parsed } = await this._csrfWwwRequest("POST", "/_actions/postListingWeb.submitListing/", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Referer":      "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
    });

    if (status !== 200 && status !== 201)
      throw new Error(`createAd fehlgeschlagen (${status}): ${JSON.stringify(parsed).slice(0, 300)}`);

    // Response is an indexed array — [{"success":1,"redirectUrl":2}, true, "/...?adId=123"]
    // or on error: [{"errors":1}, [...], ...]
    if (Array.isArray(parsed)) {
      const meta = parsed[0];
      if (meta?.errors !== undefined) {
        const msgs = (parsed[meta.errors] || []).map(idx => {
          const e = parsed[idx];
          return (e?.field !== undefined && e?.message !== undefined) ? `${parsed[e.field]}: ${parsed[e.message]}` : null;
        }).filter(Boolean);
        throw new Error(`createAd Validierungsfehler: ${msgs.join("; ") || JSON.stringify(parsed).slice(0, 200)}`);
      }
      if (meta?.redirectUrl !== undefined) {
        const redirectUrl = String(parsed[meta.redirectUrl] || "");
        const adId = (redirectUrl.match(/[?&]adId=(\d+)/) || [])[1] || "";
        return { id: adId, link: `https://www.kleinanzeigen.de/s-anzeige/${adId}` };
      }
    }
    // fallback: plain JSON
    const adUrl = parsed.url || parsed.adLink || parsed.link || "";
    const adId  = String(parsed.id || parsed.adId || (adUrl.match(/\/(\d+)(?:[/?]|$)/) || [])[1] || "");
    return { id: adId, link: adUrl || `https://www.kleinanzeigen.de/s-anzeige/${adId}` };
  }

  async deleteAd(adId) {
    const { status, body } = await this._csrfWwwRequest("POST", `/m-anzeigen-loeschen.json?ids=${encodeURIComponent(adId)}`, null, {
      "Accept":  "application/json, text/plain, */*",
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html?tab=PROJECTS",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteAd fehlgeschlagen (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    return { deleted: adId, status };
  }

  /** Save a KA draft (no Go needed — not published). Returns draftId.
   *  Note: KA drafts do not support image attachments — imageUrls are returned
   *  as-is for the caller to persist separately (e.g. via saveImages). */
  async saveDraft({ title = "", description = "", categoryId = null, priceAmount = null, priceType = "NEGOTIABLE", adType = "OFFER", zipCode = "", locationId = "", imageUrls = [], attributes = {} } = {}) {
    const body = {
      adType, title, description, priceType,
      zipCode:    zipCode    || "",
      locationId: locationId || "",
      ...(categoryId  !== null ? { categoryId:  Number(categoryId)      } : {}),
      ...(priceAmount !== null ? { priceAmount: Math.round(priceAmount) } : {}),
      ...(Object.keys(attributes).length ? { attributeMap: attributes } : {}),
    };
    const { status, body: parsed } = await this._csrfWwwRequest("POST", `/users/${this.userId}/ad-drafts.json`, body, {
      "Referer": "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
    });
    if (status !== 200 && status !== 201)
      throw new Error(`saveDraft fehlgeschlagen (${status}): ${JSON.stringify(parsed).slice(0, 300)}`);
    if (!parsed?.result?.actionSuccessful)
      throw new Error(`saveDraft fehlgeschlagen: ${JSON.stringify(parsed).slice(0, 300)}`);
    return { draftId: String(parsed.adDraft?.id || ""), imageUrls };
  }

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

  async deleteDraft(draftId) {
    const { status } = await this._csrfWwwRequest("DELETE", `/users/${this.userId}/ad-drafts/${draftId}.json`, null, {
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteDraft fehlgeschlagen (${status})`);
    return { deleted: draftId };
  }

}

module.exports = KleinanzeigenClient;
