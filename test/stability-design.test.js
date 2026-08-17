"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stability-"));
process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
process.env.NEMOCLAW_IMAGE_DIR = path.join(temporary, "images");
process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
process.env.NEMOCLAW_READINESS_FILE = path.join(temporary, "readiness.json");
process.env.NEMOCLAW_MODE = "dry-run";

const store = require("../tools/adstore");
const broker = require("../tools/marketplace-broker");
const media = require("../tools/media-store");
const {
  createEvidence,
  evaluatePrivateRead,
  sessionRevision,
} = require("../tools/session-readiness");
const {
  assertBoundFormState,
  normalizeFormState,
} = require("../tools/kleinanzeigen-form-state");
const {
  FINAL_STATUSES,
  enableLive,
  formatFinalStatus,
  runOnboarding,
} = require("../tools/target-mac-setup");
const agent = require("../workspace/agent");

function token({ issuedAt, expiresAt, userId = "42" }) {
  const payload = Buffer.from(JSON.stringify({
    iat: issuedAt,
    exp: expiresAt,
    "https://www.kleinanzeigen.de/user_id": userId,
  })).toString("base64url");
  return `e30.${payload}.signature`;
}

function cookieHeader(suffix = "a") {
  const now = Math.floor(Date.now() / 1000);
  return `user_id=42; access_token=${token({ issuedAt: now - 10, expiresAt: now + 7200 })}; refresh_token=${suffix}`;
}

function operation(overrides = {}) {
  return broker.prepareOperation({
    chatId: overrides.chatId || "42",
    action: overrides.action || "ka_send_message",
    canonicalPayload: overrides.payload || { conversationId: "c1", text: "Hallo" },
    mediaHashes: overrides.mediaHashes || [],
    provider: "kleinanzeigen",
    account: "42",
    mode: "live",
    preparationVersion: 1,
    sessionRevision: overrides.sessionRevision || "revision-a",
    formFingerprint: overrides.formFingerprint || "form-a",
  });
}

test.after(() => {
  store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("acceptance 1: healthy private read plus rejected proactive refresh stays degraded without login", async () => {
  let reads = 0;
  let refreshes = 0;
  const evidence = await evaluatePrivateRead({
    cookieHeader: cookieHeader(),
    privateRead: async () => { reads++; },
    proactiveRefresh: true,
    refresh: async () => {
      refreshes++;
      const error = new Error("invalid_grant");
      error.code = "KA_REFRESH_EXPIRED";
      throw error;
    },
  });
  assert.equal(evidence.state, "degraded");
  assert.equal(evidence.privateReadOk, true);
  assert.equal(reads, 1);
  assert.equal(refreshes, 1);
  assert.doesNotMatch(evidence.safeDetail, /anmelden|login/i);
});

test("acceptance 2: unusual product albums always receive research and preparation tools", () => {
  const tools = agent.toolDefinitions().map(definition => definition.function.name);
  assert.equal(tools.includes("ka_search_ads"), true);
  assert.equal(tools.includes("ka_prepare_listing"), true);
  assert.equal(tools.includes("ka_publish_prepared_listing"), true);
});

test("acceptance 3: a follow-up neither asks for tool activation nor sends an unrequested photo", async () => {
  const sent = [];
  const photos = [];
  let turns = 0;
  const llm = {
    model: "stub",
    async complete(request) {
      turns++;
      const names = request.tools.map(entry => entry.function.name);
      assert.equal(names.includes("ka_prepare_listing"), true);
      if (turns === 1) {
        return {
          message: {
            role: "assistant",
            content: "Die Tools zum Vorbereiten oder Einstellen stehen nicht zur Verfügung und müssen freigeschaltet werden.",
          },
        };
      }
      return { message: { role: "assistant", content: "Ja. Die Einschätzung beruht auf den sichtbaren Angaben." } };
    },
  };
  const gateway = {
    async send(_chat, value) { sent.push(value); },
    async sendPhoto(_chat, value) { photos.push(value); },
  };
  await agent.runAgent("follow-up", "Sicher? Woran liegt es?", { llmClient: llm, gateway });
  assert.equal(turns, 2);
  assert.equal(photos.length, 0);
  assert.doesNotMatch(sent.join("\n"), /Tool.*freischalt|Foto konnte nicht gesendet/i);
});

test("acceptance 4: incoming media survives restart and retains its hash", () => {
  const record = media.persistIncomingMedia(Buffer.from("durable-photo"), { source: "test" });
  const script = [
    `process.env.NEMOCLAW_DB_PATH=${JSON.stringify(process.env.NEMOCLAW_DB_PATH)};`,
    `process.env.NEMOCLAW_IMAGE_DIR=${JSON.stringify(process.env.NEMOCLAW_IMAGE_DIR)};`,
    `const media=require(${JSON.stringify(path.resolve(__dirname, "../tools/media-store.js"))});`,
    `process.stdout.write(JSON.stringify(media.resolveMediaAsset(${JSON.stringify(record.mediaId)})));`,
  ].join("");
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.mediaId, record.mediaId);
  assert.equal(restored.sha256, record.sha256);
  assert.equal(restored.availability, "available");
});

test("acceptance 5: visible form location binds without a configured location ID", () => {
  delete process.env.KA_DEFAULT_LOCATION_ID;
  const state = normalizeFormState({
    categoryId: 87,
    zipCode: "80636",
    locationId: "opaque-provider-value",
    locationName: "München-Neuhausen",
    contactName: "Jannik",
    sessionRevision: "revision-a",
  });
  assert.equal(state.locationName, "München-Neuhausen");
  assert.match(state.formFingerprint, /^[a-f0-9]{64}$/);
});

test("acceptance 6: location drift blocks the write and yields new bindable form evidence", () => {
  const preview = normalizeFormState({
    categoryId: 87, zipCode: "80636", locationId: "one", locationName: "München", sessionRevision: "rev",
  });
  const changed = normalizeFormState({
    categoryId: 87, zipCode: "14467", locationId: "two", locationName: "Potsdam", sessionRevision: "rev",
  });
  assert.throws(
    () => assertBoundFormState(preview, changed),
    error => error.code === "KA_FORM_STATE_DRIFT"
      && error.definitiveNoWrite === true
      && error.formState.locationName === "Potsdam"
  );
});

test("acceptance 7: two concurrent Go claims start at most one operation", async () => {
  const prepared = operation({ chatId: "concurrent-go", payload: { text: "once" } });
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => broker.claimApproval(prepared.id, { currentMode: "live" })),
    Promise.resolve().then(() => broker.claimApproval(prepared.id, { currentMode: "live" })),
  ]);
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(item => item.status === "rejected").length, 1);
});

test("supporting approval binding: a changed session consumes the old approval without a write", () => {
  const prepared = operation({ chatId: "session-drift", sessionRevision: "revision-a" });
  assert.throws(
    () => broker.claimApproval(prepared.id, {
      currentMode: "live",
      currentAccount: "42",
      currentSessionRevision: "revision-b",
    }),
    error => error.code === "OPERATION_SESSION_CHANGED"
  );
  assert.equal(broker.getOperation(prepared.id).status, "cancelled");
});

test("acceptance 8: restart during upload becomes reconcile-required and never replays commit", () => {
  const prepared = operation({ chatId: "upload-restart", payload: { text: "upload" } });
  broker.claimApproval(prepared.id, { currentMode: "live" });
  broker.markOperationPhase(prepared.id, "upload");
  assert.equal(broker.recoverInterruptedOperations() >= 1, true);
  const recovered = broker.getOperation(prepared.id);
  assert.equal(recovered.status, "reconcile_required");
  assert.equal(recovered.phase, "reconcile");
});

test("acceptance 9: remote success with local failure is reconciled exactly once", async () => {
  const prepared = operation({ chatId: "local-failure", payload: { text: "remote-success" } });
  broker.claimApproval(prepared.id, { currentMode: "live" });
  broker.markOperationPhase(prepared.id, "local_persist");
  broker.requireReconciliation(prepared.id, { reason: "db unavailable" }, { remoteId: "remote-1" });
  let reconciliations = 0;
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const reconcile = async () => {
    reconciliations++;
    await readGate;
    return { status: "completed", remoteId: "remote-1", evidence: { observed: true } };
  };
  const first = broker.reconcileOperation(prepared.id, reconcile);
  const concurrent = await broker.reconcileOperation(prepared.id, reconcile);
  assert.equal(concurrent.status, "reconciling");
  releaseRead();
  assert.equal((await first).status, "completed");
  assert.equal((await broker.reconcileOperation(prepared.id, reconcile)).status, "completed");
  assert.equal(reconciliations, 1);
});

test("acceptance 10: onboard emits one understandable final status with at most one action", async () => {
  const result = await runOnboarding({
    ensureDryRun: async () => {},
    checkLocal: async () => ({ ok: true }),
    verifyTelegram: async () => ({ ok: false, detail: "Telegram fehlt.", action: "Token setzen." }),
    evaluateAccount: async () => { throw new Error("must not run"); },
    startDryRunService: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.status, FINAL_STATUSES.blocked);
  assert.equal(formatFinalStatus(result).match(/Nächste Handlung:/g).length, 1);
  assert.equal(formatFinalStatus(result).split("\n").length, 1);
});

test("supporting onboarding safety: a healthy private read starts dry-run without opening the listing form", async () => {
  let savedEvidence = null;
  let serviceStarts = 0;
  let formChecks = 0;
  const evidence = createEvidence({
    sessionRevision: "onboard-session",
    account: "42",
    privateReadOk: true,
  });
  const result = await runOnboarding({
    ensureDryRun: async () => {},
    checkLocal: async () => ({ ok: true }),
    verifyTelegram: async () => ({ ok: true }),
    ensureSession: async () => ({ ok: true }),
    evaluateAccount: async () => evidence,
    verifyVisibleForm: async () => { formChecks++; throw new Error("must not run"); },
    saveEvidence: value => { savedEvidence = value; },
    startDryRunService: async () => { serviceStarts++; return { ok: true }; },
  });
  assert.equal(result.status, FINAL_STATUSES.ready);
  assert.equal(formChecks, 0);
  assert.equal(serviceStarts, 1);
  assert.equal(savedEvidence, evidence);
  assert.match(result.detail, /Formularprüfung erfolgt mit dem ersten echten Telegram-Vorschlag/);
});

test("acceptance 11: live activation refreshes stale session evidence exactly once", async () => {
  const cookies = cookieHeader("current");
  const revision = sessionRevision(cookies);
  const fresh = createEvidence({
    sessionRevision: revision,
    account: "42",
    privateReadOk: true,
    refreshAttempted: true,
    refreshOk: true,
    formFingerprint: "a".repeat(64),
  });
  let state = {
    doctorEvidence: { ...fresh, sessionRevision: "older-revision" },
    telegramDryRunProposal: {
      complete: true,
      sessionRevision: revision,
      formFingerprint: "a".repeat(64),
    },
  };
  let refreshes = 0;
  let liveWrites = 0;
  const result = await enableLive({
    cookieHeader: cookies,
    readState: () => state,
    refreshEvidence: async () => {
      refreshes++;
      state = { ...state, doctorEvidence: fresh };
      return fresh;
    },
    unresolved: () => [],
    setLiveMode: async () => { liveWrites++; },
    restartService: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(refreshes, 1);
  assert.equal(liveWrites, 1);
});

test("supporting activation safety: a restart exception restores dry-run", async () => {
  const cookies = cookieHeader("restart-failure");
  const revision = sessionRevision(cookies);
  const formFingerprint = "b".repeat(64);
  const evidence = createEvidence({
    sessionRevision: revision,
    account: "42",
    privateReadOk: true,
    refreshAttempted: true,
    refreshOk: true,
    formFingerprint,
  });
  let dryRunRestores = 0;
  const result = await enableLive({
    cookieHeader: cookies,
    readState: () => ({
      doctorEvidence: evidence,
      telegramDryRunProposal: { complete: true, sessionRevision: revision, formFingerprint },
    }),
    refreshEvidence: async () => { throw new Error("must not refresh"); },
    unresolved: () => [],
    setLiveMode: async () => {},
    setDryRunMode: async () => { dryRunRestores++; },
    restartService: async () => { throw new Error("launchd failed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "restart_failed");
  assert.equal(dryRunRestores, 1);
});
