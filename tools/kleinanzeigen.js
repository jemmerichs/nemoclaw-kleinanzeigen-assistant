// Kleinanzeigen API client — cookie auth (www) + Bearer JWT (gateway)
"use strict";

const https  = require("https");
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";
const PRICE_TYPES = new Set(["FIXED", "NEGOTIABLE", "GIVE_AWAY"]);

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeFilename(filename) {
  return String(filename || "photo.jpg").replace(/["\r\n\\/]/g, "_");
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token || "").split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function safeBrowserHeader(value, fallback, maxLength = 512) {
  const header = String(value || "").trim();
  if (!header || header.length > maxLength || /[\r\n]/.test(header)) return fallback;
  return header;
}

function validatePriceType(value) {
  const priceType = String(value || "").toUpperCase();
  if (!PRICE_TYPES.has(priceType)) {
    throw new Error("priceType muss FIXED, NEGOTIABLE oder GIVE_AWAY sein.");
  }
  return priceType;
}

function validateAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value === undefined || value === null) return {};
    throw new Error("attributes muss ein Objekt sein.");
  }
  const entries = Object.entries(value);
  if (entries.length > 30) throw new Error("Maximal 30 Anzeigenattribute sind erlaubt.");
  const attributes = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new Error(`Ungültiger Attributname: ${key}`);
    const stringValue = String(rawValue);
    if (stringValue.length > 500) throw new Error(`Attribut ${key} ist zu lang.`);
    attributes[key] = stringValue;
  }
  return attributes;
}

function validateImageUrls(value) {
  if (!Array.isArray(value)) throw new Error("imageUrls muss eine Liste sein.");
  if (value.length > 20) throw new Error("Maximal 20 Bilder sind erlaubt.");
  return value.map(rawUrl => {
    let url;
    try { url = new URL(String(rawUrl)); }
    catch { throw new Error("Ungültige Bild-URL."); }
    if (url.protocol !== "https:" || !/(^|\.)kleinanzeigen\.de$/i.test(url.hostname)) {
      throw new Error("Bild-URLs müssen HTTPS-URLs von kleinanzeigen.de sein.");
    }
    return url.toString();
  });
}

function mergeCookieHeader(cookieString, setCookieHeaders) {
  const values = new Map();
  for (const part of String(cookieString || "").split(";")) {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const rawHeader of Array.isArray(setCookieHeaders) ? setCookieHeaders : []) {
    const pair = String(rawHeader || "").split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) continue;
    if (/;\s*Max-Age=0(?:;|$)/i.test(rawHeader)) values.delete(name);
    else values.set(name, value);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function clientError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  if (status !== null) error.status = status;
  return error;
}

function accessResponseError(status, { authenticated = true, transport = "cookie" } = {}) {
  if (status === 429) {
    return clientError(
      "KA_ACCESS_DENIED",
      "Kleinanzeigen hat den aktuellen Netzwerkpfad gedrosselt (429). Keine automatischen Wiederholungen.",
      status
    );
  }
  if (status === 403) {
    return clientError(
      authenticated ? "KA_SESSION_REJECTED" : "KA_PUBLIC_ACCESS_DENIED",
      authenticated
        ? "Private Kleinanzeigen-Sitzung abgelehnt (403). Browserprofil und Request-Fingerabdruck müssen erneuert werden."
        : "Öffentlicher Kleinanzeigen-Zugriff abgelehnt (403). Nicht automatisch erneut einloggen oder wiederholen; zuerst Netzwerk/IP-Pfad prüfen.",
      status
    );
  }
  if (transport === "csrf" && status === 401) {
    return clientError(
      "KA_CSRF_EXPIRED",
      `CSRF abgelaufen (${status}). Bitte 'npm run login' ausführen.`,
      status
    );
  }
  if (transport === "bearer" && status === 401) {
    return clientError(
      "KA_BEARER_EXPIRED",
      `Bearer token abgelaufen (${status}).`,
      status
    );
  }
  if (!authenticated && status === 401) {
    return clientError(
      "KA_PUBLIC_ACCESS_DENIED",
      `Öffentlicher Kleinanzeigen-Zugriff abgelehnt (${status}). ` +
      "Nicht automatisch erneut einloggen; zuerst Netzwerk/IP-Pfad prüfen.",
      status
    );
  }
  if (authenticated && transport === "cookie" && status === 401) {
    return clientError(
      "KA_SESSION_EXPIRED",
      `Session abgelaufen (${status}). Bitte 'npm run login' erneut ausführen.`,
      status
    );
  }
  return null;
}

class KleinanzeigenClient {
  constructor(cookieString, bearerToken = null, refreshToken = null, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = process.env.KA_USER_AGENT,
    acceptLanguage = process.env.KA_ACCEPT_LANGUAGE,
    secChUa = process.env.KA_SEC_CH_UA,
    secChUaMobile = process.env.KA_SEC_CH_UA_MOBILE,
    secChUaPlatform = process.env.KA_SEC_CH_UA_PLATFORM,
  } = {}) {
    this.cookies = String(cookieString || "");
    this.timeoutMs = clampInteger(timeoutMs, { min: 1000, max: 120000, fallback: DEFAULT_TIMEOUT_MS });
    this.userAgent = safeBrowserHeader(userAgent, USER_AGENT);
    this.acceptLanguage = safeBrowserHeader(acceptLanguage, DEFAULT_ACCEPT_LANGUAGE, 256);
    this.clientHints = {
      secChUa: safeBrowserHeader(secChUa, "", 512),
      secChUaMobile: /^\?[01]$/.test(String(secChUaMobile || "")) ? String(secChUaMobile) : "",
      secChUaPlatform: /^"[^"\r\n]{1,80}"$/.test(String(secChUaPlatform || "")) ? String(secChUaPlatform) : "",
    };

    const at = cookieString.match(/(?:^|;\s*)access_token=([^;]+)/);
    const rt = cookieString.match(/(?:^|;\s*)refresh_token=([^;]+)/);
    this.bearerToken  = bearerToken  || (at ? at[1].trim() : null);
    this.refreshToken = refreshToken || (rt ? rt[1].trim() : null);

    // user_id: prefer cookie, fall back to JWT payload
    const uid = cookieString.match(/(?:^|;\s*)user_id=(\d+)/);
    if (uid) {
      this.userId = uid[1];
    } else if (this.bearerToken) {
      const claim = Object.entries(jwtPayload(this.bearerToken) || {}).find(
        ([key, value]) =>
          (key === "user_id" || /\/user_id$/i.test(key)) &&
          /^\d+$/.test(String(value))
      );
      this.userId = claim ? String(claim[1]) : null;
    } else {
      this.userId = null;
    }
  }

  _requireCookieSession() {
    if (!this.cookies) throw new Error("KA_COOKIES fehlt. Bitte 'npm run login' ausführen.");
    return this.cookies;
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
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {}, headers: res.headers });
      } catch {
        resolve({ status: res.statusCode, body: raw, headers: res.headers });
      }
    });
    res.on("error", reject);
  }

  _cookieRequest(hostname, path, method, body = null, { cookieString = this.cookies, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const options = {
        hostname,
        path,
        method,
        headers: {
          "Accept":        "application/json",
          "Accept-Language": this.acceptLanguage,
          "User-Agent":    this.userAgent,
          "Referer":       "https://www.kleinanzeigen.de/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Priority":      "u=1, i",
          ...(this.clientHints.secChUa ? { "sec-ch-ua": this.clientHints.secChUa } : {}),
          ...(this.clientHints.secChUaMobile ? { "sec-ch-ua-mobile": this.clientHints.secChUaMobile } : {}),
          ...(this.clientHints.secChUaPlatform ? { "sec-ch-ua-platform": this.clientHints.secChUaPlatform } : {}),
          ...(cookieString ? { "Cookie": cookieString } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      };

      let req;
      req = https.request(options, res => {
        const accessError = accessResponseError(res.statusCode, {
          authenticated: Boolean(cookieString),
          transport: "cookie",
        });
        if (accessError) {
          res.resume();
          return reject(accessError);
        }
        if (cookieString && res.headers["set-cookie"]) {
          this.cookies = mergeCookieHeader(this.cookies, res.headers["set-cookie"]);
        }
        this._collectResponse(req, res, resolve, reject);
      });

      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`${method} ${hostname}${path}: Timeout`)));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  _wwwRequest(method, path, body = null, { authenticated = true, headers = {} } = {}) {
    return this._cookieRequest("www.kleinanzeigen.de", path, method, body, {
      cookieString: authenticated ? this.cookies : "",
      headers,
    });
  }

  _csrfWwwRequest(method, path, body = null, extraHeaders = {}) {
    this._requireCookieSession();
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
          "Accept-Language": this.acceptLanguage,
          "User-Agent":   this.userAgent,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Priority":     "u=1, i",
          ...(this.clientHints.secChUa ? { "sec-ch-ua": this.clientHints.secChUa } : {}),
          ...(this.clientHints.secChUaMobile ? { "sec-ch-ua-mobile": this.clientHints.secChUaMobile } : {}),
          ...(this.clientHints.secChUaPlatform ? { "sec-ch-ua-platform": this.clientHints.secChUaPlatform } : {}),
          ...(data ? { "Content-Length": data.length } : {}),
          ...extraHeaders,
        },
      };
      let req;
      req = https.request(opts, res => {
        const accessError = accessResponseError(res.statusCode, { transport: "csrf" });
        if (accessError) {
          res.resume();
          return reject(accessError);
        }
        if (res.headers["set-cookie"]) {
          this.cookies = mergeCookieHeader(this.cookies, res.headers["set-cookie"]);
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
          "Accept-Language": this.acceptLanguage,
          "User-Agent":    this.userAgent,
          "Origin":        "https://www.kleinanzeigen.de",
          "Referer":       "https://www.kleinanzeigen.de/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          "Priority":      "u=1, i",
          ...(this.clientHints.secChUa ? { "sec-ch-ua": this.clientHints.secChUa } : {}),
          ...(this.clientHints.secChUaMobile ? { "sec-ch-ua-mobile": this.clientHints.secChUaMobile } : {}),
          ...(this.clientHints.secChUaPlatform ? { "sec-ch-ua-platform": this.clientHints.secChUaPlatform } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      };

      let req;
      req = https.request(options, res => {
        const accessError = accessResponseError(res.statusCode, { transport: "bearer" });
        if (accessError) {
          res.resume();
          return reject(accessError);
        }
        this._collectResponse(req, res, resolve, reject);
      });

      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`${method} gateway.kleinanzeigen.de${path}: Timeout`)));
      req.on("error", reject);
      if (data) req.write(data);
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
    if (!conversationId || String(conversationId).length > 200) throw new Error("conversationId fehlt oder ist ungültig.");
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
    if (!conversationId || String(conversationId).length > 200) throw new Error("conversationId fehlt oder ist ungültig.");
    const message = String(text || "").trim();
    if (!message) throw new Error("Nachrichtentext fehlt.");
    if (message.length > 4000) throw new Error("Nachrichtentext ist länger als 4000 Zeichen.");
    const response = await this._gatewayRequest(
      "POST",
      `/messagebox/api/users/${userId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { message }
    );
    return this._ensureSuccess("sendMessage", response, [200, 201]).body;
  }

  async searchAds({ keyword = "", categoryId, categorySlug, page = 1, limit = 20 } = {}) {
    const normalizedKeyword = String(keyword).trim();
    const safePage = clampInteger(page, { min: 1, max: 100, fallback: 1 });
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
    let safeCategoryId = "";
    if (categoryId !== undefined && categoryId !== null && categoryId !== "") {
      const parsedCategoryId = Number(categoryId);
      if (!Number.isInteger(parsedCategoryId) || parsedCategoryId < 1 || parsedCategoryId > 9999) {
        throw new Error("searchAds: categoryId ist ungültig.");
      }
      safeCategoryId = String(parsedCategoryId);
    }
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

    const response = await this._wwwRequest("GET", searchPath, null, { authenticated: false });
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
        const categoryFromLink = (String(a.seoLink || "").match(/\/\d+-(\d+)-\d+(?:[/?]|$)/) || [])[1];
        const categoryId = a.categoryId || (categoryFromLink ? Number(categoryFromLink) : undefined);
        return {
          id:          a.id,
          title:       a.title,
          price:       a.price,
          description: a.description?.slice(0, 200),
          location:    a.location,
          ...(categoryId ? { categoryId } : {}),
          ...(a.categoryDisplayName || a.categoryName
            ? { category: a.categoryDisplayName || a.categoryName }
            : {}),
          topAd:       a.topAd,
          link:        `https://www.kleinanzeigen.de${a.seoLink}`,
        };
      });
  }

  async getMyAds({ limit = 20 } = {}) {
    this._requireCookieSession();
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
    const response = await this._wwwRequest("GET", "/m-meine-anzeigen-verwalten.json?sort=DEFAULT");
    const { body } = this._ensureSuccess("getMyAds", response);
    if (!Array.isArray(body?.ads)) throw new Error("getMyAds: unerwartetes Antwortformat.");
    return (body.ads || []).slice(0, safeLimit).map(a => ({
      id:       a.id,
      title:    a.title,
      price:    a.priceAmount,
      status:   a.adStatus,
      views:    a.pageViewCount,
      category: a.categoryTreePath || "",
      link:     a.seoLink ? `https://www.kleinanzeigen.de${a.seoLink}` : "",
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
    if (fileBuffer.length > 12 * 1024 * 1024) throw new Error("uploadImage: Bild ist größer als 12 MB.");
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
    this._requireCookieSession();
    const normalizedTitle = String(title || "").trim();
    const normalizedDescription = String(description || "").trim();
    if (!normalizedTitle) throw new Error("createAd: Titel fehlt.");
    if (normalizedTitle.length > 65) throw new Error("createAd: Titel darf maximal 65 Zeichen lang sein.");
    if (!normalizedDescription) throw new Error("createAd: Beschreibung fehlt.");
    if (normalizedDescription.length > 4000) throw new Error("createAd: Beschreibung darf maximal 4000 Zeichen lang sein.");
    if (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0) throw new Error("createAd: categoryId ist ungültig.");
    if (!Number.isInteger(Number(price)) || Number(price) < 0) throw new Error("createAd: Preis muss eine ganze EUR-Zahl sein.");
    if (zipCode && !/^\d{5}$/.test(String(zipCode))) throw new Error("createAd: PLZ muss aus 5 Ziffern bestehen.");
    if (String(contactName || "").length > 30) throw new Error("createAd: Kontaktname darf maximal 30 Zeichen lang sein.");
    const normalizedPriceType = validatePriceType(priceType);
    const normalizedImageUrls = validateImageUrls(imageUrls);
    const normalizedAttributes = validateAttributes(attributes);
    const csrfToken = this._extractCsrfToken();
    if (!csrfToken) throw new Error("CSRF-TOKEN nicht in Cookies. Bitte 'node scripts/login.js' ausführen.");

    const fields = {
      adType: "OFFER", title: normalizedTitle, description: normalizedDescription,
      categoryId: String(categoryId), priceAmount: String(Math.round(price)),
      priceType: normalizedPriceType, buyNowEligible: "false",
      zipCode: zipCode || "", locationId: locationId || "", contactName: contactName || "",
      adId: "", trackingId: crypto.randomUUID(), postAdWenkseSessionId: crypto.randomUUID(),
      _csrf: csrfToken,
    };
    for (const [key, value] of Object.entries(normalizedAttributes)) fields[`attributeMap[${key}]`] = value;
    normalizedImageUrls.forEach((url, i) => { fields[`adImages[${i}].url`] = url; });

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
    if (!/^\d+$/.test(String(adId || ""))) throw new Error("adId fehlt oder ist ungültig.");
    const normalizedAdId = String(adId);
    const { status, body } = await this._csrfWwwRequest("POST", `/m-anzeigen-loeschen.json?ids=${encodeURIComponent(normalizedAdId)}`, null, {
      "Accept":  "application/json, text/plain, */*",
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html?tab=PROJECTS",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteAd fehlgeschlagen (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    return { deleted: normalizedAdId, status };
  }

  /** Save a KA draft after runtime approval. Returns draftId.
   *  imageUrls from uploadImage({ forDraft: true }) are attached to the draft. */
  async saveDraft({ title = "", description = "", categoryId = null, priceAmount = null, priceType = "NEGOTIABLE", adType = "OFFER", zipCode = "", locationId = "", imageUrls = [], attributes = {} } = {}) {
    this._requireCookieSession();
    const userId = this._requireUserId();
    if (String(title).length > 65) throw new Error("saveDraft: Titel darf maximal 65 Zeichen lang sein.");
    if (String(description).length > 4000) throw new Error("saveDraft: Beschreibung darf maximal 4000 Zeichen lang sein.");
    if (zipCode && !/^\d{5}$/.test(String(zipCode))) throw new Error("saveDraft: PLZ muss aus 5 Ziffern bestehen.");
    const normalizedImageUrls = validateImageUrls(imageUrls);
    const normalizedAttributes = validateAttributes(attributes);
    const normalizedPriceType = validatePriceType(priceType);
    if (categoryId !== null && (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0)) {
      throw new Error("saveDraft: categoryId ist ungültig.");
    }
    if (priceAmount !== null && (!Number.isInteger(Number(priceAmount)) || Number(priceAmount) < 0)) {
      throw new Error("saveDraft: priceAmount muss eine ganze EUR-Zahl sein.");
    }
    const body = {
      adType, title, description, priceType: normalizedPriceType,
      zipCode:    zipCode    || "",
      locationId: locationId || "",
      ...(categoryId  !== null ? { categoryId:  Number(categoryId)      } : {}),
      ...(priceAmount !== null ? { priceAmount: Math.round(priceAmount) } : {}),
      ...(Object.keys(normalizedAttributes).length ? { attributeMap: normalizedAttributes } : {}),
      ...(normalizedImageUrls.length ? { adImages: normalizedImageUrls } : {}),
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
    return { draftId, imageCount: normalizedImageUrls.length };
  }

  async getDrafts() {
    this._requireCookieSession();
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
      priceAmount: d.priceAmount,
      description: d.description,
      images:      d.adImages?.length || 0,
      expiresAt:   d.expiryDate,
    }));
  }

  async deleteDraft(draftId) {
    this._requireCookieSession();
    const userId = this._requireUserId();
    if (!draftId || String(draftId).length > 200) throw new Error("draftId fehlt oder ist ungültig.");
    const { status } = await this._csrfWwwRequest("DELETE", `/users/${userId}/ad-drafts/${encodeURIComponent(draftId)}.json`, null, {
      "Referer": "https://www.kleinanzeigen.de/m-meine-anzeigen.html",
    });
    if (status !== 200 && status !== 204)
      throw new Error(`deleteDraft fehlgeschlagen (${status})`);
    return { deleted: draftId };
  }

}

module.exports = KleinanzeigenClient;
module.exports.accessResponseError = accessResponseError;
module.exports.mergeCookieHeader = mergeCookieHeader;
