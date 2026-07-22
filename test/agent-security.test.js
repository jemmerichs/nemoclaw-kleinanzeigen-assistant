"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { TOOLS, setCookie, validateConfig } = require("../workspace/agent");

test("every externally destructive bridge tool requires approval", () => {
  for (const name of ["ka_send_message", "ka_create_ad", "ka_delete_draft", "updateSkillFile"]) {
    assert.equal(TOOLS[name].requiresApproval, true, `${name} must require Go`);
  }
  assert.equal(TOOLS.ka_save_draft.requiresApproval, undefined, "non-public drafts remain pre-approval work");
});

test("token refresh inserts missing cookies and replaces existing values", () => {
  assert.equal(setCookie("user_id=42", "access_token", "new"), "user_id=42; access_token=new");
  assert.equal(setCookie("access_token=old; user_id=42", "access_token", "new"), "user_id=42; access_token=new");
});

test("startup rejects placeholder IDs and heartbeat recipients outside the allowlist", () => {
  const previous = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    allowed: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    allowedMany: process.env.TELEGRAM_ALLOWED_CHAT_IDS,
    heartbeat: process.env.TELEGRAM_HEARTBEAT_CHAT_ID,
  };
  try {
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    process.env.TELEGRAM_BOT_TOKEN = "your_token_here";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "not-a-number";
    assert.throws(() => validateConfig(), /TOKEN fehlt oder ist ungültig.*CHAT_ID fehlt oder ist ungültig/);

    process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "42";
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = "43";
    assert.throws(() => validateConfig(), /HEARTBEAT_CHAT_ID muss/);
  } finally {
    if (previous.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous.token;
    if (previous.allowed === undefined) delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
    else process.env.TELEGRAM_ALLOWED_CHAT_ID = previous.allowed;
    if (previous.allowedMany === undefined) delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    else process.env.TELEGRAM_ALLOWED_CHAT_IDS = previous.allowedMany;
    if (previous.heartbeat === undefined) delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;
    else process.env.TELEGRAM_HEARTBEAT_CHAT_ID = previous.heartbeat;
  }
});
