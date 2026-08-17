// Kleinanzeigen API client — cookie auth (www) + Bearer JWT (gateway)
"use strict";

const https  = require("https");
const { validateCategoryAttributes } = require("./kleinanzeigen-category-contracts");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const OIDC_ISSUER = "https://login.kleinanzeigen.de/";
const OIDC_HOSTNAME = "login.kleinanzeigen.de";
const OIDC_TOKEN_PATH = "/oauth/token";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";
const PRICE_TYPES = new Set(["FIXED", "NEGOTIABLE", "GIVE_AWAY"]);

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      try {
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : _match;
      } catch {
        return _match;
      }
    })
    .replace(/&(amp|quot|apos|lt|gt);/gi, (_match, entity) => ({
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
    })[String(entity).toLowerCase()]);
}

function sellerPriceAmount(value) {
  if (Number.isFinite(Number(value)) && String(value).trim() !== "") return Number(value);
  const match = decodeHtmlEntities(value).match(/\d[\d.]*?(?:,\d{1,2})?(?=\s*(?:€|EUR)(?:\s|$)|$)/i);
  if (!match) return null;
  const amount = Number(match[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
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

function accessTokenMetadata(token) {
  const payload = jwtPayload(token);
  if (!payload || payload.iss !== OIDC_ISSUER) return null;
  const clientId = String(payload.azp || "");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) return null;
  const expiresAt = Number(payload.exp);
  const issuedAt = Number(payload.iat);
  return {
    clientId,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    issuedAt: Number.isFinite(issuedAt) ? issuedAt : null,
    userId: Object.entries(payload).find(
      ([key, value]) =>
        (key === "user_id" || /\/user_id$/i.test(key)) &&
        /^\d+$/.test(String(value))
    )?.[1] || null,
  };
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

function parseListingValidationErrors(parsed) {
  const errors = [];
  const add = (rawField, rawMessage) => {
    const field = String(rawField || "").trim().slice(0, 300);
    const message = String(rawMessage || "").trim().slice(0, 500);
    if (!field && !message) return;
    if (!errors.some(entry => entry.field === field && entry.message === message)) {
      errors.push({ field, message });
    }
  };

  if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
    const errorIndex = parsed[0].errors;
    const references = Number.isInteger(errorIndex) && Array.isArray(parsed[errorIndex])
      ? parsed[errorIndex]
      : [];
    for (const reference of references) {
      const entry = Number.isInteger(reference) ? parsed[reference] : reference;
      if (!entry || typeof entry !== "object") continue;
      const rawField = Number.isInteger(entry.field) ? parsed[entry.field] : entry.field;
      const rawMessage = Number.isInteger(entry.message) ? parsed[entry.message] : entry.message;
      add(rawField, rawMessage);
    }
  }

  let visited = 0;
  const visit = (value, depth = 0) => {
    if (depth > 8 || visited++ > 300 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const field = value.field ?? value.propertyPath ?? value.path ?? value.fieldName;
    const message = value.message ?? value.defaultMessage ?? value.errorMessage;
    if (
      field !== undefined
      && message !== undefined
      && !Number.isInteger(field)
      && !Number.isInteger(message)
    ) add(field, message);
    for (const key of ["errors", "validationErrors", "violations", "fieldErrors"]) {
      const nested = value[key];
      if (!nested || Array.isArray(nested) || typeof nested !== "object") continue;
      for (const [nestedField, nestedMessage] of Object.entries(nested)) {
        if (typeof nestedMessage === "string") add(nestedField, nestedMessage);
        else if (Array.isArray(nestedMessage)) {
          for (const entry of nestedMessage) {
            if (typeof entry === "string") add(nestedField, entry);
          }
        }
      }
    }
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  visit(parsed);
  return errors.slice(0, 20);
}

function listingValidationError(parsed, categoryId, status = null) {
  const validationErrors = parseListingValidationErrors(parsed);
  if (!validationErrors.length) return null;
  const fieldNames = validationErrors.map(error => error.field);
  const recoveryAreas = [
    fieldNames.some(field => /(?:attributeMap|categoryId)/i.test(field)) ? "category" : null,
    fieldNames.some(field => /(?:zipCode|location(?:Id)?|postal|street|address)/i.test(field)) ? "location" : null,
    fieldNames.some(field => /contactName/i.test(field)) ? "profile" : null,
  ].filter(Boolean);
  if (!recoveryAreas.length) recoveryAreas.push("listing");
  const details = validationErrors
    .map(error => [error.field, error.message].filter(Boolean).join(": "))
    .join("; ");
  const error = clientError(
    "KA_LISTING_VALIDATION",
    `Kleinanzeigen-Formularvalidierung fehlgeschlagen: ${details}`,
    status
  );
  error.categoryId = Number(categoryId);
  error.validationErrors = validationErrors;
  error.recoveryAreas = recoveryAreas;
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
    // The cookie header is the canonical, atomically persisted session. A
    // separately configured bearer exists only for legacy sessions and must
    // never override a newer access_token imported or refreshed in KA_COOKIES.
    this.bearerToken  = at ? at[1].trim() : (bearerToken || null);
    this.refreshToken = refreshToken || (rt ? rt[1].trim() : null);

    // user_id: prefer cookie, fall back to JWT payload
    const uid = cookieString.match(/(?:^|;\s*)user_id=(\d+)/);
    if (uid) {
      this.userId = uid[1];
    } else if (this.bearerToken) {
      this.userId = String(accessTokenMetadata(this.bearerToken)?.userId || "") || null;
    } else {
      this.userId = null;
    }
  }

  accessTokenExpiresWithin(seconds = 300) {
    const metadata = accessTokenMetadata(this.bearerToken);
    if (!metadata?.expiresAt) return false;
    return metadata.expiresAt <= Math.floor(Date.now() / 1000) + Math.max(0, Number(seconds) || 0);
  }

  _requireCookieSession() {
    if (!this.cookies) throw new Error("KA_COOKIES fehlt. Bitte 'npm run login' ausführen.");
    if (this.bearerToken && this.accessTokenExpiresWithin(60)) {
      throw clientError(
        "KA_SESSION_EXPIRED",
        "Die private Kleinanzeigen-Sitzung ist abgelaufen und muss vor dem Request erneuert werden.",
        401
      );
    }
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
    if (this.accessTokenExpiresWithin(60)) {
      throw clientError("KA_BEARER_EXPIRED", "Bearer token abgelaufen (lokale Ablaufprüfung).", 401);
    }
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

  async searchAds({ keyword = "", categoryId, categorySlug, page = 1, limit = 10 } = {}) {
    const normalizedKeyword = String(keyword).trim();
    const safePage = clampInteger(page, { min: 1, max: 100, fallback: 1 });
    const safeLimit = clampInteger(limit, { min: 1, max: 50, fallback: 10 });
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
    return (body.ads || []).slice(0, safeLimit).map(a => {
      const rawLink = String(a.seoLink || a.seoUrl || "");
      const categoryId = Number(a.categoryId || a.l2Category);
      const imageCount = Number(a.imageCount ?? a.images);
      return {
        id: a.id,
        title: decodeHtmlEntities(a.title),
        price: sellerPriceAmount(a.priceAmount ?? a.price),
        priceType: a.priceType || a.adPriceType,
        status: a.adStatus || a.state,
        views: a.pageViewCount ?? a.viewCount,
        ...(Number.isInteger(imageCount) && imageCount >= 0 ? { images: imageCount } : {}),
        ...(Number.isInteger(categoryId) && categoryId > 0 ? { categoryId } : {}),
        category: decodeHtmlEntities(a.categoryTreePath || a.category || ""),
        link: /^https:\/\/www\.kleinanzeigen\.de\//i.test(rawLink)
          ? rawLink
          : rawLink.startsWith("/")
            ? `https://www.kleinanzeigen.de${rawLink}`
            : "",
      };
    });
  }

  async getAdBundles() {
    const response = await this._gatewayRequest("GET", "/private-bundles/me/ads/bundles");
    return this._ensureSuccess("getAdBundles", response).body;
  }

  _extractCsrfToken() {
    const match = this.cookies.match(/(?:^|;\s*)CSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1].trim()) : null;
  }

  _oidcTokenRequest(form) {
    return new Promise((resolve, reject) => {
      const data = new URLSearchParams(form).toString();
      const options = {
        hostname: OIDC_HOSTNAME,
        path: OIDC_TOKEN_PATH,
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": this.userAgent,
          "Accept-Language": this.acceptLanguage,
        },
      };
      let req;
      req = https.request(options, res => this._collectResponse(req, res, resolve, reject));
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("POST login.kleinanzeigen.de/oauth/token: Timeout")));
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  async refreshAccessToken() {
    const metadata = accessTokenMetadata(this.bearerToken);
    if (!metadata?.clientId || !this.refreshToken) {
      throw clientError(
        "KA_REFRESH_EXPIRED",
        "Die Kleinanzeigen-Sitzung enthält keinen nutzbaren OIDC-Refresh-Kontext. Bitte einmal 'npm run login' ausführen.",
        401
      );
    }
    const previousRefreshToken = this.refreshToken;
    const response = await this._oidcTokenRequest({
      grant_type: "refresh_token",
      client_id: metadata.clientId,
      refresh_token: this.refreshToken,
    });
    if (response.status !== 200) {
      if (response.status === 403 || response.status === 429) {
        throw clientError(
          "KA_ACCESS_DENIED",
          `Der Kleinanzeigen-Login-Dienst hat den einmaligen Session-Refresh abgelehnt oder gedrosselt (HTTP ${response.status}).`,
          response.status
        );
      }
      throw clientError(
        response.status === 400 || response.status === 401 ? "KA_REFRESH_EXPIRED" : "KA_REFRESH_FAILED",
        response.status === 400 || response.status === 401
          ? "Der Kleinanzeigen-Refresh-Token wurde abgelehnt. Bitte einmal 'npm run login' ausführen."
          : `Die Kleinanzeigen-Sitzung konnte nicht erneuert werden (HTTP ${response.status}).`,
        response.status
      );
    }
    const accessToken = String(response.body?.access_token || "");
    const refreshedMetadata = accessTokenMetadata(accessToken);
    if (
      !refreshedMetadata?.expiresAt
      || refreshedMetadata.expiresAt <= Math.floor(Date.now() / 1000) + 60
      || refreshedMetadata.clientId !== metadata.clientId
      || (metadata.userId && refreshedMetadata.userId && String(refreshedMetadata.userId) !== String(metadata.userId))
    ) {
      throw clientError(
        "KA_REFRESH_EXPIRED",
        "Kleinanzeigen hat beim Session-Refresh keinen gültigen neuen Access-Token geliefert.",
        502
      );
    }
    const nextRefreshToken = String(response.body?.refresh_token || this.refreshToken);
    this.bearerToken = accessToken;
    this.refreshToken = nextRefreshToken;
    this.userId = String(refreshedMetadata.userId || this.userId || "") || null;
    this.cookies = mergeCookieHeader(this.cookies, [
      `access_token=${accessToken}; Path=/; Secure`,
      `refresh_token=${nextRefreshToken}; Path=/; Secure`,
    ]);
    return {
      expiresAt: new Date(refreshedMetadata.expiresAt * 1000).toISOString(),
      refreshTokenRotated: nextRefreshToken !== previousRefreshToken,
    };
  }

  async refreshCsrfCookie() {
    const response = await this._wwwRequest("GET", "/p-anzeige-aufgeben-schritt2.html");
    this._ensureSuccess("refreshCsrfCookie", response);
    const csrf = this._extractCsrfToken();
    if (!csrf) throw clientError("KA_CSRF_EXPIRED", "CSRF-TOKEN wurde beim Session-Refresh nicht erneuert.", 401);
    return csrf;
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
    validateCategoryAttributes(categoryId, normalizedAttributes, { requireRequired: false });
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
module.exports.accessTokenMetadata = accessTokenMetadata;
module.exports.accessResponseError = accessResponseError;
module.exports.listingValidationError = listingValidationError;
module.exports.mergeCookieHeader = mergeCookieHeader;
module.exports.parseListingValidationErrors = parseListingValidationErrors;
