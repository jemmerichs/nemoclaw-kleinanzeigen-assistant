"use strict";

const {
  assertNetworkAccess,
  closeNativeProfile,
  openNativeProfile,
} = require("./auth");
const {
  getCategoryRequirements,
  validateCategoryAttributes,
} = require("./kleinanzeigen-category-contracts");
const { listingValidationError } = require("./kleinanzeigen");
const {
  FORM_URL,
  ensureCategoryBrowserSession,
  openCategoryPicker,
  selectCategoryPath,
} = require("./kleinanzeigen-form");
const {
  assertBoundFormState,
  captureVisibleFormState,
} = require("./kleinanzeigen-form-state");

const FORM_TIMEOUT_MS = 60_000;
const PRICE_TYPE_LABELS = {
  FIXED: "Festpreis",
  NEGOTIABLE: "VB",
  GIVE_AWAY: "Zu verschenken",
};

function categoryPathFromContract(contract) {
  const categoryPath = String(contract?.category || "")
    .split(/\s*>\s*/)
    .map(value => value.trim())
    .filter(Boolean);
  if (!categoryPath.length) {
    throw new Error("Der verifizierte Kategorievertrag enthält keinen sichtbaren Kategoriepfad.");
  }
  return categoryPath;
}

function normalizeSubmissionPath(value) {
  let url;
  try {
    url = new URL(String(value || ""), "https://www.kleinanzeigen.de");
  } catch {
    throw new Error("Das aktuelle Anzeigenformular enthält kein gültiges Publish-Ziel.");
  }
  if (
    url.origin !== "https://www.kleinanzeigen.de"
    || !url.pathname.startsWith("/post-listing/")
    || url.pathname.includes("..")
    || url.username
    || url.password
  ) {
    throw new Error("Das aktuelle Anzeigenformular enthält kein zulässiges Publish-Ziel.");
  }
  return `${url.pathname}${url.search}`;
}

async function inspectSubmissionPath(page) {
  const candidates = await page.locator("astro-island[props]").evaluateAll(islands => {
    const found = [];
    const visit = (value, depth = 0) => {
      if (depth > 12 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, depth + 1);
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === "actionUrl") {
          const decoded = Array.isArray(entry) && entry[0] === 0 ? entry[1] : entry;
          if (typeof decoded === "string") found.push(decoded);
        }
        visit(entry, depth + 1);
      }
    };
    for (const island of islands) {
      try { visit(JSON.parse(island.getAttribute("props") || "")); } catch {}
    }
    return found;
  });
  const paths = [...new Set(candidates.map(normalizeSubmissionPath))];
  if (paths.length !== 1) {
    throw new Error(
      paths.length
        ? "Das aktuelle Anzeigenformular enthält mehrere uneindeutige Publish-Ziele."
        : "Das aktuelle Anzeigenformular enthält kein erkennbares Publish-Ziel."
    );
  }
  return paths[0];
}

function firstFormValue(entries, name) {
  return entries.find(([key]) => key === name)?.[1];
}

function incompleteFormError(message) {
  const error = new Error(`${message} Es wurde nichts veröffentlicht.`);
  error.code = "KA_BROWSER_FORM_INCOMPLETE";
  error.definitiveNoWrite = true;
  return error;
}

function assertListingFormContract(entries, args, contract) {
  if (!Array.isArray(entries)) throw incompleteFormError("Der aktuelle Formularzustand ist nicht lesbar.");
  const expected = [
    ["title", String(args.title)],
    ["description", String(args.description)],
    ["categoryId", String(args.categoryId)],
    ["priceType", String(args.priceType)],
    ["zipCode", String(args.zipCode)],
    ["locationId", String(args.locationId)],
    ["contactName", String(args.contactName)],
  ];
  if (args.priceType !== "GIVE_AWAY") expected.push(["priceAmount", String(args.price)]);
  for (const [name, value] of expected) {
    if (firstFormValue(entries, name) !== value) {
      throw incompleteFormError(`Das sichtbare Anzeigenformular hat das Feld "${name}" nicht exakt übernommen.`);
    }
  }

  const allowedAttributes = new Set(
    (contract.requiredAttributes || []).map(field => field.key)
  );
  for (const [key, value] of Object.entries(args.attributes || {})) {
    if (!allowedAttributes.has(key)) {
      throw incompleteFormError(`Attribut "${key}" gehört nicht zum aktuell verifizierten Pflichtvertrag.`);
    }
    if (firstFormValue(entries, `attributeMap[${key}]`) !== String(value)) {
      throw incompleteFormError(`Das sichtbare Anzeigenformular hat das Pflichtattribut "${key}" nicht exakt übernommen.`);
    }
  }
  return true;
}

async function formEntries(page) {
  return page.locator("form").evaluate(form => (
    Array.from(new FormData(form).entries()).flatMap(([name, value]) => (
      typeof value === "string" ? [[name, value]] : []
    ))
  ));
}

async function selectPriceType(page, priceType) {
  const normalized = String(priceType || "");
  const hidden = page.locator('input[name="priceType"]');
  if (await hidden.count() !== 1) throw new Error("Das aktuelle Formular enthält keinen eindeutigen Preistyp.");
  if (await hidden.inputValue() === normalized) return;
  const label = PRICE_TYPE_LABELS[normalized];
  if (!label) throw new Error(`Unbekannter Preistyp: ${normalized}`);
  const combobox = page.getByRole("combobox", { name: /Preistyp$/ });
  if (await combobox.count() !== 1) throw new Error("Die Preistyp-Auswahl ist im aktuellen Formular nicht eindeutig.");
  await combobox.click();
  const option = page.getByRole("option", { name: label, exact: true });
  if (await option.count() !== 1) throw new Error(`Preistyp "${label}" ist im aktuellen Formular nicht verfügbar.`);
  await option.click();
  if (await hidden.inputValue() !== normalized) {
    throw new Error(`Preistyp "${label}" wurde vom aktuellen Formular nicht übernommen.`);
  }
}

async function selectVerifiedAttribute(page, field, value) {
  const inputName = `attributeMap[${field.key}]`;
  const controls = page.locator(`[name=${JSON.stringify(inputName)}]`);
  const count = await controls.count();
  if (!count) throw new Error(`Pflichtfeld "${field.key}" fehlt im aktuellen Anzeigenformular.`);
  const option = (field.values || []).find(candidate => candidate.value === String(value));
  if (!option && field.values?.length) {
    throw new Error(`Wert "${value}" ist für Pflichtfeld "${field.key}" nicht verifiziert.`);
  }
  const controlTypes = await controls.evaluateAll(nodes => nodes.map(node => ({
    tag: node.tagName,
    type: node.getAttribute("type") || "",
  })));

  if (controlTypes.some(control => control.type === "radio")) {
    const target = page.locator(
      `input[name=${JSON.stringify(inputName)}][value=${JSON.stringify(String(value))}]`
    );
    if (await target.count() !== 1) throw new Error(`Pflichtwert "${value}" ist im aktuellen Formular nicht eindeutig.`);
    const id = await target.getAttribute("id");
    const label = id ? page.locator(`label[for=${JSON.stringify(id)}]`) : null;
    if (label && await label.count() === 1) await label.click();
    else await target.click();
    if (!await target.isChecked()) throw new Error(`Pflichtwert "${value}" wurde nicht übernommen.`);
    return;
  }

  if (controlTypes.length === 1 && controlTypes[0].tag === "SELECT") {
    await controls.selectOption(String(value));
    if (await controls.inputValue() !== String(value)) throw new Error(`Pflichtwert "${value}" wurde nicht übernommen.`);
    return;
  }

  if (controlTypes.length === 1 && controlTypes[0].type === "hidden") {
    const button = page.locator(`button[id=${JSON.stringify(field.key)}]`);
    if (await button.count() !== 1 || !option?.label) {
      throw new Error(`Pflichtfeld "${field.key}" kann im sichtbaren Formular nicht sicher gesetzt werden.`);
    }
    await button.click();
    const visibleOption = page.getByRole("option", { name: option.label, exact: true });
    if (await visibleOption.count() !== 1) {
      throw new Error(`Pflichtwert "${option.label}" ist im aktuellen Formular nicht eindeutig.`);
    }
    await visibleOption.click();
    if (await controls.inputValue() !== String(value)) throw new Error(`Pflichtwert "${value}" wurde nicht übernommen.`);
    return;
  }

  throw new Error(`Pflichtfeld "${field.key}" verwendet eine nicht unterstützte sichtbare Steuerung.`);
}

async function uploadImagesInForm(page, imagePaths) {
  if (!imagePaths.length) return;
  const input = page.locator('input[type="file"]');
  if (await input.count() !== 1) throw new Error("Der Bild-Upload ist im aktuellen Anzeigenformular nicht eindeutig.");

  let completed = 0;
  let failedStatus = null;
  let settle;
  const uploadsDone = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const onResponse = response => {
    let pathname = "";
    try { pathname = new URL(response.url()).pathname; } catch {}
    if (pathname !== "/p-bild-hochladen.html") return;
    const status = response.status();
    if (status !== 200 && status !== 201) {
      failedStatus = status;
      settle.reject(new Error(`Kleinanzeigen hat einen Bild-Upload abgelehnt (HTTP ${status}).`));
      return;
    }
    completed++;
    if (completed >= imagePaths.length) settle.resolve();
  };
  page.on("response", onResponse);
  let timeout;
  try {
    await input.setInputFiles(imagePaths);
    await Promise.race([
      uploadsDone,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Die Bild-Uploads wurden nicht rechtzeitig bestätigt.")),
          FORM_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    error.code = error.code || "KA_BROWSER_IMAGE_UPLOAD_FAILED";
    error.status = failedStatus;
    error.definitiveNoWrite = true;
    throw error;
  } finally {
    clearTimeout(timeout);
    page.off("response", onResponse);
  }
}

function listingIdFromValue(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const fromQuery = (value.match(/[?&]adId=(\d+)/) || [])[1];
    if (fromQuery) return fromQuery;
    const fromRoute = (value.match(/\/s-anzeige\/(?:[^/?#]+\/)?(\d+)(?:[-/?#]|$)/) || [])[1];
    return fromRoute || "";
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = listingIdFromValue(entry, depth + 1);
      if (id) return id;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["adId", "listingId"]) {
      if (/^\d+$/.test(String(value[key] || ""))) return String(value[key]);
    }
    if (depth === 0 && /^\d+$/.test(String(value.id || ""))) return String(value.id);
    for (const entry of Object.values(value)) {
      const id = listingIdFromValue(entry, depth + 1);
      if (id) return id;
    }
  }
  return "";
}

function publishedListingResult({ body, pageUrl = "", location = "" } = {}) {
  const id = listingIdFromValue(pageUrl)
    || listingIdFromValue(location)
    || listingIdFromValue(body);
  if (!id) return null;
  return { id, link: `https://www.kleinanzeigen.de/s-anzeige/${id}` };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text.slice(0, 20_000); }
}

async function publishListingViaForm(args, { cookieHeader, onPhase = null } = {}) {
  const contract = getCategoryRequirements(args.categoryId);
  if (!contract.verified) {
    const error = new Error(`Kategorie ${args.categoryId} ist nicht aktuell verifiziert.`);
    error.code = "KA_CATEGORY_INSPECTION_INCOMPLETE";
    error.categoryId = Number(args.categoryId);
    error.definitiveNoWrite = true;
    throw error;
  }
  validateCategoryAttributes(args.categoryId, args.attributes, {
    requireRequired: true,
    requireVerified: true,
  });
  const categoryPath = categoryPathFromContract(contract);
  let nativeProfile;
  let publishRequestStarted = false;
  try {
    nativeProfile = await openNativeProfile({ headless: false });
    const { context, page } = nativeProfile;
    await ensureCategoryBrowserSession(context, cookieHeader);
    const initialResponse = await page.goto(FORM_URL, {
      waitUntil: "domcontentloaded",
      timeout: FORM_TIMEOUT_MS,
    });
    await assertNetworkAccess(page, initialResponse, { authenticated: true });
    if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
      throw new Error("Kleinanzeigen-Sitzung fehlt. Bitte zuerst 'npm run login' ausführen.");
    }
    await openCategoryPicker(page);
    const selection = await selectCategoryPath(page, categoryPath);
    if (!selection.complete) {
      throw new Error("Der verifizierte Kategoriepfad ist im aktuellen Formular nicht mehr vollständig verfügbar.");
    }
    const actualCategoryId = await page.locator('input[name="categoryId"]').inputValue();
    if (actualCategoryId !== String(args.categoryId)) {
      throw new Error(
        `Das sichtbare Formular hat Kategorie ${actualCategoryId || "unbekannt"} statt ${args.categoryId} geladen.`
      );
    }

    const currentFormState = await captureVisibleFormState(page, {
      cookieHeader,
      userAgent: process.env.KA_USER_AGENT || "",
    });
    assertBoundFormState(args, currentFormState);

    await page.locator('input[name="title"]').fill(String(args.title));
    await page.locator('textarea[name="description"]').fill(String(args.description));
    await selectPriceType(page, args.priceType);
    const priceInput = page.locator('input[name="priceAmount"]');
    if (args.priceType !== "GIVE_AWAY") {
      if (await priceInput.count() !== 1) throw new Error("Das Preisfeld fehlt im aktuellen Anzeigenformular.");
      await priceInput.fill(String(args.price));
    }
    const contactName = page.locator('input[name="contactName"]');
    if (await contactName.count() !== 1) throw new Error("Das Kontaktfeld fehlt im aktuellen Anzeigenformular.");
    await contactName.fill(String(args.contactName));

    for (const [key, value] of Object.entries(args.attributes || {})) {
      const field = (contract.requiredAttributes || []).find(candidate => candidate.key === key);
      if (!field) throw new Error(`Attribut "${key}" ist nicht Teil des verifizierten Pflichtvertrags.`);
      await selectVerifiedAttribute(page, field, value);
    }

    assertListingFormContract(await formEntries(page), args, contract);
    const submissionPath = await inspectSubmissionPath(page);
    if (typeof onPhase === "function") await onPhase("upload");
    await uploadImagesInForm(page, args.imagePaths || []);
    assertListingFormContract(await formEntries(page), args, contract);
    const matchesSubmission = request => {
      try {
        const url = new URL(request.url());
        return request.method() === "POST" && `${url.pathname}${url.search}` === submissionPath;
      } catch {
        return false;
      }
    };
    const onRequest = request => {
      if (matchesSubmission(request)) publishRequestStarted = true;
    };
    page.on("request", onRequest);
    let response;
    try {
      if (typeof onPhase === "function") await onPhase("commit");
      const responsePromise = page.waitForResponse(
        candidate => matchesSubmission(candidate.request()),
        { timeout: FORM_TIMEOUT_MS }
      );
      await page.getByRole("button", { name: "Anzeige aufgeben", exact: true }).click();
      if (!(args.imagePaths || []).length) {
        const withoutImage = page.getByRole("button", { name: "Ohne Bild veröffentlichen", exact: true });
        try {
          await withoutImage.waitFor({ state: "visible", timeout: 3_000 });
          await withoutImage.click();
        } catch {}
      }
      response = await responsePromise;
    } finally {
      page.off("request", onRequest);
    }

    const status = response.status();
    const body = await parseResponseBody(response);
    const validationError = listingValidationError(body, args.categoryId, status);
    if (validationError) throw validationError;
    if (status >= 400) {
      const error = new Error(`Kleinanzeigen hat die Formularveröffentlichung abgelehnt (HTTP ${status}).`);
      error.code = status >= 500 ? "KA_CREATE_SERVER_ERROR" : "KA_CREATE_REJECTED";
      error.status = status;
      throw error;
    }

    await page.waitForURL(url => url.pathname !== new URL(FORM_URL).pathname, {
      timeout: 15_000,
    }).catch(() => {});
    const headers = response.headers();
    const result = publishedListingResult({
      body,
      pageUrl: page.url(),
      location: headers.location || "",
    });
    if (!result) {
      const error = new Error(
        "Kleinanzeigen hat das Formular angenommen, aber keine eindeutige Anzeigen-ID zurückgegeben."
      );
      error.code = "KA_PUBLISH_RESULT_UNKNOWN";
      throw error;
    }
    return result;
  } catch (error) {
    if (!publishRequestStarted) error.definitiveNoWrite = true;
    throw error;
  } finally {
    await closeNativeProfile(nativeProfile);
  }
}

module.exports = {
  assertListingFormContract,
  categoryPathFromContract,
  inspectSubmissionPath,
  listingIdFromValue,
  normalizeSubmissionPath,
  publishListingViaForm,
  publishedListingResult,
  selectVerifiedAttribute,
};
