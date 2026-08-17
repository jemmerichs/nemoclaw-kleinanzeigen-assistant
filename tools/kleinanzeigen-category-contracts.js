"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE_FILE = process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE
  ? path.resolve(process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE)
  : path.resolve(__dirname, "../.ka-category-contracts.json");
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CONTRACT_INSPECTION_VERSION = 3;

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

function cachedEntry(categoryId) {
  const entry = readDynamicContracts()[String(categoryId)];
  return entry && typeof entry === "object" ? entry : null;
}

function contractFingerprint(contract) {
  if (!contract) return "";
  const value = {
    categoryId: normalizeCategoryId(contract.categoryId),
    inspectionVersion: Number(contract.inspectionVersion) || 0,
    requiredAttributes: Array.isArray(contract.requiredAttributes)
      ? contract.requiredAttributes
      : [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validationRejection(validationErrors = []) {
  const errors = Array.isArray(validationErrors) ? validationErrors.slice(0, 20) : [];
  const combined = errors.map(error => (
    `${String(error?.field || "")} ${String(error?.message || "")}`
  )).join(" ");
  return {
    relevant: errors.some(error => /attributeMap|categoryId/i.test(String(error?.field || "")))
      || /versand|shipping/i.test(combined),
    attributeRejected: errors.some(error => /attributeMap/i.test(String(error?.field || ""))),
    capabilities: [
      /versand|shipping/i.test(combined) ? "shipping" : null,
    ].filter(Boolean),
  };
}

function invalidationFor(categoryId) {
  const entry = cachedEntry(categoryId);
  if (!entry?.invalidatedAt) return null;
  return {
    invalidatedAt: String(entry.invalidatedAt),
    rejectedContractFingerprint: String(entry.rejectedContractFingerprint || ""),
    attributeRejected: entry.attributeRejected === true,
    capabilities: Array.isArray(entry.requiredCapabilities)
      ? entry.requiredCapabilities.filter(value => value === "shipping")
      : [],
  };
}

function fieldProvidesCapability(field, capability) {
  if (capability !== "shipping") return false;
  return /versand|shipping/i.test(`${String(field?.key || "")} ${String(field?.label || "")}`)
    && Array.isArray(field?.values)
    && field.values.length > 0;
}

function assertRefreshResolvesInvalidation(contract, invalidation) {
  if (!invalidation) return;
  const missingCapabilities = invalidation.capabilities.filter(capability => (
    !contract.requiredAttributes.some(field => fieldProvidesCapability(field, capability))
  ));
  if (missingCapabilities.length) {
    const error = new Error(
      "Die aktuelle Formularinspektion konnte das zuvor serverseitig verlangte Versandfeld " +
      "nicht mit seinen sichtbaren erlaubten Werten verifizieren. Der Kategorievertrag bleibt gesperrt."
    );
    error.code = "KA_CATEGORY_INSPECTION_INCOMPLETE";
    error.categoryId = contract.categoryId;
    error.missingCapabilities = missingCapabilities;
    throw error;
  }
  if (invalidation.attributeRejected && !contract.requiredAttributes.length) {
    const error = new Error(
      "Die aktuelle Formularinspektion fand weiterhin keine Pflichtattribute, obwohl Kleinanzeigen zuvor " +
      "ein Kategorieattribut verlangt hat. Der Kategorievertrag bleibt gesperrt."
    );
    error.code = "KA_CATEGORY_INSPECTION_INCOMPLETE";
    error.categoryId = contract.categoryId;
    throw error;
  }
  if (
    invalidation.rejectedContractFingerprint
    && contractFingerprint(contract) === invalidation.rejectedContractFingerprint
  ) {
    const error = new Error(
      "Die aktuelle Formularinspektion lieferte unverändert denselben Kategorievertrag, den Kleinanzeigen " +
      "zuvor abgelehnt hat. Der Kategorievertrag bleibt bis zu einer vollständigeren Inspektion gesperrt."
    );
    error.code = "KA_CATEGORY_INSPECTION_INCOMPLETE";
    error.categoryId = contract.categoryId;
    throw error;
  }
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
  const knownContract = CATEGORY_CONTRACTS.get(categoryId);
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
    const rawLabel = String(field?.label || "").trim();
    const knownLabel = knownContract?.requiredAttributes.find(
      knownField => knownField.key === key
    )?.label;
    return {
      key,
      label: String(!rawLabel || rawLabel === key ? knownLabel || key : rawLabel)
        .trim().slice(0, 200),
      values,
    };
  });
  const observedAt = Date.parse(contract?.verifiedAt || "");
  return {
    categoryId,
    category,
    inspectionVersion: CONTRACT_INSPECTION_VERSION,
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
  const cached = cachedEntry(categoryId);
  if (!cached || typeof cached !== "object") return null;
  if (cached.invalidatedAt) return null;
  if (Number(cached.inspectionVersion) !== CONTRACT_INSPECTION_VERSION) return null;
  const observedAt = Date.parse(cached.verifiedAt || "");
  if (!Number.isFinite(observedAt) || Date.now() - observedAt > CACHE_TTL_MS) return null;
  try {
    return sanitizeContract({ ...cached, categoryId });
  } catch {
    return null;
  }
}

function contractFor(categoryId) {
  if (invalidationFor(categoryId)) return null;
  return dynamicContract(categoryId) || CATEGORY_CONTRACTS.get(categoryId);
}

function rememberCategoryRequirements(contract) {
  const sanitized = sanitizeContract(contract);
  assertRefreshResolvesInvalidation(sanitized, invalidationFor(sanitized.categoryId));
  const contracts = readDynamicContracts();
  contracts[String(sanitized.categoryId)] = sanitized;
  writeDynamicContracts(contracts);
  return clone(sanitized);
}

function invalidateCategoryRequirements(categoryId, validationErrors = []) {
  const normalizedId = normalizeCategoryId(categoryId);
  if (!normalizedId) throw new Error("categoryId ist ungültig.");
  const rejection = validationRejection(validationErrors);
  if (!rejection.relevant) return { categoryId: normalizedId, invalidated: false };

  const contracts = readDynamicContracts();
  const existing = cachedEntry(normalizedId);
  let previousCachedContract = null;
  try {
    if (existing?.requiredAttributes) {
      previousCachedContract = sanitizeContract({ ...existing, categoryId: normalizedId });
    }
  } catch {}
  const currentContract = contractFor(normalizedId) || previousCachedContract;
  const existingCapabilities = Array.isArray(existing?.requiredCapabilities)
    ? existing.requiredCapabilities.filter(value => value === "shipping")
    : [];
  contracts[String(normalizedId)] = {
    ...(existing || (currentContract ? clone(currentContract) : { categoryId: normalizedId })),
    categoryId: normalizedId,
    invalidatedAt: new Date().toISOString(),
    rejectedContractFingerprint: String(
      existing?.rejectedContractFingerprint || contractFingerprint(currentContract)
    ),
    attributeRejected: existing?.attributeRejected === true || rejection.attributeRejected,
    requiredCapabilities: [...new Set([...existingCapabilities, ...rejection.capabilities])],
  };
  writeDynamicContracts(contracts);
  return {
    categoryId: normalizedId,
    invalidated: true,
    requiredCapabilities: rejection.capabilities,
  };
}

function getCategoryRequirements(categoryId) {
  const normalizedId = normalizeCategoryId(categoryId);
  if (!normalizedId) throw new Error("categoryId ist ungültig.");
  const contract = contractFor(normalizedId);
  if (!contract) {
    const invalidation = invalidationFor(normalizedId);
    if (invalidation) {
      const requirements = invalidation.capabilities.includes("shipping")
        ? " Dabei muss insbesondere das sichtbare Versandfeld mit seinen erlaubten Werten erfasst werden."
        : "";
      return {
        categoryId: normalizedId,
        verified: false,
        invalidated: true,
        requiredAttributes: [],
        instruction:
          "Kleinanzeigen hat den bisherigen Kategorievertrag serverseitig abgelehnt. " +
          `Das aktuelle Formular muss vollständig neu inspiziert werden.${requirements}`,
      };
    }
    const staleEntry = cachedEntry(normalizedId);
    if (staleEntry && Number(staleEntry.inspectionVersion) !== CONTRACT_INSPECTION_VERSION) {
      return {
        categoryId: normalizedId,
        verified: false,
        stale: true,
        requiredAttributes: [],
        instruction:
          "Der gespeicherte Kategorievertrag stammt aus einer älteren Formularinspektion. " +
          "Das aktuelle sichtbare Formular muss vor der nächsten Veröffentlichung einmal neu geprüft werden.",
      };
    }
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

function applyCategoryPreferences(categoryId, attributes = {}) {
  const normalizedId = normalizeCategoryId(categoryId);
  const preferred = attributes && typeof attributes === "object" && !Array.isArray(attributes)
    ? { ...attributes }
    : {};
  if (!normalizedId) return preferred;
  const contract = contractFor(normalizedId);
  if (!contract) return preferred;

  for (const field of contract.requiredAttributes) {
    if (preferred[field.key] !== undefined && preferred[field.key] !== null && preferred[field.key] !== "") {
      continue;
    }
    if (!/versand/i.test(String(field.label || field.key))) continue;
    const pickup = field.values.find(option => (
      /^(?:nur\s+)?abholung$/i.test(option.label.trim())
      || String(option.value).trim().toLowerCase() === "nein"
    ));
    if (pickup) preferred[field.key] = pickup.value;
  }
  return preferred;
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
      const invalidation = invalidationFor(normalizedId);
      if (invalidation) {
        const requirement = invalidation.capabilities.includes("shipping")
          ? " Das sichtbare Versandfeld und seine erlaubten Werte wurden noch nicht neu verifiziert."
          : "";
        throw new Error(
          `Kategorie ${normalizedId} ist nach einer serverseitigen Formularablehnung gesperrt.` +
          `${requirement} Prüfe zuerst das aktuelle sichtbare Kategorieformular; keine Werte raten.`
        );
      }
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
  applyCategoryPreferences,
  getCategoryRequirements,
  invalidateCategoryRequirements,
  rememberCategoryRequirements,
  validateCategoryAttributes,
};
