"use strict";

const {
  armClosingDeadline,
  assertNetworkAccess,
  closeNativeProfile,
  openNativeProfile,
} = require("./auth");
const { ensureCategoryBrowserSession } = require("./kleinanzeigen-form");
const {
  inspectSubmissionPath,
} = require("./kleinanzeigen-publish-form");
const { listingValidationError } = require("./kleinanzeigen");
const { redactUnsafeText } = require("./safe-error");

const FORM_TIMEOUT_MS = 60_000;
const FORM_OPERATION_TIMEOUT_MS = 90_000;
const EDIT_FORM_PATH = "/p-anzeige-bearbeiten.html";
const PRECHECK_STEP_LABELS = Object.freeze({
  open_form: "Bearbeitungsmaske öffnen",
  verify_ad: "Anzeige und bisherigen Titel prüfen",
  inspect_submission: "Speicherziel prüfen",
  fill_content: "Titel oder Beschreibung eintragen",
  verify_form: "unveränderte übrige Anzeige prüfen",
});

function normalizeAdId(value) {
  const adId = String(value || "").trim();
  if (!/^\d+$/.test(adId)) throw new Error("adId fehlt oder ist ungültig.");
  return adId;
}

function normalizeTitle(value, label = "Titel") {
  const title = String(value || "").trim();
  if (!title) throw new Error(`${label} fehlt.`);
  if (title.length > 65) throw new Error(`${label} darf maximal 65 Zeichen lang sein.`);
  return title;
}

function normalizeDescription(value) {
  const description = String(value || "").trim();
  if (!description) throw new Error("Neue Beschreibung fehlt.");
  if (description.length > 4000) {
    throw new Error("Neue Beschreibung darf maximal 4000 Zeichen lang sein.");
  }
  return description;
}

function normalizeAdEditArgs(args = {}) {
  const normalized = { adId: normalizeAdId(args.adId) };
  if (args.title !== undefined && args.title !== null) {
    normalized.title = normalizeTitle(args.title, "Neuer Titel");
  }
  if (args.description !== undefined && args.description !== null) {
    normalized.description = normalizeDescription(args.description);
  }
  if (normalized.title === undefined && normalized.description === undefined) {
    throw new Error("Mindestens title oder description muss geändert werden.");
  }
  return normalized;
}

function normalizeAdEditAction(args = {}) {
  const normalized = normalizeAdEditArgs(args);
  const previousTitle = normalizeTitle(args.previousTitle, "Bisheriger Titel");
  const title = normalized.title || previousTitle;
  if (previousTitle === title && normalized.description === undefined) {
    throw new Error("Der neue Titel ist mit dem aktuellen Titel identisch.");
  }
  return {
    adId: normalized.adId,
    previousTitle,
    title,
    ...(normalized.description !== undefined ? { description: normalized.description } : {}),
  };
}

function editFormUrl(adId) {
  return `https://www.kleinanzeigen.de${EDIT_FORM_PATH}?adId=${encodeURIComponent(normalizeAdId(adId))}`;
}

function incompleteEditError(message) {
  const error = new Error(`${message} Es wurde nichts geändert.`);
  error.code = "KA_EDIT_PRECHECK_FAILED";
  error.definitiveNoWrite = true;
  return error;
}

function firstFormValue(entries, name) {
  return entries.find(([key]) => key === name)?.[1];
}

function assertOnlyRequestedFormChanges(before, after, args) {
  const action = normalizeAdEditAction(args);
  if (!Array.isArray(before) || !Array.isArray(after)) {
    throw incompleteEditError("Der aktuelle Formularzustand ist nicht lesbar.");
  }
  if (before.length !== after.length) {
    throw incompleteEditError("Die Bearbeitungsmaske hat beim Titelwechsel weitere Formularwerte verändert.");
  }
  if (
    firstFormValue(before, "adId") !== action.adId
    || firstFormValue(after, "adId") !== action.adId
  ) {
    throw incompleteEditError("Die Bearbeitungsmaske gehört nicht eindeutig zur freigegebenen Anzeige.");
  }
  if (firstFormValue(before, "title") !== action.previousTitle) {
    throw incompleteEditError("Der bisherige Anzeigentitel hat sich seit der Freigabe geändert.");
  }
  if (firstFormValue(after, "title") !== action.title) {
    throw incompleteEditError("Die Bearbeitungsmaske hat den neuen Titel nicht exakt übernommen.");
  }
  if (
    action.description !== undefined
    && firstFormValue(after, "description") !== action.description
  ) {
    throw incompleteEditError("Die Bearbeitungsmaske hat die neue Beschreibung nicht exakt übernommen.");
  }

  const allowedChanges = new Set([
    "title",
    ...(action.description !== undefined ? ["description"] : []),
  ]);
  for (let index = 0; index < before.length; index++) {
    const [beforeName, beforeValue] = before[index];
    const [afterName, afterValue] = after[index];
    if (beforeName !== afterName) {
      throw incompleteEditError("Die Bearbeitungsmaske hat ihre Formularstruktur während der Änderung gewechselt.");
    }
    if (!allowedChanges.has(beforeName) && beforeValue !== afterValue) {
      throw incompleteEditError(`Das Feld "${beforeName}" wurde unerwartet verändert.`);
    }
  }
  return true;
}

async function formEntries(page) {
  const forms = page.locator("form");
  if (await forms.count() !== 1) {
    throw incompleteEditError("Die aktuelle Bearbeitungsmaske enthält kein eindeutiges Formular.");
  }
  return forms.evaluate(form => (
    Array.from(new FormData(form).entries()).flatMap(([name, value]) => (
      typeof value === "string" ? [[name, value]] : []
    ))
  ));
}

function editTimeoutError({ editRequestStarted = false } = {}) {
  const error = new Error("Die Bearbeitungsmaske hat das sichere Gesamtzeitlimit überschritten.");
  if (editRequestStarted) {
    error.code = "KA_EDIT_OUTCOME_UNKNOWN";
    error.safeMessage =
      "Die Bearbeitungsmaske wurde nach dem Speichern wegen des sicheren Zeitlimits beendet. " +
      "Der Ausgang ist nicht eindeutig; nicht erneut ändern, bevor die eigenen Anzeigen geprüft wurden.";
    return error;
  }
  error.code = "KA_EDIT_TIMEOUT";
  error.definitiveNoWrite = true;
  error.safeMessage =
    "Die Bearbeitungsmaske wurde vor dem Speichern nach dem sicheren Zeitlimit beendet. " +
    "Die Anzeige wurde nicht geändert; denselben Titelvorschlag einmal neu prüfen.";
  return error;
}

function normalizeEditError(error, {
  editRequestStarted = false,
  precheckStep = null,
} = {}) {
  const normalized = error instanceof Error
    ? error
    : new Error("Der Browser hat einen unbekannten Fehler gemeldet.");
  if (!editRequestStarted) {
    normalized.definitiveNoWrite = true;
    if (!normalized.code) {
      const label = PRECHECK_STEP_LABELS[String(precheckStep || "").trim()];
      normalized.code = "KA_EDIT_PRECHECK_FAILED";
      normalized.safeMessage = label
        ? `Die Titeländerung scheiterte beim Schritt „${label}“. ` +
          `Grund: ${redactUnsafeText(normalized.message).slice(0, 300)} Es wurde nichts geändert.`
        : "Die Bearbeitungsmaske konnte vor dem Speichern nicht sicher geprüft werden. Es wurde nichts geändert.";
    }
  } else if (!normalized.code) {
    normalized.code = "KA_EDIT_OUTCOME_UNKNOWN";
    normalized.safeMessage =
      "Kleinanzeigen hat nach dem Speichern keinen eindeutigen Abschluss bestätigt. " +
      "Nicht automatisch wiederholen; zuerst die eigenen Anzeigen prüfen.";
  }
  return normalized;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text.slice(0, 20_000); }
}

async function editAdViaForm(rawArgs, {
  cookieHeader,
  onPhase = null,
  preflightOnly = false,
} = {}) {
  const args = normalizeAdEditAction(rawArgs);
  let nativeProfile;
  let editRequestStarted = false;
  let precheckStep = "open_form";
  let operationDeadline;
  try {
    nativeProfile = await openNativeProfile({ headless: false });
    operationDeadline = armClosingDeadline(
      () => closeNativeProfile(nativeProfile),
      FORM_OPERATION_TIMEOUT_MS
    );
    const { context, page } = nativeProfile;
    await ensureCategoryBrowserSession(context, cookieHeader);
    const initialResponse = await page.goto(editFormUrl(args.adId), {
      waitUntil: "domcontentloaded",
      timeout: FORM_TIMEOUT_MS,
    });
    await assertNetworkAccess(page, initialResponse, { authenticated: true });
    if (/login\.kleinanzeigen\.de|m-einloggen/.test(page.url())) {
      throw new Error("Kleinanzeigen-Sitzung fehlt. Bitte zuerst 'npm run login' ausführen.");
    }

    precheckStep = "verify_ad";
    const currentUrl = new URL(page.url());
    if (
      currentUrl.origin !== "https://www.kleinanzeigen.de"
      || currentUrl.pathname !== EDIT_FORM_PATH
      || currentUrl.searchParams.get("adId") !== args.adId
    ) {
      throw incompleteEditError("Kleinanzeigen hat nicht die freigegebene Bearbeitungsmaske geöffnet.");
    }
    const adIdInput = page.locator('input[name="adId"]');
    const titleInput = page.locator('input[name="title"]');
    if (
      await adIdInput.count() !== 1
      || await adIdInput.inputValue() !== args.adId
      || await titleInput.count() !== 1
      || await titleInput.inputValue() !== args.previousTitle
    ) {
      throw incompleteEditError("Anzeige oder bisheriger Titel stimmen nicht mehr mit der Freigabe überein.");
    }
    const before = await formEntries(page);

    precheckStep = "inspect_submission";
    const submissionPath = await inspectSubmissionPath(page);
    precheckStep = "fill_content";
    await titleInput.fill(args.title);
    if (args.description !== undefined) {
      const descriptionInput = page.locator('textarea[name="description"]');
      if (await descriptionInput.count() !== 1) {
        throw incompleteEditError("Die aktuelle Bearbeitungsmaske enthält keine eindeutige Beschreibung.");
      }
      await descriptionInput.fill(args.description);
    }
    precheckStep = "verify_form";
    const after = await formEntries(page);
    assertOnlyRequestedFormChanges(before, after, args);

    if (preflightOnly) {
      if (operationDeadline.expired()) throw editTimeoutError();
      return { preflight: true, adId: args.adId, submissionPath };
    }

    const matchesSubmission = request => {
      try {
        const url = new URL(request.url());
        return request.method() === "POST" && `${url.pathname}${url.search}` === submissionPath;
      } catch {
        return false;
      }
    };
    const onRequest = request => {
      if (matchesSubmission(request)) editRequestStarted = true;
    };
    page.on("request", onRequest);
    let response;
    try {
      const responsePromise = page.waitForResponse(
        candidate => matchesSubmission(candidate.request()),
        { timeout: FORM_TIMEOUT_MS }
      );
      if (typeof onPhase === "function") await onPhase("commit");
      // From this boundary onward the click may already have caused the external write.
      editRequestStarted = true;
      const saveButton = page.getByRole("button", { name: "Anzeige speichern", exact: true });
      if (await saveButton.count() !== 1) {
        throw new Error("Die Bearbeitungsmaske enthält keinen eindeutigen Speichern-Knopf.");
      }
      await saveButton.click();
      response = await responsePromise;
    } finally {
      page.off("request", onRequest);
    }

    const status = response.status();
    const body = await parseResponseBody(response);
    const categoryId = Number(firstFormValue(after, "categoryId"));
    const validationError = listingValidationError(body, categoryId, status);
    if (validationError) throw validationError;
    if (status >= 400) {
      const error = new Error(`Kleinanzeigen hat die Titeländerung abgelehnt (HTTP ${status}).`);
      error.code = status >= 500 ? "KA_EDIT_SERVER_ERROR" : "KA_EDIT_REJECTED";
      error.status = status;
      throw error;
    }
    if (body?.result?.actionSuccessful === false) {
      const error = new Error("Kleinanzeigen hat die Titeländerung nicht bestätigt.");
      error.code = "KA_EDIT_REJECTED";
      throw error;
    }
    if (operationDeadline.expired()) throw editTimeoutError({ editRequestStarted });
    return {
      id: args.adId,
      link: `https://www.kleinanzeigen.de/s-anzeige/${args.adId}`,
      previousTitle: args.previousTitle,
      title: args.title,
      descriptionChanged: args.description !== undefined,
    };
  } catch (error) {
    const failure = operationDeadline?.expired()
      ? editTimeoutError({ editRequestStarted })
      : error;
    throw normalizeEditError(failure, { editRequestStarted, precheckStep });
  } finally {
    operationDeadline?.cancel();
    await closeNativeProfile(nativeProfile);
  }
}

module.exports = {
  EDIT_FORM_PATH,
  assertOnlyRequestedFormChanges,
  editAdViaForm,
  editFormUrl,
  editTimeoutError,
  normalizeAdId,
  normalizeEditError,
  normalizeAdEditAction,
  normalizeAdEditArgs,
};
