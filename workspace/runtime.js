"use strict";

const fs = require("fs");
const path = require("path");

function isExplicitApproval(message) {
  return /^\s*go(?:\s+bitte|\s+jetzt)?[.!]?\s*$/i.test(String(message || ""));
}

function parseClaudeResponse(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("Claude CLI hat eine leere Antwort geliefert.");

  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") continue;
      return parsed;
    } catch (_) {}
  }
  throw new Error(`Claude CLI lieferte kein gültiges JSON: ${withoutFence.slice(0, 300)}`);
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
  atomicWriteJson,
  boundedJson,
  createSerialExecutor,
  isExplicitApproval,
  parseAllowedChatIds,
  parseClaudeResponse,
  validateStorageKey,
};
