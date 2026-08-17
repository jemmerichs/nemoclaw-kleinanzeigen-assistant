"use strict";

const crypto = require("crypto");

const { sessionRevision } = require("./session-readiness");
const { stableJson } = require("../workspace/runtime");

function normalizeVisibleText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 200);
}

function normalizeFormState(raw = {}) {
  const categoryId = Number(raw.categoryId);
  const state = {
    categoryId: Number.isInteger(categoryId) && categoryId > 0 ? categoryId : null,
    zipCode: String(raw.zipCode || "").trim(),
    locationId: String(raw.locationId || "").trim(),
    locationName: normalizeVisibleText(raw.locationName),
    contactName: normalizeVisibleText(raw.contactName),
    sessionRevision: String(raw.sessionRevision || "unavailable"),
  };
  if (!state.categoryId || !/^\d{5}$/.test(state.zipCode) || !state.locationId || !state.locationName) {
    const error = new Error("Der sichtbare Standort konnte im aktuellen Anzeigenformular nicht eindeutig gebunden werden.");
    error.code = "KA_FORM_LOCATION_UNRESOLVED";
    error.definitiveNoWrite = true;
    throw error;
  }
  state.formFingerprint = crypto.createHash("sha256")
    .update(stableJson(state))
    .digest("hex");
  return state;
}

async function captureVisibleFormState(page, { cookieHeader = "", userAgent = "" } = {}) {
  const raw = await page.evaluate(() => {
    const input = name => document.querySelector(`input[name="${name}"]`);
    const category = input("categoryId");
    const zip = input("zipCode");
    const location = input("locationId");
    const contact = input("contactName");
    const candidates = [
      document.querySelector('input[name="locationName"]'),
      document.querySelector('input[name="city"]'),
      document.querySelector('[data-testid*="location"] input:not([name="locationId"])'),
      document.querySelector('[aria-label*="Ort" i]'),
      document.querySelector('[aria-label*="Standort" i]'),
    ].filter(Boolean);
    let locationName = candidates.map(candidate => String(candidate.value || candidate.textContent || "").trim())
      .find(Boolean) || "";
    if (!locationName && location) {
      let current = location.parentElement;
      for (let depth = 0; depth < 5 && current; depth++, current = current.parentElement) {
        const text = String(current.innerText || "").trim().replace(/\s+/g, " ");
        if (text && text.length <= 200 && !/^\d+$/.test(text)) {
          locationName = text;
          break;
        }
      }
    }
    return {
      categoryId: category?.value || "",
      zipCode: zip?.value || "",
      locationId: location?.value || "",
      locationName,
      contactName: contact?.value || "",
    };
  });
  return normalizeFormState({
    ...raw,
    sessionRevision: sessionRevision(cookieHeader, { userAgent }),
  });
}

function assertBoundFormState(expected, current) {
  if (
    String(expected?.formFingerprint || "") === String(current?.formFingerprint || "")
    && String(expected?.sessionRevision || "") === String(current?.sessionRevision || "")
  ) return true;
  const error = new Error("Der sichtbare Standort- oder Sessionzustand hat sich seit der Vorschau geändert.");
  error.code = "KA_FORM_STATE_DRIFT";
  error.definitiveNoWrite = true;
  error.formState = current;
  throw error;
}

module.exports = { assertBoundFormState, captureVisibleFormState, normalizeFormState };
