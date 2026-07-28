"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

function isExplicitApproval(message) {
  return /^\s*go(?:\s+bitte|\s+jetzt)?[.!]?\s*$/i.test(String(message || ""));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function actionFingerprint(tool, args) {
  return crypto
    .createHash("sha256")
    .update(`${String(tool)}\n${stableJson(args || {})}`)
    .digest("hex")
    .slice(0, 12);
}

function parseToolArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error("Tool-Argumente haben ein ungültiges Format.");
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`Tool-Argumente sind kein gültiges JSON: ${value.slice(0, 200)}`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool-Argumente müssen ein JSON-Objekt sein.");
  }
  return parsed;
}

function validateSchema(value, schema, field = "Argumente") {
  if (!schema || typeof schema !== "object") return value;
  const type = schema.type;
  const actualType = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;

  if (type === "object") {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`${field} muss ein Objekt sein.`);
    }
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        throw new Error(`${field}.${required} fehlt.`);
      }
    }
    const keys = Object.keys(value);
    if (Number.isFinite(schema.maxProperties) && keys.length > schema.maxProperties) {
      throw new Error(`${field} enthält zu viele Felder.`);
    }
    for (const key of keys) {
      if (properties[key]) {
        validateSchema(value[key], properties[key], `${field}.${key}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${field}.${key} ist nicht erlaubt.`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchema(value[key], schema.additionalProperties, `${field}.${key}`);
      }
    }
    return value;
  }

  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${field} muss eine Liste sein.`);
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      throw new Error(`${field} enthält zu wenige Einträge.`);
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      throw new Error(`${field} enthält zu viele Einträge.`);
    }
    value.forEach((entry, index) => validateSchema(entry, schema.items, `${field}[${index}]`));
    return value;
  }

  if (type === "integer" && actualType !== "integer") {
    throw new Error(`${field} muss eine ganze Zahl sein.`);
  }
  if (type === "number" && !["number", "integer"].includes(actualType)) {
    throw new Error(`${field} muss eine Zahl sein.`);
  }
  if (type === "string" && actualType !== "string") {
    throw new Error(`${field} muss Text sein.`);
  }
  if (type === "boolean" && actualType !== "boolean") {
    throw new Error(`${field} muss true oder false sein.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${field} hat keinen erlaubten Wert.`);
  }
  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      throw new Error(`${field} ist zu kurz.`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      throw new Error(`${field} ist zu lang.`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      throw new Error(`${field} hat ein ungültiges Format.`);
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} muss eine endliche Zahl sein.`);
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new Error(`${field} ist zu klein.`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      throw new Error(`${field} ist zu groß.`);
    }
  }
  return value;
}

function extractImagePaths(message, maxImages = 6) {
  const paths = [];
  const regex = /\[FOTO path:([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(String(message || ""))) !== null && paths.length < maxImages) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function normalizeMode(value) {
  const mode = String(value || "dry-run").trim().toLowerCase();
  if (!["dry-run", "live"].includes(mode)) {
    throw new Error("NEMOCLAW_MODE muss 'dry-run' oder 'live' sein.");
  }
  return mode;
}

function normalizeComplexityRouting(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!["off", "manual", "auto"].includes(mode)) {
    throw new Error("NEMOCLAW_COMPLEXITY_ROUTING muss 'off', 'manual' oder 'auto' sein.");
  }
  return mode;
}

function normalizeInboxPollMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 45;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 15 || parsed > 360) {
    throw new Error("NEMOCLAW_INBOX_POLL_MINUTES muss 0 oder eine Zahl zwischen 15 und 360 sein.");
  }
  return parsed;
}

function randomInboxIntervalMs(minutes, random = Math.random) {
  const normalized = normalizeInboxPollMinutes(minutes);
  if (normalized === 0) return null;
  const unit = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = 0.8 + unit * 0.4;
  return Math.round(normalized * 60 * 1000 * jitter);
}

function normalizeListingPollMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 360;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 30 || parsed > 1440) {
    throw new Error("NEMOCLAW_LISTING_POLL_MINUTES muss 0 oder eine Zahl zwischen 30 und 1440 sein.");
  }
  return parsed;
}

function randomListingIntervalMs(minutes, random = Math.random) {
  const normalized = normalizeListingPollMinutes(minutes);
  if (normalized === 0) return null;
  const unit = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = 0.85 + unit * 0.3;
  return Math.round(normalized * 60 * 1000 * jitter);
}

function selectModelRoute(message, routingMode = "auto") {
  const mode = normalizeComplexityRouting(routingMode);
  const original = String(message || "");
  const highDirective = original.match(/^\s*\/high(?:\s+([\s\S]*))?$/i);
  const fastDirective = original.match(/^\s*\/(?:fast|low)(?:\s+([\s\S]*))?$/i);
  const stripped = highDirective?.[1] ?? fastDirective?.[1] ?? original;

  if (mode === "off") return { tier: "fast", score: 0, reason: "routing-off", message: original };
  if (highDirective) return { tier: "high", score: 99, reason: "explicit-high", message: stripped.trim() };
  if (fastDirective) return { tier: "fast", score: 0, reason: "explicit-fast", message: stripped.trim() };
  if (mode === "manual") return { tier: "fast", score: 0, reason: "manual-default", message: original };
  if (/^\s*Automatischer (?:Inbox|Anzeigen-Lifecycle)-Check:/i.test(original)) {
    return { tier: "fast", score: 0, reason: "heartbeat", message: original };
  }

  let score = 0;
  const reasons = [];
  const photoCount = (original.match(/\[FOTO path:[^\]]+\]/g) || []).length;
  if (photoCount >= 10) {
    score += 3;
    reasons.push("many-photos");
  } else if (photoCount >= 4) {
    score += 2;
    reasons.push("several-photos");
  }
  if (original.length > 1800) {
    score += 1;
    reasons.push("long-context");
  }
  if (/\b(mehrere|alle|batch|stapel|sammlung|konvolut|multiple)\b.{0,40}\b(artikel|anzeigen|gegenstände|items|listings)\b/i.test(original)) {
    score += 2;
    reasons.push("multi-item");
  }
  if (/\b(komplex|strategie|verhandlungsstrategie|authentizität|widersprüch|mehrstufig|vollständige[rn]? workflow|complex|strategy|authenticity|conflicting|multi-step)\b/i.test(original)) {
    score += 2;
    reasons.push("complex-intent");
  }
  if (/\b(vergleiche|bewerte|analysiere|compare|evaluate|analyze)\b[\s\S]{0,250}\b(und|sowie|gegen|then|and|versus|vs\.?)\b/i.test(original)) {
    score += 1;
    reasons.push("compound-analysis");
  }
  return {
    tier: score >= 4 ? "high" : "fast",
    score,
    reason: reasons.join(",") || "simple-default",
    message: original,
  };
}

function validateStorageKey(key) {
  const value = String(key || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
    throw new Error("Key muss aus 1–64 Buchstaben, Zahlen, '-' oder '_' bestehen.");
  }
  return value;
}

function parseAllowedChatIds(value) {
  return new Set(String(value || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean));
}

function boundedJson(value, maxLength = 30000) {
  let json;
  try { json = JSON.stringify(value); }
  catch { json = JSON.stringify({ error: "Tool-Ergebnis konnte nicht serialisiert werden." }); }
  if (json.length <= maxLength) return json;
  return JSON.stringify({
    truncated: true,
    originalLength: json.length,
    preview: json.slice(0, maxLength),
  });
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tempFile, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, filePath);
}

function createSerialExecutor() {
  const pending = new Map();
  return function enqueue(key, task) {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    pending.set(key, current);
    current.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    }).catch(() => {});
    return current;
  };
}

module.exports = {
  actionFingerprint,
  atomicWriteJson,
  boundedJson,
  createSerialExecutor,
  extractImagePaths,
  isExplicitApproval,
  normalizeComplexityRouting,
  normalizeInboxPollMinutes,
  normalizeListingPollMinutes,
  normalizeMode,
  parseAllowedChatIds,
  parseToolArguments,
  randomInboxIntervalMs,
  randomListingIntervalMs,
  selectModelRoute,
  stableJson,
  validateSchema,
  validateStorageKey,
};
