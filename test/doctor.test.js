"use strict";

const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const doctor = path.join(root, "scripts", "doctor.js");

function doctorEnv() {
  return {
    ...process.env,
    OPENROUTER_API_KEY: `sk-or-v1-${"a".repeat(64)}`,
    OPENROUTER_MODEL: "google/gemini-3.6-flash",
    OPENROUTER_REASONING_EFFORT: "minimal",
    OPENROUTER_DAILY_BUDGET_USD: "100",
    OPENROUTER_TOTAL_BUDGET_USD: "1000",
    NEMOCLAW_COMPLEXITY_ROUTING: "off",
    NEMOCLAW_MODE: "dry-run",
    TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
    TELEGRAM_ALLOWED_CHAT_ID: "42",
    TELEGRAM_ALLOWED_CHAT_IDS: "",
    TELEGRAM_HEARTBEAT_CHAT_ID: "",
    NEMOCLAW_INBOX_POLL_MINUTES: "45",
    NEMOCLAW_LISTING_POLL_MINUTES: "360",
    KA_COOKIES: "",
    KA_BEARER_TOKEN: "",
    KA_USER_AGENT: "",
    VINTED_COOKIES: "",
    VINTED_USER_ID: "",
  };
}

test("Telegram startup remains available without a marketplace session", () => {
  const result = spawnSync(process.execPath, [doctor, "--telegram"], {
    cwd: root,
    encoding: "utf8",
    env: doctorEnv(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /• Kleinanzeigen-Session: fehlt — Bot startet trotzdem/);
  assert.match(result.stdout, /• Kontoaktionen: nicht bereit/);
  assert.match(result.stdout, /✓ Telegram-Betrieb: bereit/);
});

test("strict account installation gate still rejects a missing session", () => {
  const result = spawnSync(process.execPath, [doctor, "--telegram", "--account"], {
    cwd: root,
    encoding: "utf8",
    env: doctorEnv(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ Kleinanzeigen-Session: fehlt/);
  assert.match(result.stdout, /✗ Kontoaktionen: nicht bereit/);
  assert.match(result.stdout, /✓ Telegram-Betrieb: bereit/);
});
