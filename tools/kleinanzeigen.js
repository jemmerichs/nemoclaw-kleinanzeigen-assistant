// Kleinanzeigen API client — cookie auth (www) + Bearer JWT (gateway)
"use strict";

const https  = require("https");
const crypto = require("crypto");

const KA_AUTH0_CLIENT_ID = "aOq74Cm5fUBoM1JifHTHhlZ2JHXlVUCq";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeFilename(filename) {
  return String(filename || "photo.jpg").replace(/["\r\n\\/]/g, "_");
}

class KleinanzeigenClient {
  constructor(cookieString, bearerToken = null, refreshToken = null, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!cookieString) throw new Error("KA_COOKIES fehlt. Bitte 'node scripts/login.js' ausführen.");
    this.cookies = cookieString;
    this.timeoutMs = clampInteger(timeoutMs, { min: 1000, max: 120000, fallback: DEFAULT_TIMEOUT_MS });

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

  _requireUserId() {
    if (!this.userId) throw new Error("Kleinanzeigen user_id fehlt in Session. Bitte 'node scripts/login.js' erneut ausführen.");
    return this.userId;
  }

  _ensureSuccess(operation, response, allowedStatuses = [200]) {
    if (!allowedStatuses.includes(response.status)) {
      const detail = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      throw new Error(`${operation} fehlgeschlagen (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response;
  }

  _collectResponse(req, res, resolve, reject) {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
        req.destroy(new Error("Kleinanzeigen-Antwort ist größer als 10 MB"));
      }
    });
    res.on("end", () => {
      try {
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
      } catch {
        resolve({ status: res.statusCode, body: raw });
      }
    });
    res.on("error", reject);
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

      let req;
      req = https.request(options, res => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume();
          return reject(new Error(`Session abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' erneut ausführen.`));
        }
        this._collectResponse(req, res, resolve, reject);
      });

      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`${method} ${hostname}${path}: Timeout`)));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
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
      let req;
      req = https.request(opts, res => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume();
          return reject(new Error(`CSRF abgelaufen (${res.statusCode}). Bitte 'node scripts/login.js' ausführen.`));
        }
        this._collectResponse(req, res, resolve, reject);
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`${method} www.kleinanzeigen.de${path}: Timeout`)));
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
          "x-ecg-user-agent": "messagebox-1",
          "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          "Origin":        "https://www.kleinanzeigen.de",
          "Referer":       "https://www.kleinanzeigen.de/",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      };

      let req;
      req = https.request(options, res => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume();
          return reject(new Error(`Bearer token abgelaufen (${res.statusCode}).`));
        }
        this._collectResponse(req, res, resolve, reject);
      });

      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`${method} gateway.kleinanzeigen.de${path}: Timeout`)));
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

      let req;
      req = https.request(options, res => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (res.statusCode < 200 || res.statusCode >= 300 || !data.access_token) {
              return reject(new Error(`Token-Refresh fehlgeschlagen (${res.statusCode}): ${raw.slice(0, 300)}`));
            }
            this.bearerToken = data.access_token;
            if (data.refresh_token) this.refreshToken = data.refresh_token;
            resolve(data);
          } catch {
            reject(new Error(`Token-Refresh Parse-Fehler: ${raw}`));
          }
        });
      });

      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("Token-Refresh: Timeout")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async getConversations({ limit = 20, offset = 0 } = {}) {
    const userId = this._requireUserId();
    const query = new URLSearchParams({
      limit: String(clampInteger(limit, { min: 1, max: 100, fallback: 20 })),
      offset: String(clampInteger(offset, { min: 0, max: 100000, fallback: 0 })),
    });
    const response = await this._gatewayRequest("GET", `/messagebox/api/users/${userId}/conversations?${query}`);
    const { body } = this._ensureSuccess("getConversations", response);
    if (!Array.isArray(body?.conversations)) throw new Error("getConversations: unerwartetes Antwortformat.");
    return (body.conversations || []).map(c => ({
      id:          c.id,
      adId:        c.adId,
      adTitle:     c.adTitle || "",
      adStatus:    c.adStatus,
      otherParty:  String(c.userIdBuyer) === String(this.userId) ? c.sellerName : c.buyerName,
      lastMessage: c.textShortTrimmed || "",
      unread:      Boolean(c.unread),
      updatedAt:   c.receivedDate,
    }));
  }

  async getMessages(conversationId, { limit = 20 } = {}) {
    const userId = this._requireUserId();
    if (!conversationId) throw new Error("conversationId fehlt.");
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
    const response = await this._gatewayRequest(
      "GET",
      `/messagebox/api/users/${userId}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${safeLimit}`
    );
    const { body } = this._ensureSuccess("getMessages", response);
    if (!Array.isArray(body?.messages)) throw new Error("getMessages: unerwartetes Antwortformat.");
    return (body.messages || []).map(m => ({
      id:     m.id,
      text:   m.text || "",
      sentAt: m.sentAt,
      isMe:   String(m.senderUserId) === String(this.userId),
    }));
  }

  /** Only after explicit "Go" from Jannik */
  async sendMessage(conversationId, text) {
    const userId = this._requireUserId();
    if (!conversationId) throw new Error("conversationId fehlt.");
    if (!String(text || "").trim()) throw new Error("Nachrichtentext fehlt.");
    const response = await this._gatewayRequest(
      "POST",
      `/messagebox/api/users/${userId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { message: String(text).trim() }
    );
    return this._ensureSuccess("sendMessage", response, [200, 201]).body;
  }

  async searchAds({ keyword = "", categoryId, categorySlug, page = 1, limit = 20 } = {}) {
    const normalizedKeyword = String(keyword).trim();
    const safePage = clampInteger(page, { min: 1, max: 100, fallback: 1 });
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
    const safeCategoryId = categoryId === undefined || categoryId === null
      ? ""
      : String(clampInteger(categoryId, { min: 1, max: 9999, fallback: 0 }));
    const safeSlug = String(categorySlug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

    const categorySuffix = safeCategoryId ? `c${safeCategoryId}` : "";
    let searchPath;
    if (!safeSlug && !normalizedKeyword && safePage === 1) {
      searchPath = `/s-k0${categorySuffix}`;
    } else {
      if (safeSlug) searchPath = `/s-${safeSlug}`;
      else if (normalizedKeyword) searchPath = `/s-${encodeURIComponent(normalizedKeyword)}`;
      else searchPath = "/s";
      if (safePage > 1) searchPath += `/seite:${safePage}`;
      if (safeSlug && normalizedKeyword) searchPath += `/${encodeURIComponent(normalizedKeyword)}`;
      searchPath += `/k0${categorySuffix}`;
    }

    const response = await this._wwwRequest("GET", searchPath);
    const { body } = this._ensureSuccess("searchAds", response);
    if (!Array.isArray(body?.result?.resultList)) {
      throw new Error("searchAds: unerwartetes Antwortformat (möglicherweise Login- oder Bot-Schutz-Seite).");
    }
    const list = body.result.resultList;

    return list
      .filter(item => item.organicAdPreview)
      .slice(0, safeLimit)
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
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
    const response = await this._wwwRequest("GET", "/m-meine-anzeigen-verwalten.json");
    const { body } = this._ensureSuccess("getMyAds", response);
    if (!Array.isArray(body?.ads)) throw new Error("getMyAds: unerwartetes Antwortformat.");
    return (body.ads || []).slice(0, safeLimit).map(a => ({
      id:       a.id,
      title:    a.title,
      price:    a.priceAmount,
      status:   a.adStatus,
      views:    a.pageViewCount,
      category: a.categoryTreePath || "",
    }));
  }

  async getAdBundles() {
    const response = await this._gatewayRequest("GET", "/private-bundles/me/ads/bundles");
    return this._ensureSuccess("getAdBundles", response).body;
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
    const rt = freshCookies.match(/(?:^|;\s*)refresh_token=([^;]+)/);
    this.bearerToken = at ? at[1].trim() : null;
    this.refreshToken = rt ? rt[1].trim() : null;
    const csrf = this._extractCsrfToken();
    if (!csrf) throw new Error("CSRF-TOKEN nicht nach Refresh gefunden.");
    return csrf;
  }

  _buildMultipartTextBody(fields) {
    const boundary = "----KABoundary" + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      const fieldName = String(name).replace(/["\r\n]/g, "_");
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`
      ));
    }
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
    return { boundary, body };
  }

  async uploadImage(fileBuffer, filename = "photo.jpg", mimeType = "image/jpeg", { forDraft = false } = {}) {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) throw new Error("uploadImage: Bilddatei ist leer.");
    if (fileBuffer.length > 20 * 1024 * 1024) throw new Error("uploadImage: Bild ist größer als 20 MB.");
    const uploadFilename = safeFilename(filename);
    const uploadMimeType = /^image\/(?:jpeg|png|gif|webp|bmp)$/.test(String(mimeType)) ? String(mimeType) : "image/jpeg";
    const boundary = "----KABoundary" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${uploadMimeType}`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${uploadFilename}"\r\nContent-Type: ${uploadMimeType}\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const referer = forDraft
      ? "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html?createDraft=true"
      : "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html";
    const { status, body: parsed } = await this._csrfWwwRequest("POST", "/p-bild-hochladen.html", body, {
      "Accept":   "*/*",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Referer":  referer,
    });
    if (status !== 200 && status !== 201) {
      throw new Error(`uploadImage fehlgeschlagen (${status}): ${JSON.stringify(parsed).slice(0, 300)}`);
    }
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
    if (!String(title || "").trim()) throw new Error("createAd: Titel fehlt.");
    if (String(title).trim().length > 60) throw new Error("createAd: Titel darf maximal 60 Zeichen lang sein.");
    if (!String(description || "").trim()) throw new Error("createAd: Beschreibung fehlt.");
    if (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0) throw new Error("createAd: categoryId ist ungültig.");
    if (!Number.isFinite(Number(price)) || Number(price) < 0) throw new Error("createAd: Preis ist ungültig.");
    if (!Array.isArray(imageUrls)) throw new Error("createAd: imageUrls muss eine Liste sein.");
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");

    const fields = {
      adType: "OFFER", title: String(title).trim(), description: String(description).trim(),
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
        if (!adId) throw new Error(`createAd: keine Anzeigen-ID in Antwort: ${redirectUrl.slice(0, 200)}`);
        return { id: adId, link: `https://www.kleinanzeigen.de/s-anzeige/${adId}` };
      }
    }
    // fallback: plain JSON
    const adUrl = parsed.url || parsed.adLink || parsed.link || "";
    const adId  = String(parsed.id || parsed.adId || (adUrl.match(/\/(\d+)(?:[/?]|$)/) || [])[1] || "");
    if (!adId && !adUrl) throw new Error(`createAd: unerwartetes Antwortformat: ${JSON.stringify(parsed).slice(0, 300)}`);
    return { id: adId, link: adUrl || `https://www.kleinanzeigen.de/s-anzeige/${adId}` };
  }

  async deleteAd(adId) {
    if (!adId) throw new Error("adId fehlt.");
    const { status, body } = await this._csrfWwwRequest("POST", `/m-anzeigen-loeschen.json?ids=${encodeURIComponent(adId)}`, null, {
      "Accept":  "application/json, text/plain, */*",
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html?tab=PROJECTS",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteAd fehlgeschlagen (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    return { deleted: adId, status };
  }

  /** Save a KA draft (no Go needed — not published). Returns draftId.
   *  imageUrls from uploadImage({ forDraft: true }) are attached to the draft. */
  async saveDraft({ title = "", description = "", categoryId = null, priceAmount = null, priceType = "NEGOTIABLE", adType = "OFFER", zipCode = "", locationId = "", imageUrls = [], attributes = {} } = {}) {
    const userId = this._requireUserId();
    if (!Array.isArray(imageUrls)) throw new Error("saveDraft: imageUrls muss eine Liste sein.");
    if (categoryId !== null && (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0)) {
      throw new Error("saveDraft: categoryId ist ungültig.");
    }
    if (priceAmount !== null && (!Number.isFinite(Number(priceAmount)) || Number(priceAmount) < 0)) {
      throw new Error("saveDraft: priceAmount ist ungültig.");
    }
    const body = {
      adType, title, description, priceType,
      zipCode:    zipCode    || "",
      locationId: locationId || "",
      ...(categoryId  !== null ? { categoryId:  Number(categoryId)      } : {}),
      ...(priceAmount !== null ? { priceAmount: Math.round(priceAmount) } : {}),
      ...(Object.keys(attributes).length ? { attributeMap: attributes } : {}),
      ...(imageUrls.length ? { adImages: imageUrls } : {}),
    };
    const { status, body: parsed } = await this._csrfWwwRequest("POST", `/users/${userId}/ad-drafts.json`, body, {
      "Referer": "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html",
    });
    if (status !== 200 && status !== 201)
      throw new Error(`saveDraft fehlgeschlagen (${status}): ${JSON.stringify(parsed).slice(0, 300)}`);
    if (!parsed?.result?.actionSuccessful)
      throw new Error(`saveDraft fehlgeschlagen: ${JSON.stringify(parsed).slice(0, 300)}`);
    const draftId = String(parsed.adDraft?.id || "");
    if (!draftId) throw new Error(`saveDraft: keine draftId in Antwort: ${JSON.stringify(parsed).slice(0, 300)}`);
    return { draftId, imageCount: imageUrls.length };
  }

  async getDrafts() {
    const userId = this._requireUserId();
    const response = await this._wwwRequest("GET", `/users/${userId}/ad-drafts.json`);
    const { body } = this._ensureSuccess("getDrafts", response);
    if (!Array.isArray(body?.listOfAdDrafts)) throw new Error("getDrafts: unerwartetes Antwortformat.");
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
    const userId = this._requireUserId();
    if (!draftId) throw new Error("draftId fehlt.");
    const { status } = await this._csrfWwwRequest("DELETE", `/users/${userId}/ad-drafts/${encodeURIComponent(draftId)}.json`, null, {
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteDraft fehlgeschlagen (${status})`);
    return { deleted: draftId };
  }

}

module.exports = KleinanzeigenClient;
