"use strict";

/**
 * Integration smoke-tests for tools/kleinanzeigen.js
 *
 * Hits the real KA API — requires a valid .env with KA_COOKIES.
 * Run: node scripts/test-tools.js
 *
 * Each test asserts the response shape is correct so regressions
 * (URL format changes, response schema changes) are caught early.
 */

require("dotenv").config();
const KA = require("../tools/kleinanzeigen");

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`${GREEN}  ✓${RESET} ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`${RED}  ✗${RESET} ${name}: ${reason}`);
  failed++;
}

function skip(name, reason) {
  console.log(`${YELLOW}  -${RESET} ${name}: skipped (${reason})`);
}

function assert(condition, name, failMsg) {
  condition ? ok(name) : fail(name, failMsg);
}

function assertShape(obj, fields, label) {
  for (const f of fields) {
    assert(f in obj, `${label}.${f} exists`, `missing field "${f}"`);
  }
}

async function run() {
  const ka = new KA(process.env.KA_COOKIES, process.env.KA_BEARER_TOKEN || null);

  console.log("\n── searchAds ──────────────────────────────────────────────");

  // Basic keyword search
  const results = await ka.searchAds({ keyword: "Tisch", limit: 5 });
  assert(Array.isArray(results),       "searchAds returns array",         "not an array");
  assert(results.length > 0,           "searchAds returns results",       `got ${results.length} results`);
  if (results.length > 0) {
    const ad = results[0];
    assertShape(ad, ["id", "title", "price", "link"], "result[0]");
    assert(typeof ad.id === "number",           "result.id is number",   typeof ad.id);
    assert(ad.link.startsWith("https://"),      "result.link is URL",    ad.link);
  }

  // Pagination
  const page2 = await ka.searchAds({ keyword: "Tisch", page: 2, limit: 5 });
  assert(Array.isArray(page2),         "searchAds page 2 returns array",  "not an array");
  assert(page2.length > 0,             "searchAds page 2 has results",    `got ${page2.length}`);

  // Category-only (no keyword)
  const catOnly = await ka.searchAds({ categoryId: 22, limit: 5 }); // 22 = Möbel & Wohnen
  assert(Array.isArray(catOnly),       "searchAds category-only returns array", "not an array");

  // No results for nonsense keyword — should return empty array, not throw
  const empty = await ka.searchAds({ keyword: "xyzzy_no_results_1234567", limit: 5 });
  assert(Array.isArray(empty),         "searchAds empty result returns array", "not an array");

  console.log("\n── getConversations ───────────────────────────────────────");

  let convs = [];
  try {
    convs = await ka.getConversations({ limit: 5 });
  } catch (e) {
    if (e.message.includes("Session abgelaufen") || e.message.includes("401")) {
      skip("getConversations", "API session expired — run node scripts/login.js");
      skip("getMessages",      "API session expired");
      console.log("\n── getMyAds ───────────────────────────────────────────────");
      const myAds2 = await ka.getMyAds({ limit: 5 }).catch(() => null);
      if (myAds2) {
        assert(Array.isArray(myAds2), "getMyAds returns array", "not an array");
        if (myAds2.length > 0) assertShape(myAds2[0], ["id", "title", "price", "status"], "myAd[0]");
        else skip("myAd shape", "no active ads");
      } else {
        skip("getMyAds", "API session expired");
      }
      console.log(`\n${passed + failed} tests — ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}\n`);
      if (failed > 0) process.exit(1);
      return;
    }
    throw e;
  }
  assert(Array.isArray(convs),         "getConversations returns array",   "not an array");
  if (convs.length > 0) {
    const c = convs[0];
    assertShape(c, ["id", "adId", "adTitle", "otherParty", "lastMessage", "unread"], "conversation[0]");
    assert(typeof c.unread === "boolean", "conversation.unread is boolean", typeof c.unread);
  } else {
    skip("conversation shape", "inbox empty");
  }

  console.log("\n── getMessages ────────────────────────────────────────────");

  if (convs.length > 0) {
    const msgs = await ka.getMessages(convs[0].id, { limit: 5 });
    assert(Array.isArray(msgs),        "getMessages returns array",        "not an array");
    if (msgs.length > 0) {
      const m = msgs[0];
      assertShape(m, ["id", "text", "sentAt", "isMe"], "message[0]");
      assert(typeof m.isMe === "boolean", "message.isMe is boolean",       typeof m.isMe);
    } else {
      skip("message shape", "conversation has no messages");
    }
  } else {
    skip("getMessages", "no conversations");
  }

  console.log("\n── getMyAds ───────────────────────────────────────────────");

  const myAds = await ka.getMyAds({ limit: 5 });
  assert(Array.isArray(myAds),         "getMyAds returns array",           "not an array");
  if (myAds.length > 0) {
    const a = myAds[0];
    assertShape(a, ["id", "title", "price", "status"], "myAd[0]");
  } else {
    skip("myAd shape", "no active ads");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests — ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error(`\n${RED}Fatal:${RESET}`, e.message);
  process.exit(1);
});
