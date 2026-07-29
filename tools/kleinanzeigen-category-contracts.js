"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_FILE = process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE
  ? path.resolve(process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE)
  : path.resolve(__dirname, "../.ka-category-contracts.json");
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const CATEGORY_CONTRACTS = new Map([
  [82, {
    categoryId: 82,
    category: "Haus & Garten > Lampen & Licht",
    verifiedAt: "2026-07-29",
    source: "Aktuelles eingeloggtes Kleinanzeigen-Webformular, read-only geprüft",
    requiredAttributes: [
      {
        key: "lampen_licht.versand",
        label: "Versand",
        values: [
          { value: "ja", label: "Versand möglich" },
          { value: "nein", label: "Nur Abholung" },
        ],
      },
    ],
  }],
  [176, {
    categoryId: 176,
    category: "Elektronik > Haushaltsgeräte",
    verifiedAt: "2026-07-29",
    source: "Aktuelles eingeloggtes Kleinanzeigen-Webformular, read-only geprüft",
    requiredAttributes: [
      {
        key: "haushaltsgeraete.art",
        label: "Art",
        values: [
          { value: "haushaltskleingeraete", label: "Haushaltskleingeräte" },
          { value: "herde_backoefen", label: "Herde & Backöfen" },
          { value: "kaffee_espressomaschinen", label: "Kaffee- & Espressomaschinen" },
          { value: "kuehlschraenke_gefriergeraete", label: "Kühlschränke & Gefriergeräte" },
          { value: "spuelmaschinen", label: "Spülmaschinen" },
          { value: "staubsauger", label: "Staubsauger" },
          { value: "waschmaschinen_trockner", label: "Waschmaschinen & Trockner" },
          { value: "sonstige", label: "Weitere Haushaltsgeräte" },
        ],
      },
      {
        key: "haushaltsgeraete.versand",
        label: "Versand",
        values: [
          { value: "ja", label: "Versand möglich" },
          { value: "nein", label: "Nur Abholung" },
        ],
      },
    ],
  }],
]);
let dynamicContracts = null;

function normalizeCategoryId(value) {
  const categoryId = Number(value);
  return Number.isInteger(categoryId) && categoryId > 0 ? categoryId : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readDynamicContracts() {
  if (dynamicContracts) return dynamicContracts;
  try {
    if (fs.statSync(CACHE_FILE).size > 1024 * 1024) {
      throw new Error("Kategorie-Cache ist größer als 1 MB.");
    }
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    dynamicContracts = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    dynamicContracts = {};
  }
  return dynamicContracts;
}

function writeDynamicContracts(contracts) {
  const directory = path.dirname(CACHE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = path.join(directory, `.${path.basename(CACHE_FILE)}.${process.pid}.tmp`);
  fs.writeFileSync(tempFile, JSON.stringify(contracts), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, CACHE_FILE);
}

function sanitizeContract(contract) {
  const categoryId = normalizeCategoryId(contract?.categoryId);
  if (!categoryId) throw new Error("Dynamischer Kategorievertrag hat keine gültige categoryId.");
  const category = String(contract.category || "").trim().slice(0, 300);
  const requiredAttributes = (contract.requiredAttributes || []).slice(0, 40).map(field => {
    const key = String(field?.key || "").trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) {
      throw new Error(`Dynamischer Kategorievertrag enthält einen ungültigen Attributnamen: ${key}`);
    }
    const seenValues = new Set();
    const values = (field.values || []).slice(0, 60).flatMap(option => {
      const value = String(option?.value ?? "");
      const label = String(option?.label ?? value).trim().slice(0, 200);
      if (value.length > 500) throw new Error(`Dynamischer Attributwert für ${key} ist zu lang.`);
      if (!value || seenValues.has(value)) return [];
      seenValues.add(value);
      return [{ value, label }];
    });
    return {
      key,
      label: String(field?.label || key).trim().slice(0, 200),
      values,
    };
  });
  const observedAt = Date.parse(contract?.verifiedAt || "");
  return {
    categoryId,
    category,
    verifiedAt: Number.isFinite(observedAt)
      ? new Date(observedAt).toISOString()
      : new Date().toISOString(),
    source: String(
      contract?.source || "Aktuelles dediziertes Kleinanzeigen-Webformular"
    ).trim().slice(0, 300),
    requiredAttributes,
  };
}

function dynamicContract(categoryId) {
  const cached = readDynamicContracts()[String(categoryId)];
  if (!cached || typeof cached !== "object") return null;
  const observedAt = Date.parse(cached.verifiedAt || "");
  if (!Number.isFinite(observedAt) || Date.now() - observedAt > CACHE_TTL_MS) return null;
  try {
    return sanitizeContract({ ...cached, categoryId });
  } catch {
    return null;
  }
}

function contractFor(categoryId) {
  return dynamicContract(categoryId) || CATEGORY_CONTRACTS.get(categoryId);
}

function rememberCategoryRequirements(contract) {
  const sanitized = sanitizeContract(contract);
  const contracts = readDynamicContracts();
  contracts[String(sanitized.categoryId)] = sanitized;
  writeDynamicContracts(contracts);
  return clone(sanitized);
}

function getCategoryRequirements(categoryId) {
  const normalizedId = normalizeCategoryId(categoryId);
  if (!normalizedId) throw new Error("categoryId ist ungültig.");
  const contract = contractFor(normalizedId);
  if (!contract) {
    return {
      categoryId: normalizedId,
      verified: false,
      requiredAttributes: [],
      instruction:
        "Für diese Kategorie ist noch kein aktueller Formularvertrag lokal verifiziert. " +
        "Keine Attributschlüssel oder Werte raten; das Formular mit dem exakten sichtbaren categoryPath prüfen.",
    };
  }
  return {
    ...clone(contract),
    verified: true,
  };
}

function validateCategoryAttributes(
  categoryId,
  attributes = {},
  { requireRequired = true, requireVerified = false } = {}
) {
  const normalizedId = normalizeCategoryId(categoryId);
  if (!normalizedId) return attributes;
  const contract = contractFor(normalizedId);
  if (!contract) {
    if (requireVerified) {
      throw new Error(
        `Kategorie ${normalizedId} wurde noch nicht anhand des aktuellen Formulars verifiziert. ` +
        "Prüfe zuerst den sichtbaren Kategoriepfad und die erlaubten Pflichtwerte; keine Werte raten."
      );
    }
    return attributes;
  }

  for (const field of contract.requiredAttributes) {
    const value = attributes[field.key];
    if (requireRequired && (value === undefined || value === null || value === "")) {
      const options = field.values.length
        ? ` Erlaubte aktuelle Werte: ${field.values
          .map(option => `${option.value} (${option.label})`).join(", ")}.`
        : "";
      throw new Error(
        `Kategorie ${normalizedId} benötigt das Attribut "${field.key}" (${field.label}).${options}`
      );
    }
    if (value === undefined || value === null || value === "") continue;
    if (!field.values.length) continue;
    const normalizedValue = String(value);
    if (!field.values.some(option => option.value === normalizedValue)) {
      const options = field.values.map(option => option.value).join(", ");
      throw new Error(
        `Attribut "${field.key}" hat für Kategorie ${normalizedId} den unbekannten Wert ` +
        `"${normalizedValue}". Erlaubt: ${options}.`
      );
    }
  }
  return attributes;
}

module.exports = {
  getCategoryRequirements,
  rememberCategoryRequirements,
  validateCategoryAttributes,
};
