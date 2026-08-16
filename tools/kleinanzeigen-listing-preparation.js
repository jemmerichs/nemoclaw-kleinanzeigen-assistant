"use strict";

const crypto = require("crypto");

const PREPARATION_TTL_MS = 30 * 60 * 1000;
const preparations = new Map();

function normalizeCategoryPath(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || "").split(/\s*>\s*/);
  return entries.map(entry => String(entry || "").trim()).filter(Boolean);
}

function normalizedLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

function publicChoices(field) {
  return (field.values || []).map(option => String(option.label || option.value || "").trim()).filter(Boolean);
}

function findVisibleOption(field, label) {
  const wanted = normalizedLabel(label);
  const matches = (field.values || []).filter(option => normalizedLabel(option.label) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

function deliveryOption(field, delivery) {
  const values = field.values || [];
  const wanted = delivery === "shipping_available"
    ? /^(?:versand möglich|shipping available)$/i
    : /^(?:nur\s+)?abholung$/i;
  const byLabel = values.filter(option => wanted.test(String(option.label || "").trim()));
  return byLabel.length === 1 ? byLabel[0] : null;
}

function resolveCategoryAttributes(contract, {
  delivery = "pickup_only",
  categoryAnswers = {},
} = {}) {
  const required = Array.isArray(contract?.requiredAttributes)
    ? contract.requiredAttributes
    : [];
  const answers = Object.entries(categoryAnswers || {});
  const attributes = {};
  const unresolved = [];
  const usedAnswers = new Set();

  for (const field of required) {
    const shipping = /versand|shipping/i.test(`${field.label || ""} ${field.key || ""}`);
    if (shipping) {
      const option = deliveryOption(field, delivery);
      if (option) attributes[field.key] = String(option.value);
      else unresolved.push({
        field: String(field.label || "Versand"),
        choices: publicChoices(field),
      });
      continue;
    }

    const matchingAnswers = answers.filter(([label]) => (
      normalizedLabel(label) === normalizedLabel(field.label)
    ));
    if (matchingAnswers.length === 1) {
      const [answerLabel, answer] = matchingAnswers[0];
      if (!(field.values || []).length && String(answer || "").trim()) {
        attributes[field.key] = String(answer).trim();
        usedAnswers.add(answerLabel);
        continue;
      }
      const option = findVisibleOption(field, answer);
      if (option) {
        attributes[field.key] = String(option.value);
        usedAnswers.add(answerLabel);
        continue;
      }
    }
    unresolved.push({
      field: String(field.label || "Kategorieangabe"),
      choices: publicChoices(field),
    });
  }

  const unknownAnswers = answers
    .filter(([label]) => !usedAnswers.has(label))
    .map(([label]) => label);
  if (unresolved.length || unknownAnswers.length) {
    return {
      status: "needs_input",
      question: unresolved.length === 1
        ? `Welche Option gilt für „${unresolved[0].field}“?`
        : "Für die Kategorie fehlen noch sichtbare Auswahlwerte.",
      fields: unresolved,
      ...(unknownAnswers.length ? {
        ignoredAnswers: unknownAnswers,
        instruction: "Verwende als categoryAnswers ausschließlich sichtbare Feld- und Optionsbezeichnungen.",
      } : {}),
    };
  }
  return { status: "ready", attributes };
}

function purgeExpired(now = Date.now()) {
  for (const [id, entry] of preparations) {
    if (entry.expiresAt <= now) preparations.delete(id);
  }
}

function storeListingPreparation(snapshot, { now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  purgeExpired(now);
  const preparationId = randomBytes(12).toString("hex");
  preparations.set(preparationId, {
    snapshot: JSON.parse(JSON.stringify(snapshot)),
    expiresAt: now + PREPARATION_TTL_MS,
  });
  return preparationId;
}

function getListingPreparation(preparationId, { now = Date.now() } = {}) {
  purgeExpired(now);
  const id = String(preparationId || "").trim();
  const entry = preparations.get(id);
  if (!entry) {
    throw new Error(
      "Die Anzeigenvorbereitung ist abgelaufen oder unbekannt. Bitte die Anzeige erneut vorbereiten."
    );
  }
  return JSON.parse(JSON.stringify(entry.snapshot));
}

function clearListingPreparations() {
  preparations.clear();
}

function preparationTechnicalFailure(error, { categoryPath = [] } = {}) {
  const rawMessage = String(error?.message || error || "Unbekannter Fehler");
  const safeMessage = /^Bild nicht gefunden:/i.test(rawMessage)
    ? "Mindestens ein ausgewähltes Bild wurde lokal nicht gefunden."
    : rawMessage;
  return {
    status: "technical_failure",
    message: "Die aktuelle Kleinanzeigen-Maske konnte nicht sicher vorbereitet werden. Es wurde nichts vorgemerkt oder veröffentlicht.",
    diagnostic: {
      code: String(error?.code || "KA_PREPARATION_FAILED"),
      step: "prepare_current_listing_form",
      category: normalizeCategoryPath(categoryPath).join(" > ") || "noch nicht gewählt",
      error: safeMessage.slice(0, 1000),
    },
    instruction:
      "Keine Kategorie-ID, Location-ID oder Formularattribute raten. Dieser Diagnoseblock kann unverändert an den Backend-Entwicklungsagenten weitergegeben werden.",
  };
}

module.exports = {
  PREPARATION_TTL_MS,
  clearListingPreparations,
  getListingPreparation,
  normalizeCategoryPath,
  preparationTechnicalFailure,
  resolveCategoryAttributes,
  storeListingPreparation,
};
