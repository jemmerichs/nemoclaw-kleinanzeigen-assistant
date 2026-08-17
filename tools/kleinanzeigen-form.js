"use strict";

const {
  armClosingDeadline,
  assertNetworkAccess,
  closeNativeProfile,
  openNativeProfile,
  validatedCookieHeader,
  validatedSessionCookieString,
} = require("./auth");
const {
  rememberCategoryRequirements,
} = require("./kleinanzeigen-category-contracts");
const {
  shouldPreferStoredSession,
} = require("./kleinanzeigen-session");
const { captureVisibleFormState } = require("./kleinanzeigen-form-state");

const FORM_URL = "https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html";
const INSPECTION_IDLE_MS = 2 * 60 * 1000;
const PREPARED_FORM_IDLE_MS = 30 * 60 * 1000;
const INSPECTION_REJECTION_BACKOFF_MS = 30 * 60 * 1000;
const FORM_OPERATION_TIMEOUT_MS = 90_000;
let inspectionQueue = Promise.resolve();
let activeInspectionSession = null;
let inspectionIdleTimer = null;
let inspectionBlockedUntil = 0;

function formOperationTimeoutError() {
  const error = new Error("Die sichtbare Formularprüfung hat das sichere Zeitlimit überschritten.");
  error.code = "KA_FORM_TIMEOUT";
  error.definitiveNoWrite = true;
  error.safeMessage =
    "Die sichtbare Formularprüfung wurde nach dem sicheren Zeitlimit beendet. " +
    "Es wurde nichts hochgeladen oder veröffentlicht; Bilder und Angaben bleiben erhalten.";
  return error;
}

function normalizeCategoryPath(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("categoryPath muss eine Liste sichtbarer Kategorienamen sein.");
  if (value.length > 6) throw new Error("categoryPath darf höchstens 6 Ebenen enthalten.");
  return value.map((entry, index) => {
    const label = String(entry || "").trim();
    if (!label || label.length > 160) {
      throw new Error(`categoryPath[${index}] fehlt oder ist länger als 160 Zeichen.`);
    }
    return label;
  });
}

function categoryIdValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const categoryId = Number(value);
  if (!Number.isInteger(categoryId) || categoryId < 1 || categoryId > 9999) {
    throw new Error("categoryId ist ungültig.");
  }
  return categoryId;
}

function browserCookiesFromHeader(rawHeader) {
  const normalized = validatedCookieHeader(rawHeader);
  return normalized.split(";").map(part => {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: "https://www.kleinanzeigen.de",
    };
  });
}

async function ensureCategoryBrowserSession(context, rawHeader = process.env.KA_COOKIES) {
  let profileHeader = "";
  try {
    profileHeader = validatedSessionCookieString(
      await context.cookies("https://www.kleinanzeigen.de")
    );
  } catch {}

  let environmentHeader = "";
  try {
    environmentHeader = validatedCookieHeader(rawHeader);
  } catch {}

  if (
    profileHeader
    && !shouldPreferStoredSession(profileHeader, environmentHeader)
  ) return { source: "profile" };

  if (!environmentHeader) {
    throw new Error(
      "Die Kleinanzeigen-Sitzung fehlt oder ist unvollständig. " +
      "Bitte einmal 'npm run login' ausführen."
    );
  }
  const cookies = browserCookiesFromHeader(environmentHeader);
  await context.addCookies(cookies);
  try {
    validatedSessionCookieString(
      await context.cookies("https://www.kleinanzeigen.de")
    );
  } catch {
    throw new Error(
      "Die gespeicherte Kleinanzeigen-Sitzung konnte nicht in das isolierte Kategorie-Browserfenster übernommen werden."
    );
  }
  return { source: "environment" };
}

async function readCategoryChoices(page, selectedTokens = []) {
  const choices = await page.locator('main a[href^="#?path="]').evaluateAll(links => (
    links.slice(0, 200).map(link => {
      const href = link.getAttribute("href") || "";
      const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
      const params = new URLSearchParams(query);
      const tokens = String(params.get("path") || "").split("/").filter(Boolean);
      return {
        label: String(link.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
        href,
        tokens,
        isParent: params.get("isParent") === "true",
        active: link.getAttribute("aria-current") === "page"
          || String(link.className || "").split(/\s+/).includes("active"),
      };
    })
  ));
  const nextDepth = selectedTokens.length + 1;
  return choices
    .filter(choice => (
      choice.label
      && choice.tokens.length === nextDepth
      && selectedTokens.every((token, index) => choice.tokens[index] === token)
    ))
    .map(choice => ({
      label: choice.label,
      token: choice.tokens.at(-1),
      tokens: choice.tokens,
      isParent: choice.isParent,
      href: choice.href,
    }));
}

function publicChoices(choices) {
  return choices.map(({ href, tokens, ...choice }) => choice);
}

async function waitForInputValue(locator, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await locator.count() === 1) {
      const value = await locator.inputValue();
      if (value) return value;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  return "";
}

async function waitForListingTransition(formMarker, continueButton, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await formMarker.count() === 1) return "form";
    if (await continueButton.count() === 1) return "continue";
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  return "missing";
}

async function waitForCategoryLinks(page, timeoutMs = 10_000) {
  const categoryLinks = page.locator('main a[href^="#?path="]');
  await categoryLinks.first().waitFor({ state: "attached", timeout: timeoutMs }).catch(() => {});
  return categoryLinks;
}

async function openCategoryPicker(page) {
  for (const name of ["Kategorie ändern", "Wähle deine Kategorie"]) {
    const link = page.getByRole("link", { name, exact: true });
    if (await link.count() === 1) {
      await link.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await assertNetworkAccess(page, null, { authenticated: true });
      if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
        throw new Error("Kleinanzeigen-Sitzung fehlt. Bitte zuerst 'npm run login' ausführen.");
      }
      const categoryLinks = await waitForCategoryLinks(page);
      if (!await categoryLinks.count()) {
        const error = new Error(
          "Die aktuelle Kategorieauswahl enthält auch nach dem Laden keine lesbaren Kategoriepfade."
        );
        error.code = "KA_FORM_STRUCTURE_CHANGED";
        throw error;
      }
      return;
    }
  }
  throw new Error("Das aktuelle Kleinanzeigen-Formular bietet keine erkennbare Kategorieauswahl.");
}

async function selectCategoryPath(page, categoryPath, progress = {}) {
  const selectedTokens = [...(progress.selectedTokens || [])];
  const selectedLabels = [...(progress.selectedLabels || [])];
  let categoryChosen = false;
  for (const label of categoryPath.slice(selectedLabels.length)) {
    const choices = await readCategoryChoices(page, selectedTokens);
    const matches = choices.filter(choice => choice.label === label);
    if (matches.length !== 1) {
      return {
        complete: false,
        selectedPath: selectedLabels,
        selectedTokens,
        choices: publicChoices(choices),
        issue: matches.length
          ? `Kategorie "${label}" ist in dieser Ebene nicht eindeutig.`
          : `Kategorie "${label}" ist in dieser Ebene nicht vorhanden.`,
      };
    }
    const target = page.locator(`main a[href=${JSON.stringify(matches[0].href)}]`);
    if (await target.count() !== 1) {
      throw new Error(`Kategorie-Link "${label}" ist im aktuellen Formular nicht eindeutig.`);
    }
    await target.click();
    selectedTokens.splice(0, selectedTokens.length, ...matches[0].tokens);
    selectedLabels.push(label);

    const categoryInput = page.locator('input[name="categoryId"]');
    const selectedCategoryId = matches[0].isParent
      ? ""
      : await waitForInputValue(categoryInput);
    if (selectedCategoryId) {
      if (selectedLabels.length !== categoryPath.length) {
        throw new Error(
          `Kategorie "${label}" ist bereits eine Endkategorie; der angegebene categoryPath enthält weitere Ebenen.`
        );
      }
      categoryChosen = true;
      break;
    }
  }

  if (categoryChosen) {
    const formMarker = page.locator('input[name="title"]');
    if (await formMarker.count() !== 1) {
      const continueButton = page.getByRole("button", { name: /^Weiter(?:\s|$)/i });
      const transition = await waitForListingTransition(formMarker, continueButton);
      if (transition === "form") {
        return { complete: true, selectedPath: selectedLabels, selectedTokens };
      }
      if (transition !== "continue") {
        throw new Error(
          "Die gewählte Endkategorie konnte im aktuellen Formular nicht übernommen werden."
        );
      }
      await continueButton.click();
      await formMarker.waitFor({ state: "attached", timeout: 15_000 });
    }
    return { complete: true, selectedPath: selectedLabels, selectedTokens };
  }

  const choices = await readCategoryChoices(page, selectedTokens);
  return {
    complete: false,
    selectedPath: selectedLabels,
    selectedTokens,
    choices: publicChoices(choices),
    issue: categoryPath.length
      ? "Die Kategorie benötigt noch eine weitere sichtbare Auswahl."
      : "Wähle den sichtbaren Kategoriepfad schrittweise aus.",
  };
}

async function closeInspectionSession(session = activeInspectionSession) {
  if (!session || session.closed) return;
  session.closed = true;
  if (inspectionIdleTimer) {
    clearTimeout(inspectionIdleTimer);
    inspectionIdleTimer = null;
  }
  if (activeInspectionSession === session) activeInspectionSession = null;
  await closeNativeProfile(session.nativeProfile);
}

function keepInspectionSessionWarm(session, timeoutMs = INSPECTION_IDLE_MS) {
  if (inspectionIdleTimer) clearTimeout(inspectionIdleTimer);
  inspectionIdleTimer = setTimeout(() => {
    closeInspectionSession(session).catch(() => {});
  }, timeoutMs);
  inspectionIdleTimer.unref?.();
}

function preparedFormSessionMatches(session, {
  categoryId,
  categoryPath,
  formFingerprint,
  sessionRevision,
} = {}) {
  const ready = session?.readyForm;
  if (!ready || session.closed) return false;
  const expectedPath = normalizeCategoryPath(categoryPath);
  return Number(ready.categoryId) === Number(categoryId)
    && ready.categoryPath.length === expectedPath.length
    && ready.categoryPath.every((label, index) => label === expectedPath[index])
    && ready.formFingerprint === String(formFingerprint || "")
    && ready.sessionRevision === String(sessionRevision || "");
}

async function takePreparedFormSession(binding) {
  const session = activeInspectionSession;
  if (!session) return null;
  if (!preparedFormSessionMatches(session, binding)) {
    await closeInspectionSession(session);
    return null;
  }
  if (inspectionIdleTimer) {
    clearTimeout(inspectionIdleTimer);
    inspectionIdleTimer = null;
  }
  activeInspectionSession = null;
  return {
    ...session.nativeProfile,
    page: session.page,
    reusedPreparedForm: true,
  };
}

async function discardPreparedFormSession() {
  await closeInspectionSession();
}

async function startInspectionSession() {
  if (Date.now() < inspectionBlockedUntil) {
    const error = new Error(
      `Der dedizierte Kategorie-Browser bleibt nach einer Zugriffsablehnung bis ${new Date(inspectionBlockedUntil).toISOString()} pausiert.`
    );
    error.code = "KA_BROWSER_BACKOFF";
    error.retryAfter = new Date(inspectionBlockedUntil).toISOString();
    throw error;
  }
  // Never browse Kleinanzeigen headlessly in the runtime. A visible, dedicated
  // Chrome profile avoids the HeadlessChrome fingerprint and makes any account
  // challenge visible instead of hammering the endpoint in the background.
  const nativeProfile = await openNativeProfile({ headless: false });
  const startupDeadline = armClosingDeadline(
    () => closeNativeProfile(nativeProfile),
    FORM_OPERATION_TIMEOUT_MS
  );
  try {
    const { context, page } = nativeProfile;
    const browserSession = await ensureCategoryBrowserSession(context);
    const response = await page.goto(FORM_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertNetworkAccess(page, response, { authenticated: true });
    if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
      throw new Error(
        browserSession.source === "environment"
          ? "Die gespeicherte Kleinanzeigen-Sitzung wurde vom aktuellen Formular abgelehnt. " +
            "Bitte einmal 'npm run login' ausführen."
          : "Kleinanzeigen-Sitzung fehlt. Bitte zuerst 'npm run login' ausführen."
      );
    }
    await openCategoryPicker(page);
    if (startupDeadline.expired()) throw formOperationTimeoutError();
    return {
      nativeProfile,
      page,
      closed: false,
      selectedLabels: [],
      selectedTokens: [],
    };
  } catch (error) {
    const failure = startupDeadline.expired() ? formOperationTimeoutError() : error;
    if (["KA_BROWSER_REJECTED", "KA_ACCESS_DENIED"].includes(error.code)) {
      inspectionBlockedUntil = Date.now() + INSPECTION_REJECTION_BACKOFF_MS;
    }
    await closeNativeProfile(nativeProfile);
    throw failure;
  } finally {
    startupDeadline.cancel();
  }
}

function inspectionSessionMatchesPath(session, categoryPath) {
  if (!session || session.closed) return false;
  const selectedLabels = session.selectedLabels || [];
  const matchingPath = selectedLabels.length <= categoryPath.length
    && selectedLabels.every((label, index) => categoryPath[index] === label);
  return matchingPath && (!session.readyForm || selectedLabels.length === categoryPath.length);
}

async function inspectionSessionFor(categoryPath) {
  const canContinue = inspectionSessionMatchesPath(activeInspectionSession, categoryPath);
  if (!canContinue) await closeInspectionSession();
  if (!activeInspectionSession) activeInspectionSession = await startInspectionSession();
  if (inspectionIdleTimer) {
    clearTimeout(inspectionIdleTimer);
    inspectionIdleTimer = null;
  }
  return activeInspectionSession;
}

async function inspectBaseAttributes(page) {
  return page.evaluate(() => {
    const prefix = "attributeMap[";
    const controls = Array.from(document.querySelectorAll(
      'input[name^="attributeMap["],select[name^="attributeMap["],textarea[name^="attributeMap["]'
    ));
    const groups = new Map();
    for (const input of controls) {
      const name = String(input.getAttribute("name") || "");
      if (!name.startsWith(prefix) || !name.endsWith("]")) continue;
      const key = name.slice(prefix.length, -1);
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(input);
    }

    return [...groups.entries()].slice(0, 40).map(([key, inputs]) => {
      const first = inputs[0];
      let context = "";
      let current = first;
      for (let depth = 0; depth < 7 && current; depth++, current = current.parentElement) {
        const text = String(current.innerText || "").trim().replace(/\s+/g, " ");
        if (text && text.length <= 1200) context = text;
        if (current.querySelectorAll?.('input[name^="attributeMap["]').length > inputs.length) break;
      }
      const choiceOptions = inputs
        .filter(input => ["radio", "checkbox"].includes(input.getAttribute("type")))
        .map(input => ({
          value: String(input.value || ""),
          label: String(input.closest("label")?.innerText || input.value || "")
            .trim().replace(/\s+/g, " ").slice(0, 200),
        }))
        .filter(option => option.value);
      const selectOptions = first.tagName === "SELECT"
        ? Array.from(first.options || []).map(option => ({
          value: String(option.value || ""),
          label: String(option.textContent || option.value || "")
            .trim().replace(/\s+/g, " ").slice(0, 200),
        })).filter(option => option.value)
        : [];
      const escapedKey = globalThis.CSS?.escape
        ? globalThis.CSS.escape(key)
        : key.replace(/(["\\])/g, "\\$1");
      const explicitKeyLabel = document.querySelector(`label[for="${escapedKey}"]`);
      const explicitControlLabel = !choiceOptions.length && first.id
        ? document.querySelector(`label[for="${globalThis.CSS?.escape
          ? globalThis.CSS.escape(first.id)
          : first.id.replace(/(["\\])/g, "\\$1")}"]`)
        : null;
      let layoutLabel = "";
      let ancestor = first.parentElement;
      for (let depth = 0; depth < 9 && ancestor && !layoutLabel; depth++, ancestor = ancestor.parentElement) {
        const siblings = Array.from(ancestor.children || []).filter(child => (
          !child.contains(first)
          && !inputs.some(input => child.contains(input))
        ));
        layoutLabel = siblings.map(sibling => (
          String(sibling.innerText || sibling.textContent || "")
            .trim().replace(/\s+/g, " ")
        )).find(text => text && text.length <= 200) || "";
      }
      const selected = inputs.find(input => input.checked) || first;
      return {
        key,
        label: String(
          explicitKeyLabel?.textContent
          || explicitControlLabel?.textContent
          || layoutLabel
          || key
        ).trim().replace(/\s+/g, " ").slice(0, 200),
        required: !/\boptional\b|\boptional\)/i.test(context),
        currentValue: String(selected?.value || ""),
        context: context.slice(0, 600),
        control: choiceOptions.length
          ? "choice"
          : selectOptions.length
            ? "select"
            : String(first.getAttribute("type") || first.tagName).toLocaleLowerCase(),
        values: choiceOptions.length ? choiceOptions : selectOptions,
      };
    });
  });
}

async function inspectComboboxValues(page, field) {
  if (field.control !== "hidden") return field;
  const inputName = `attributeMap[${field.key}]`;
  const hidden = page.locator(`input[name=${JSON.stringify(inputName)}]`);
  const button = page.locator(`button[id=${JSON.stringify(field.key)}]`);
  if (await hidden.count() !== 1 || await button.count() !== 1) return field;

  const originalValue = await hidden.inputValue();
  await button.click();
  let options = page.getByRole("option");
  const count = await options.count();
  if (!count || count > 60) {
    await page.keyboard.press("Escape");
    return field;
  }

  const values = [];
  for (let index = 0; index < count; index++) {
    options = page.getByRole("option");
    const option = options.nth(index);
    const label = String(await option.innerText()).trim().replace(/\s+/g, " ").slice(0, 200);
    await option.click();
    const value = String(await hidden.inputValue());
    if (value && !values.some(candidate => candidate.value === value)) {
      values.push({ value, label });
    }
    if (index < count - 1) await button.click();
  }

  const original = values.find(option => option.value === originalValue);
  if (original) {
    await button.click();
    const originalOption = page.getByRole("option", { name: original.label, exact: true });
    if (await originalOption.count() === 1) await originalOption.click();
  } else {
    await page.keyboard.press("Escape");
  }
  return {
    ...field,
    control: "combobox",
    values,
  };
}

async function inspectCategoryFormNow({ categoryId, categoryPath, onSessionObserved = null } = {}) {
  const expectedCategoryId = categoryIdValue(categoryId);
  const normalizedPath = normalizeCategoryPath(categoryPath);
  let session;
  let keepSession = false;
  let operationDeadline;
  try {
    session = await inspectionSessionFor(normalizedPath);
    operationDeadline = armClosingDeadline(
      () => closeInspectionSession(session),
      FORM_OPERATION_TIMEOUT_MS
    );
    const { page } = session;
    const observedCookieHeader = validatedSessionCookieString(
      await session.nativeProfile.context.cookies("https://www.kleinanzeigen.de")
    );
    if (typeof onSessionObserved === "function") await onSessionObserved(observedCookieHeader);
    const selection = session.readyForm
      ? {
        complete: true,
        selectedPath: [...session.selectedLabels],
        selectedTokens: [...session.selectedTokens],
      }
      : await selectCategoryPath(page, normalizedPath, {
        selectedLabels: session.selectedLabels,
        selectedTokens: session.selectedTokens,
      });
    session.selectedLabels = [...selection.selectedPath];
    session.selectedTokens = [...selection.selectedTokens];
    if (!selection.complete) {
      keepSession = true;
      keepInspectionSessionWarm(session);
      const { selectedTokens: _selectedTokens, ...publicSelection } = selection;
      return {
        status: "selection_required",
        expectedCategoryId,
        ...publicSelection,
        instruction:
          "Rufe das Tool erneut mit dem vollständigen exakten categoryPath aus den sichtbaren choices auf.",
      };
    }

    const actualCategoryId = Number(await page.locator('input[name="categoryId"]').inputValue());
    if (!Number.isInteger(actualCategoryId) || actualCategoryId < 1) {
      throw new Error("Das aktuelle Formular lieferte keine gültige categoryId.");
    }
    if (expectedCategoryId && actualCategoryId !== expectedCategoryId) {
      throw new Error(
        `Der sichtbare Kategoriepfad gehört zu categoryId ${actualCategoryId}, erwartet war ${expectedCategoryId}.`
      );
    }

    const baseAttributes = await inspectBaseAttributes(page);
    const attributes = [];
    for (const field of baseAttributes) {
      attributes.push(await inspectComboboxValues(page, field));
    }
    const requiredAttributes = attributes
      .filter(field => field.required)
      .map(field => ({
        key: field.key,
        label: field.label,
        values: field.values,
      }));
    const contract = rememberCategoryRequirements({
      categoryId: actualCategoryId,
      category: normalizedPath.join(" > "),
      requiredAttributes,
    });
    const cookieHeader = validatedSessionCookieString(
      await session.nativeProfile.context.cookies("https://www.kleinanzeigen.de")
    );
    const formState = await captureVisibleFormState(page, {
      cookieHeader,
      userAgent: process.env.KA_USER_AGENT || "",
    });
    if (String(process.env.NEMOCLAW_MODE || "dry-run").trim() === "live") {
      session.readyForm = {
        categoryId: actualCategoryId,
        categoryPath: [...normalizedPath],
        formFingerprint: formState.formFingerprint,
        sessionRevision: formState.sessionRevision,
      };
      keepSession = true;
      keepInspectionSessionWarm(session, PREPARED_FORM_IDLE_MS);
    }
    if (operationDeadline.expired()) throw formOperationTimeoutError();
    return {
      status: "ready",
      verified: true,
      ...contract,
      attributes,
      formState,
      instruction:
        "Verwende nur die gelieferten Werte. Fehlt eine nötige Nutzerentscheidung, frage sie vor dem Posting gezielt ab.",
    };
  } catch (error) {
    const failure = operationDeadline?.expired() ? formOperationTimeoutError() : error;
    await closeInspectionSession(session);
    throw failure;
  } finally {
    operationDeadline?.cancel();
    if (session && !keepSession) await closeInspectionSession(session);
  }
}

function inspectCategoryForm(args) {
  const current = inspectionQueue
    .catch(() => {})
    .then(() => inspectCategoryFormNow(args));
  inspectionQueue = current;
  return current;
}

module.exports = {
  FORM_URL,
  FORM_OPERATION_TIMEOUT_MS,
  browserCookiesFromHeader,
  discardPreparedFormSession,
  ensureCategoryBrowserSession,
  inspectCategoryForm,
  inspectCategoryFormNow,
  inspectionSessionMatchesPath,
  normalizeCategoryPath,
  openCategoryPicker,
  preparedFormSessionMatches,
  readCategoryChoices,
  selectCategoryPath,
  takePreparedFormSession,
  waitForCategoryLinks,
  formOperationTimeoutError,
};
