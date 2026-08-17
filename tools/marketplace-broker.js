"use strict";

const crypto = require("crypto");

const { databaseForHostState } = require("./adstore");
const { classifyError } = require("./safe-error");
const { stableJson } = require("../workspace/runtime");

const BLOCKING_AMBIGUOUS_STATUSES = Object.freeze([
  "request_started",
  "reconcile_required",
  "reconciling",
  "manual_resolution",
]);
const PENDING_STATUS = "awaiting_approval";

function nowIso(now = Date.now()) {
  return new Date(Number(now)).toISOString();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function operationFromRow(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    id: row.operation_id,
    chatId: row.chat_id,
    payloadFingerprint: row.payload_fingerprint,
    provider: row.provider,
    tool: row.action,
    action: row.action,
    account: row.account,
    mode: row.policy_mode,
    status: row.status,
    phase: row.phase,
    writeCertainty: row.write_certainty,
    args: parseJson(row.canonical_payload_json, {}),
    materials: parseJson(row.media_hashes_json, []),
    preparationVersion: Number(row.preparation_version),
    sessionRevision: row.session_revision,
    formFingerprint: row.form_fingerprint,
    remoteId: row.remote_id,
    reconciliation: parseJson(row.reconciliation_json, null),
    cancelReason: row.cancel_reason,
    createdAt: Date.parse(row.created_at),
    expiresAt: Date.parse(row.expires_at),
    requestStartedAt: row.request_started_at,
    completedAt: row.completed_at,
  };
}

function canonicalBinding({
  action,
  canonicalPayload,
  mediaHashes = [],
  provider,
  account,
  mode,
  preparationVersion,
  sessionRevision,
  formFingerprint,
}) {
  return {
    action: String(action),
    canonicalPayload: canonicalPayload || {},
    mediaHashes: (mediaHashes || []).map(item => ({
      mediaId: String(item.mediaId || ""),
      sha256: String(item.sha256 || ""),
      byteSize: Number(item.byteSize ?? item.size ?? 0),
    })),
    provider: String(provider || "local"),
    account: String(account || "local"),
    mode: String(mode || "dry-run"),
    preparationVersion: Number(preparationVersion || 1),
    sessionRevision: String(sessionRevision || "none"),
    formFingerprint: String(formFingerprint || "none"),
  };
}

function payloadFingerprint(binding) {
  return crypto.createHash("sha256").update(stableJson(binding)).digest("hex");
}

function prepareOperation({
  chatId,
  action,
  canonicalPayload,
  mediaHashes = [],
  provider = "local",
  account = "local",
  mode = "dry-run",
  preparationVersion = 1,
  sessionRevision = "none",
  formFingerprint = "none",
  ttlMs = 30 * 60 * 1000,
  now = Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const db = databaseForHostState();
  const binding = canonicalBinding({
    action,
    canonicalPayload,
    mediaHashes,
    provider,
    account,
    mode,
    preparationVersion,
    sessionRevision,
    formFingerprint,
  });
  const fingerprint = payloadFingerprint(binding);
  const operationId = randomBytes(16).toString("hex");
  const createdAt = nowIso(now);
  const expiresAt = nowIso(Number(now) + Number(ttlMs));
  const transaction = db.transaction(() => {
    const blocked = db.prepare(`
      SELECT operation_id,status FROM external_operations
      WHERE payload_fingerprint=? AND status IN (${BLOCKING_AMBIGUOUS_STATUSES.map(() => "?").join(",")})
      ORDER BY created_at DESC LIMIT 1
    `).get(fingerprint, ...BLOCKING_AMBIGUOUS_STATUSES);
    if (blocked) {
      const error = new Error(
        `Die unveränderte Aktion ${operationId.slice(0, 12)} ist nach einem unklaren externen Ergebnis gesperrt.`
      );
      error.code = "OPERATION_FINGERPRINT_BLOCKED";
      error.operationId = blocked.operation_id;
      throw error;
    }
    db.prepare(`
      UPDATE external_operations
      SET status='cancelled',phase='preflight',write_certainty='definitive_no_write',
          cancel_reason='superseded',updated_at=?
      WHERE chat_id=? AND status=?
    `).run(createdAt, String(chatId), PENDING_STATUS);
    db.prepare(`
      INSERT INTO external_operations (
        operation_id,chat_id,payload_fingerprint,provider,action,account,policy_mode,
        status,phase,write_certainty,canonical_payload_json,media_hashes_json,
        preparation_version,session_revision,form_fingerprint,expires_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'awaiting_approval','preflight','definitive_no_write',?,?,?,?,?,?,?,?)
    `).run(
      operationId,
      String(chatId),
      fingerprint,
      binding.provider,
      binding.action,
      binding.account,
      binding.mode,
      JSON.stringify(canonicalPayload || {}),
      JSON.stringify(mediaHashes || []),
      binding.preparationVersion,
      binding.sessionRevision,
      binding.formFingerprint,
      expiresAt,
      createdAt,
      createdAt
    );
    return db.prepare("SELECT * FROM external_operations WHERE operation_id=?").get(operationId);
  });
  return operationFromRow(transaction());
}

function getOperation(operationId) {
  return operationFromRow(
    databaseForHostState().prepare("SELECT * FROM external_operations WHERE operation_id=?")
      .get(String(operationId || ""))
  );
}

function cancelOperation(operationId, reason = "cancelled", { now = Date.now() } = {}) {
  const result = databaseForHostState().prepare(`
    UPDATE external_operations
    SET status='cancelled',phase='preflight',write_certainty='definitive_no_write',
        cancel_reason=?,updated_at=?
    WHERE operation_id=? AND status=?
  `).run(String(reason).slice(0, 80), nowIso(now), String(operationId), PENDING_STATUS);
  return result.changes === 1;
}

function cancelPendingForChat(chatId, reason = "cancelled") {
  const rows = databaseForHostState().prepare(`
    SELECT operation_id FROM external_operations
    WHERE chat_id=? AND status=?
  `).all(String(chatId), PENDING_STATUS);
  for (const row of rows) cancelOperation(row.operation_id, reason);
  return rows.length > 0;
}

function getPendingForChat(chatId, { now = Date.now() } = {}) {
  const db = databaseForHostState();
  const row = db.prepare(`
    SELECT * FROM external_operations
    WHERE chat_id=? AND status=?
    ORDER BY created_at DESC LIMIT 1
  `).get(String(chatId), PENDING_STATUS);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Number(now)) {
    cancelOperation(row.operation_id, "expired", { now });
    return null;
  }
  return operationFromRow(row);
}

function claimApproval(operationId, {
  currentMode,
  currentAccount = null,
  currentSessionRevision = null,
  now = Date.now(),
} = {}) {
  const db = databaseForHostState();
  const transaction = db.transaction(() => {
    const row = db.prepare("SELECT * FROM external_operations WHERE operation_id=?")
      .get(String(operationId));
    if (!row || row.status !== PENDING_STATUS) {
      const error = new Error("Die Freigabe ist nicht mehr verfügbar.");
      error.code = "OPERATION_ALREADY_CLAIMED";
      throw error;
    }
    const reject = (reason, code, message) => {
      db.prepare(`
        UPDATE external_operations
        SET status='cancelled',phase='preflight',write_certainty='definitive_no_write',
            cancel_reason=?,updated_at=?
        WHERE operation_id=? AND status=?
      `).run(reason, nowIso(now), row.operation_id, PENDING_STATUS);
      return { error: { code, message } };
    };
    if (Date.parse(row.expires_at) <= Number(now)) {
      return reject("expired", "OPERATION_EXPIRED", "Die Freigabe ist abgelaufen.");
    }
    if (currentMode && row.policy_mode !== String(currentMode)) {
      return reject(
        "mode_changed",
        "OPERATION_MODE_CHANGED",
        "Der Betriebsmodus hat sich seit der Vorschau geändert."
      );
    }
    if (currentAccount && row.account !== String(currentAccount)) {
      return reject(
        "account_changed",
        "OPERATION_ACCOUNT_CHANGED",
        "Das aktive Marketplace-Konto hat sich seit der Vorschau geändert."
      );
    }
    if (
      currentSessionRevision
      && row.session_revision !== "none"
      && row.session_revision !== String(currentSessionRevision)
    ) {
      return reject(
        "session_changed",
        "OPERATION_SESSION_CHANGED",
        "Die Marketplace-Sitzung hat sich seit der Vorschau geändert."
      );
    }
    const timestamp = nowIso(now);
    const result = db.prepare(`
      UPDATE external_operations
      SET status='request_started',phase='preflight',write_certainty='definitive_no_write',
          request_started_at=?,updated_at=?
      WHERE operation_id=? AND status=?
    `).run(timestamp, timestamp, row.operation_id, PENDING_STATUS);
    if (result.changes !== 1) {
      const error = new Error("Die Freigabe wurde gleichzeitig bereits verbraucht.");
      error.code = "OPERATION_ALREADY_CLAIMED";
      throw error;
    }
    return { row: db.prepare("SELECT * FROM external_operations WHERE operation_id=?").get(row.operation_id) };
  });
  const outcome = transaction();
  if (outcome.error) {
    const error = new Error(outcome.error.message);
    error.code = outcome.error.code;
    throw error;
  }
  return operationFromRow(outcome.row);
}

function markOperationPhase(operationId, phase, { now = Date.now() } = {}) {
  if (!["preflight", "upload", "commit", "reconcile", "local_persist"].includes(phase)) {
    throw new Error(`Ungültige Operationsphase: ${phase}`);
  }
  const result = databaseForHostState().prepare(`
    UPDATE external_operations SET phase=?,updated_at=?
    WHERE operation_id=? AND status='request_started'
  `).run(phase, nowIso(now), String(operationId));
  if (result.changes !== 1) throw new Error("Die Operation ist nicht mehr schreibbereit.");
}

function completeOperation(operationId, result = {}, { now = Date.now() } = {}) {
  const timestamp = nowIso(now);
  const remoteId = result?.id ?? result?.remoteId ?? result?.draftId ?? null;
  databaseForHostState().prepare(`
    UPDATE external_operations
    SET status='completed',phase='local_persist',write_certainty='confirmed_write',
        remote_id=?,reconciliation_json=?,completed_at=?,updated_at=?
    WHERE operation_id=? AND status IN ('request_started','reconcile_required','reconciling')
  `).run(
    remoteId === null ? null : String(remoteId),
    JSON.stringify({ result: { id: remoteId, link: result?.link || null } }),
    timestamp,
    timestamp,
    String(operationId)
  );
  return getOperation(operationId);
}

function failOperation(operationId, error, { now = Date.now() } = {}) {
  const db = databaseForHostState();
  const row = db.prepare("SELECT * FROM external_operations WHERE operation_id=?").get(String(operationId));
  if (!row) throw new Error("Operation nicht gefunden.");
  const classified = classifyError(error, {
    phase: row.phase,
    requestStarted: Boolean(row.request_started_at),
  });
  const definitive = classified.writeCertainty === "definitive_no_write" && row.phase === "preflight";
  const status = definitive ? "failed_definitive" : "reconcile_required";
  const phase = definitive ? "preflight" : "reconcile";
  db.prepare(`
    UPDATE external_operations
    SET status=?,phase=?,write_certainty=?,reconciliation_json=?,updated_at=?
    WHERE operation_id=? AND status='request_started'
  `).run(status, phase, classified.writeCertainty, JSON.stringify({ error: classified }), nowIso(now), row.operation_id);
  return { operation: getOperation(operationId), error: classified };
}

function requireReconciliation(operationId, evidence, { remoteId = null, now = Date.now() } = {}) {
  const classified = classifyError(Object.assign(new Error("Lokale Nachführung fehlt."), {
    code: "LOCAL_PERSIST_FAILED",
    confirmedRemoteWrite: true,
  }), { phase: "local_persist", requestStarted: true });
  databaseForHostState().prepare(`
    UPDATE external_operations
    SET status='reconcile_required',phase='reconcile',write_certainty='confirmed_write',
        remote_id=COALESCE(?,remote_id),reconciliation_json=?,updated_at=?
    WHERE operation_id=? AND status='request_started'
  `).run(
    remoteId === null ? null : String(remoteId),
    JSON.stringify({ error: classified, evidence: evidence || null }),
    nowIso(now),
    String(operationId)
  );
  return getOperation(operationId);
}

function recoverInterruptedOperations({ now = Date.now() } = {}) {
  const timestamp = nowIso(now);
  const result = databaseForHostState().prepare(`
    UPDATE external_operations
    SET status='reconcile_required',phase='reconcile',
        write_certainty=CASE WHEN status='reconciling' THEN write_certainty ELSE 'ambiguous' END,
        reconciliation_json=COALESCE(reconciliation_json, '{"reason":"process_interrupted"}'),
        updated_at=?
    WHERE status IN ('request_started','reconciling')
  `).run(timestamp);
  return result.changes;
}

function unresolvedOperations() {
  return databaseForHostState().prepare(`
    SELECT * FROM external_operations
    WHERE status IN ('request_started','reconcile_required','reconciling','manual_resolution')
    ORDER BY created_at
  `).all().map(operationFromRow);
}

async function reconcileOperation(operationId, reconcileRead) {
  if (typeof reconcileRead !== "function") throw new Error("Read-only Reconciliation fehlt.");
  const db = databaseForHostState();
  const claimed = db.prepare(`
    UPDATE external_operations SET status='reconciling',phase='reconcile',updated_at=?
    WHERE operation_id=? AND status='reconcile_required'
  `).run(nowIso(), String(operationId));
  if (claimed.changes !== 1) return getOperation(operationId);
  const operation = getOperation(operationId);
  let outcome;
  try {
    outcome = await reconcileRead(operation);
  } catch (error) {
    const classified = classifyError(error, { phase: "reconcile", requestStarted: true });
    databaseForHostState().prepare(`
      UPDATE external_operations
      SET status='manual_resolution',phase='reconcile',write_certainty='ambiguous',
          reconciliation_json=?,updated_at=?
      WHERE operation_id=? AND status='reconciling'
    `).run(JSON.stringify({ error: classified }), nowIso(), operation.operationId);
    return getOperation(operationId);
  }
  const status = outcome?.status;
  if (status === "completed") return completeOperation(operationId, outcome);
  const finalStatus = status === "confirmed_no_write" ? "confirmed_no_write" : "manual_resolution";
  databaseForHostState().prepare(`
    UPDATE external_operations
    SET status=?,phase='reconcile',write_certainty=?,remote_id=COALESCE(?,remote_id),
        reconciliation_json=?,completed_at=?,updated_at=?
    WHERE operation_id=? AND status='reconciling'
  `).run(
    finalStatus,
    finalStatus === "confirmed_no_write" ? "definitive_no_write" : "ambiguous",
    outcome?.remoteId == null ? null : String(outcome.remoteId),
    JSON.stringify({ evidence: outcome?.evidence || null }),
    finalStatus === "confirmed_no_write" ? nowIso() : null,
    nowIso(),
    operation.operationId
  );
  return getOperation(operationId);
}

module.exports = {
  BLOCKING_AMBIGUOUS_STATUSES,
  cancelOperation,
  cancelPendingForChat,
  claimApproval,
  completeOperation,
  failOperation,
  getOperation,
  getPendingForChat,
  markOperationPhase,
  payloadFingerprint,
  prepareOperation,
  reconcileOperation,
  recoverInterruptedOperations,
  requireReconciliation,
  unresolvedOperations,
};
