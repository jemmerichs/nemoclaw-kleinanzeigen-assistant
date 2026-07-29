"use strict";

const {
  closeNativeProfile,
  openNativeProfile,
} = require("./vinted-auth");

const VINTED_ORIGIN = "https://www.vinted.de";
const DEFAULT_TIMEOUT_MS = 30_000;
const CONDITION_LABELS = new Set([
  "New with tags",
  "New without tags",
  "Very good",
  "Good",
  "Satisfactory",
  "Not fully functional",
]);
// These exact IDs were observed in the current laptop sell form (5/10/20 kg).
// Other categories fail closed until their current controls have been sampled.
const PACKAGE_TYPE_IDS = new Set([8, 9, 10]);

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clientError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function boundedText(value, label, { min = 0, max }) {
  const normalized = String(value || "").trim();
  if (normalized.length < min) throw new Error(`${label} fehlt oder ist zu kurz.`);
  if (normalized.length > max) throw new Error(`${label} darf maximal ${max} Zeichen lang sein.`);
  return normalized;
}

function normalizeAttributes(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attributes muss ein Objekt sein.");
  }
  const entries = Object.entries(value);
  if (entries.length > 30) throw new Error("Maximal 30 Vinted-Attribute sind erlaubt.");
  const attributes = {};
  for (const [key, rawValue] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,99}$/i.test(key)) {
      throw new Error(`Ungültiger Vinted-Attributname: ${key}`);
    }
    const normalizedValue = boundedText(rawValue, `Attribut ${key}`, { min: 1, max: 200 });
    attributes[key] = normalizedValue;
  }
  return attributes;
}

function normalizeListingArgs(rawArgs, { draft = false } = {}) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const title = boundedText(args.title, "Titel", { min: draft ? 0 : 1, max: 100 });
  const description = boundedText(args.description, "Beschreibung", { min: draft ? 0 : 1, max: 5_000 });
  const category = boundedText(args.category, "Kategorie", { min: draft ? 0 : 1, max: 120 });
  const categoryPath = boundedText(args.categoryPath, "Kategoriepfad", { min: draft ? 0 : 1, max: 300 });
  const brand = args.brand === undefined || args.brand === null
    ? ""
    : boundedText(args.brand, "Marke", { min: 0, max: 120 });
  const condition = boundedText(args.condition, "Zustand", { min: draft ? 0 : 1, max: 80 });
  if (condition && !CONDITION_LABELS.has(condition)) {
    throw new Error(`Unbekannter Vinted-Zustand: ${condition}`);
  }
  const price = Number(args.price);
  if ((!draft || args.price !== undefined) && (!Number.isFinite(price) || price < 0.01 || price > 999_999.99)) {
    throw new Error("Preis muss zwischen 0,01 und 999.999,99 EUR liegen.");
  }
  const packageTypeId = args.packageTypeId === undefined || args.packageTypeId === null
    ? null
    : Number(args.packageTypeId);
  if (packageTypeId !== null && (!Number.isInteger(packageTypeId) || !PACKAGE_TYPE_IDS.has(packageTypeId))) {
    throw new Error("Vinted-Paketgrößen-ID ist ungültig.");
  }
  const imagePaths = Array.isArray(args.imagePaths)
    ? args.imagePaths.map(value => boundedText(value, "Bildpfad", { min: 1, max: 1_000 }))
    : [];
  if (imagePaths.length > 20) throw new Error("Vinted erlaubt maximal 20 Bilder.");
  if (!draft && imagePaths.length === 0) throw new Error("Eine Vinted-Anzeige braucht mindestens ein Bild.");
  if (draft && !title && !description && !category && imagePaths.length === 0) {
    throw new Error("Ein Vinted-Entwurf braucht mindestens Titel, Beschreibung, Kategorie oder ein Bild.");
  }
  return {
    ...args,
    title,
    description,
    category,
    categoryPath,
    brand,
    condition,
    price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    packageTypeId,
    imagePaths,
    attributes: normalizeAttributes(args.attributes),
  };
}

function parseEuro(rawValue) {
  const compact = String(rawValue || "").replace(/[^\d.,-]/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  const lastSeparator = Math.max(lastComma, lastDot);
  const decimalDigits = lastSeparator >= 0 ? compact.length - lastSeparator - 1 : 0;
  const repeatedSeparator = lastSeparator >= 0
    && compact.slice(0, lastSeparator).includes(compact[lastSeparator]);
  const decimalSeparator = lastSeparator >= 0
    && (decimalDigits === 1 || decimalDigits === 2)
    ? compact[lastSeparator]
    : null;
  let normalized;
  if (decimalSeparator) {
    const whole = compact.slice(0, lastSeparator).replace(/[.,]/g, "");
    normalized = `${whole}.${compact.slice(lastSeparator + 1)}`;
  } else {
    normalized = compact.replace(/[.,]/g, "");
  }
  if (repeatedSeparator && decimalDigits === 3) normalized = compact.replace(/[.,]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function metadataValue(label, key, followingKeys) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedFollowing = followingKeys
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const match = String(label || "").match(
    new RegExp(`,\\s*${escapedKey}:\\s*(.*?)(?=,\\s*(?:${escapedFollowing}):|,\\s*€|$)`, "i")
  );
  return match ? match[1].trim() : "";
}

function parseProductCard(raw) {
  const link = String(raw?.link || "");
  const id = (link.match(/\/items\/(\d+)(?:-|[/?]|$)/) || [])[1] || "";
  if (!id) return null;
  const label = String(raw?.label || "");
  const titleBoundary = label.search(/,\s*(?:brand|model|condition|size):|,\s*€/i);
  const title = (titleBoundary >= 0 ? label.slice(0, titleBoundary) : label).trim();
  const priceMatches = [
    ...label.matchAll(/(?:€\s*(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s*€)/g),
  ];
  const price = priceMatches.length ? parseEuro(priceMatches[0][1] || priceMatches[0][2]) : null;
  const cleanLink = (() => {
    try {
      const url = new URL(link, VINTED_ORIGIN);
      url.search = "";
      return url.toString();
    } catch {
      return link;
    }
  })();
  return {
    id,
    title,
    brand: metadataValue(label, "brand", ["model", "condition", "size"]),
    model: metadataValue(label, "model", ["condition", "size"]),
    condition: metadataValue(label, "condition", ["size"]),
    size: metadataValue(label, "size", []),
    price,
    promoted: /(?:^|,\s*)(?:Bumped|Promoted)(?:,|$)/i.test(label),
    imageUrl: String(raw?.imageUrl || ""),
    link: cleanLink,
    visibleDetails: Array.isArray(raw?.details)
      ? raw.details.map(value => String(value || "").trim()).filter(Boolean).slice(0, 10)
      : [],
  };
}

async function extractProductCards(page, limit = 20) {
  const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 20 });
  const rows = await page.evaluate(maxItems => {
    const cards = Array.from(document.querySelectorAll('[data-testid^="product-item-id-"]'))
      .filter(element => /^product-item-id-\d+$/.test(element.getAttribute("data-testid") || ""))
      .slice(0, maxItems);
    return cards.map(card => {
      const link = card.querySelector('a[data-testid$="--overlay-link"]');
      const image = card.querySelector('img[data-testid$="--image--img"]');
      return {
        link: link?.href || "",
        label: link?.getAttribute("title") || image?.getAttribute("alt") || "",
        imageUrl: image?.src || "",
        details: Array.from(card.querySelectorAll("p")).slice(0, 10).map(item => item.textContent || ""),
      };
    });
  }, safeLimit);
  return rows.map(parseProductCard).filter(Boolean);
}

function normalizeConversationPath(value) {
  const path = String(value || "").trim();
  if (!/^\/inbox\/[A-Za-z0-9][A-Za-z0-9_/?=&.-]{0,500}$/.test(path)) {
    throw new Error("Vinted-Konversationspfad ist ungültig.");
  }
  return path;
}

async function uniqueVisible(locator, label, timeoutMs) {
  await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`${label} ist in der aktuellen Vinted-Oberfläche nicht eindeutig sichtbar.`);
  }
  return locator;
}

async function clickOptionalPickerSave(page, timeoutMs, context) {
  const saveButtons = page.getByRole("button", { name: "Save", exact: true });
  const visible = [];
  for (let index = 0; index < await saveButtons.count(); index++) {
    if (await saveButtons.nth(index).isVisible()) visible.push(saveButtons.nth(index));
  }
  if (!visible.length) return;
  if (visible.length !== 1) {
    throw new Error(`Vinted-Speichern für ${context} ist nicht eindeutig.`);
  }
  const save = visible[0];
  await save.waitFor({ state: "visible", timeout: timeoutMs });
  if (!await save.isEnabled()) throw new Error(`Vinted-Wert für ${context} wurde nicht übernommen.`);
  await save.click();
}

class VintedClient {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headless = false,
    userId = process.env.VINTED_USER_ID,
    openProfile = openNativeProfile,
    closeProfile = closeNativeProfile,
  } = {}) {
    this.timeoutMs = clampInteger(timeoutMs, { min: 5_000, max: 120_000, fallback: DEFAULT_TIMEOUT_MS });
    this.headless = Boolean(headless);
    this.userId = /^\d+$/.test(String(userId || "")) ? String(userId) : "";
    this.openProfile = openProfile;
    this.closeProfile = closeProfile;
  }

  async _withPage(targetUrl, task) {
    let nativeProfile;
    try {
      nativeProfile = await this.openProfile({ headless: this.headless, url: "about:blank" });
      const page = nativeProfile.page;
      const response = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      const status = response?.status() || 0;
      const title = await page.title().catch(() => "");
      if (status === 403 || status === 429 || /(?:just a moment|please wait)/i.test(title)) {
        throw clientError(
          "VINTED_ACCESS_DENIED",
          "Vinted hat den Browserzugriff angehalten. Keine automatische Wiederholung; dediziertes Profil normal öffnen und Netzwerkpfad prüfen.",
          { status }
        );
      }
      if (/\/member\/(?:general\/login|signup)/.test(page.url())) {
        throw clientError(
          "VINTED_SESSION_EXPIRED",
          "Vinted-Sitzung ist abgelaufen. Bitte 'npm run login:vinted' ausführen."
        );
      }
      return await task(page, { status, title });
    } finally {
      if (nativeProfile) await this.closeProfile(nativeProfile);
    }
  }

  async getCurrentUser() {
    const targetUrl = this.userId
      ? `${VINTED_ORIGIN}/member/${this.userId}`
      : `${VINTED_ORIGIN}/`;
    return this._withPage(targetUrl, async page => {
      if (this.userId) {
        const heading = page.getByRole("heading", { level: 1 }).first();
        await heading.waitFor({ state: "visible", timeout: this.timeoutMs });
        const login = String(await heading.innerText()).trim();
        if (!login) {
          throw new Error("Vinted-Profilname konnte nicht aus der angemeldeten Oberfläche gelesen werden.");
        }
        return {
          id: this.userId,
          login,
          profilePath: `/member/${this.userId}`,
        };
      }
      const menu = page.getByTestId("user-menu-button");
      await menu.waitFor({ state: "visible", timeout: this.timeoutMs });
      const login = await menu.locator("img").getAttribute("alt") || "";
      await menu.click();
      const profileLink = page.locator('a[href^="/member/"]').filter({ hasText: "Profile" });
      await profileLink.waitFor({ state: "visible", timeout: this.timeoutMs });
      const href = await profileLink.getAttribute("href") || "";
      const id = (href.match(/^\/member\/(\d+)/) || [])[1] || "";
      if (!id) throw new Error("Vinted-Profil-ID konnte nicht aus der angemeldeten Oberfläche gelesen werden.");
      this.userId = id;
      return { id, login, profilePath: href };
    });
  }

  async searchAds({ keyword = "", catalogId = null, page = 1, limit = 10 } = {}) {
    const normalizedKeyword = boundedText(keyword, "Suchbegriff", { min: 1, max: 200 });
    const safePage = clampInteger(page, { min: 1, max: 100, fallback: 1 });
    const safeLimit = clampInteger(limit, { min: 1, max: 50, fallback: 10 });
    let catalogPath = "/catalog";
    if (catalogId !== null && catalogId !== undefined && catalogId !== "") {
      const normalizedCatalogId = Number(catalogId);
      if (!Number.isInteger(normalizedCatalogId) || normalizedCatalogId < 1 || normalizedCatalogId > 100_000) {
        throw new Error("catalogId ist ungültig.");
      }
      catalogPath = `/catalog/${normalizedCatalogId}`;
    }
    const params = new URLSearchParams({ search_text: normalizedKeyword });
    if (safePage > 1) params.set("page", String(safePage));
    return this._withPage(`${VINTED_ORIGIN}${catalogPath}?${params}`, async pageObject => {
      const cards = pageObject.locator('[data-testid^="product-item-id-"]');
      await Promise.race([
        cards.first().waitFor({ state: "attached", timeout: this.timeoutMs }),
        pageObject.getByText("0 results.", { exact: true }).waitFor({ state: "visible", timeout: this.timeoutMs }),
      ]).catch(() => {});
      const results = await extractProductCards(pageObject, safeLimit);
      if (!results.length) {
        const mainText = await pageObject.locator("main").innerText().catch(() => "");
        if (!/(?:0 results|no items)/i.test(mainText)) {
          throw new Error("Vinted-Suche lieferte ein unerwartetes Seitenformat.");
        }
      }
      return results;
    });
  }

  async getMyItems({ limit = 50 } = {}) {
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 50 });
    if (!this.userId) {
      const current = await this.getCurrentUser();
      this.userId = current.id;
    }
    return this._withPage(`${VINTED_ORIGIN}/member/${this.userId}`, async page => {
      await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: this.timeoutMs });
      const rows = await extractProductCards(page, safeLimit);
      if (!rows.length) {
        const empty = await page.getByRole("heading", {
          name: "List items to start selling",
          exact: true,
        }).count();
        if (!empty) {
          throw new Error("Das Vinted-Profil lieferte keine eindeutig erkennbare Artikel- oder Leeransicht.");
        }
      }
      return rows.map(item => ({ ...item, status: "active" }));
    });
  }

  async getConversations({ limit = 30 } = {}) {
    const safeLimit = clampInteger(limit, { min: 1, max: 100, fallback: 30 });
    return this._withPage(`${VINTED_ORIGIN}/inbox`, async page => {
      await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor({
        state: "visible",
        timeout: this.timeoutMs,
      });
      const empty = await page.getByText("No messages yet", { exact: true }).count();
      if (empty) return [];
      const rows = await page.evaluate(maxItems => {
        return Array.from(document.querySelectorAll('main a[href^="/inbox/"]'))
          .slice(0, maxItems)
          .map(link => ({
            path: link.getAttribute("href") || "",
            preview: (link.textContent || "").trim().replace(/\s+/g, " ").slice(0, 1_000),
            ariaLabel: link.getAttribute("aria-label") || "",
            testId: link.getAttribute("data-testid") || "",
          }));
      }, safeLimit);
      if (!rows.length) throw new Error("Vinted-Inbox hat ein unerwartetes Seitenformat.");
      return rows.map(row => ({
        conversationPath: normalizeConversationPath(row.path),
        preview: row.preview,
        unread: /unread/i.test(`${row.ariaLabel} ${row.testId}`),
      }));
    });
  }

  async _selectCategory(page, category, categoryPath) {
    const input = await uniqueVisible(
      page.locator('input[name="category"]:visible'),
      "Vinted-Kategoriefeld",
      this.timeoutMs
    );
    await input.click();
    const search = await uniqueVisible(
      page.locator('input[name="catalog-search-input"]:visible'),
      "Vinted-Kategoriesuche",
      this.timeoutMs
    );
    await search.fill(category);
    const accessibleName = `${category} ${categoryPath}`;
    const option = page.getByRole("button", { name: accessibleName, exact: true });
    await option.waitFor({ state: "visible", timeout: this.timeoutMs });
    if (await option.count() !== 1) {
      throw new Error(`Vinted-Kategorie ist nicht eindeutig: ${accessibleName}`);
    }
    await option.click();
    await clickOptionalPickerSave(page, this.timeoutMs, "Kategorie");
  }

  async _selectBrand(page, brand) {
    const loader = page.locator('[role="progressbar"]:visible');
    if (await loader.count()) {
      await loader.first().waitFor({ state: "hidden", timeout: this.timeoutMs });
    }
    const input = await uniqueVisible(
      page.locator('input[name="brand"]:visible'),
      "Vinted-Markenfeld",
      this.timeoutMs
    );
    await input.click();
    const optionName = brand || "List without brand";
    if (brand) {
      const search = await uniqueVisible(
        page.locator('input[name="brand-search-input"]:visible'),
        "Vinted-Markensuche",
        this.timeoutMs
      );
      await search.fill(brand);
    }
    const option = page.getByRole("button", { name: optionName, exact: true });
    await option.waitFor({ state: "visible", timeout: this.timeoutMs });
    await option.click();
    await clickOptionalPickerSave(page, this.timeoutMs, "Marke");
  }

  async _selectDetail(page, fieldName, value) {
    const input = await uniqueVisible(
      page.locator(`input[name="${fieldName}"]:visible`),
      `Vinted-Feld '${fieldName}'`,
      this.timeoutMs
    );
    await input.click();
    const option = page.getByRole("button", { name: value, exact: true });
    await option.waitFor({ state: "visible", timeout: this.timeoutMs });
    if (await option.count() !== 1) {
      throw new Error(`Vinted-Wert '${value}' für '${fieldName}' ist nicht eindeutig.`);
    }
    await option.click();
    await clickOptionalPickerSave(page, this.timeoutMs, `'${fieldName}'`);
  }

  async _fillSellForm(page, args) {
    const title = await uniqueVisible(
      page.locator('input[name="title"]:visible'),
      "Vinted-Titelfeld",
      this.timeoutMs
    );
    if (args.imagePaths.length) {
      await page.getByTestId("add-photos-input").setInputFiles(args.imagePaths);
      await page.waitForTimeout(Math.min(5_000, 500 + args.imagePaths.length * 250));
    }
    if (args.title) await title.fill(args.title);
    if (args.description) {
      const description = await uniqueVisible(
        page.locator('textarea[name="description"]:visible'),
        "Vinted-Beschreibungsfeld",
        this.timeoutMs
      );
      await description.fill(args.description);
    }
    if (args.category) {
      await this._selectCategory(page, args.category, args.categoryPath);
      await this._selectBrand(page, args.brand);
    }
    for (const [fieldName, value] of Object.entries(args.attributes)) {
      await this._selectDetail(page, fieldName, value);
    }
    if (args.condition) await this._selectDetail(page, "condition", args.condition);
    if (args.price !== null) {
      const price = await uniqueVisible(
        page.locator('input[name="price"]:visible'),
        "Vinted-Preisfeld",
        this.timeoutMs
      );
      await price.fill(args.price.toFixed(2));
    }
    if (args.packageTypeId !== null) {
      const parcel = page.getByTestId(`package_type_selector_${args.packageTypeId}--input`);
      if (await parcel.count() !== 1) {
        throw new Error(`Paketgröße ${args.packageTypeId} ist für diese Kategorie nicht verfügbar.`);
      }
      await parcel.check();
    }
  }

  async _submitListing(rawArgs, { draft }) {
    const args = normalizeListingArgs(rawArgs, { draft });
    return this._withPage(`${VINTED_ORIGIN}/items/new`, async page => {
      await this._fillSellForm(page, args);
      const buttonTestId = draft
        ? "upload-form-save-draft-button"
        : "upload-form-save-button";
      const button = await uniqueVisible(
        page.locator(`button[data-testid="${buttonTestId}"]:visible`),
        `Vinted-${draft ? "Entwurfs-" : "Upload-"}Button`,
        this.timeoutMs
      );
      const enabled = await page.waitForFunction(testId => {
        const element = Array.from(document.querySelectorAll(`[data-testid="${testId}"]`))
          .find(candidate => candidate.getClientRects().length > 0);
        return Boolean(
          element
          && !element.disabled
          && element.getAttribute("aria-disabled") !== "true"
        );
      }, buttonTestId, { timeout: this.timeoutMs }).then(() => true).catch(() => false);
      if (!enabled) {
        throw new Error(`Vinted-${draft ? "Entwurf" : "Anzeige"} ist laut Formular noch unvollständig.`);
      }
      await button.click();
      await page.waitForTimeout(3_000);
      const url = page.url();
      const pageText = await page.locator("body").innerText().catch(() => "");
      const itemId = (url.match(/\/items\/(\d+)(?:-|[/?]|$)/) || [])[1] || "";
      const draftId = (
        url.match(/[?&](?:draft_id|draftId)=(\d+)/) ||
        url.match(/\/drafts?\/(\d+)(?:[/?]|$)/) ||
        []
      )[1] || "";
      if (draft && (draftId || /draft\s+(?:saved|created)/i.test(pageText))) {
        return {
          draftId: draftId || null,
          saved: true,
          imageCount: args.imagePaths.length,
          url,
        };
      }
      if (!draft && itemId) {
        return {
          id: itemId,
          link: `${VINTED_ORIGIN}${new URL(url).pathname}`,
          imageCount: args.imagePaths.length,
        };
      }
      const visibleError = pageText.match(/(?:error|missing|required|invalid)[^\n]{0,300}/i)?.[0];
      if (visibleError) throw new Error(`Vinted-Formularfehler: ${visibleError}`);
      throw clientError(
        "VINTED_WRITE_AMBIGUOUS",
        `Vinted hat den ${draft ? "Entwurf" : "Upload"} nicht eindeutig bestätigt. Nicht automatisch wiederholen; zuerst Profil und Entwürfe manuell prüfen.`
      );
    });
  }

  async saveDraft(args) {
    return this._submitListing(args, { draft: true });
  }

  async createItem(args) {
    return this._submitListing(args, { draft: false });
  }

  async deleteItem(itemId) {
    const normalizedId = String(itemId || "").trim();
    if (!/^\d+$/.test(normalizedId)) throw new Error("Vinted-Artikel-ID ist ungültig.");
    return this._withPage(`${VINTED_ORIGIN}/items/${normalizedId}`, async page => {
      await page.locator("main").waitFor({ state: "visible", timeout: this.timeoutMs });
      const deleteControl = page.getByText("Delete", { exact: true });
      if (await deleteControl.count() !== 1) {
        throw clientError(
          "VINTED_UI_UNVERIFIED",
          "Vinted-Löschaktion ist in der aktuellen Oberfläche nicht eindeutig verfügbar."
        );
      }
      await deleteControl.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });
      const confirm = dialog.getByRole("button", { name: "Delete", exact: true });
      if (await confirm.count() !== 1) {
        throw clientError("VINTED_UI_UNVERIFIED", "Vinted-Löschbestätigung ist nicht eindeutig.");
      }
      await confirm.click();
      await page.waitForTimeout(1_000);
      if (/\/items\/\d+/.test(page.url())) {
        throw clientError(
          "VINTED_WRITE_AMBIGUOUS",
          "Vinted-Löschung wurde nicht eindeutig bestätigt. Nicht automatisch wiederholen; Profil prüfen."
        );
      }
      return { deleted: normalizedId };
    });
  }
}

module.exports = VintedClient;
module.exports.CONDITION_LABELS = CONDITION_LABELS;
module.exports.PACKAGE_TYPE_IDS = PACKAGE_TYPE_IDS;
module.exports.extractProductCards = extractProductCards;
module.exports.normalizeAttributes = normalizeAttributes;
module.exports.normalizeConversationPath = normalizeConversationPath;
module.exports.normalizeListingArgs = normalizeListingArgs;
module.exports.parseProductCard = parseProductCard;
