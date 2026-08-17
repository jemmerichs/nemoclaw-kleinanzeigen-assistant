"use strict";

const {
  evidenceIsFresh,
  readOperationalState,
  recordDoctorEvidence,
  sessionRevision,
} = require("./session-readiness");
const { unresolvedOperations } = require("./marketplace-broker");

const FINAL_STATUSES = Object.freeze({
  ready: "bereit",
  degraded: "bereit mit Refresh-Warnung",
  blocked: "blockiert",
});

function oneAction(value) {
  const action = String(value || "").trim();
  return action ? action.replace(/\s+/g, " ").slice(0, 240) : null;
}

function finalStatus(status, detail, action = null) {
  if (!Object.values(FINAL_STATUSES).includes(status)) throw new Error("Unbekannter Onboarding-Status.");
  return {
    status,
    detail: String(detail || "").trim().replace(/\s+/g, " ").slice(0, 500),
    action: oneAction(action),
  };
}

function formatFinalStatus(result) {
  return [
    `Status: ${result.status}.`,
    result.detail,
    ...(result.action ? [`Nächste Handlung: ${result.action}`] : []),
  ].filter(Boolean).join(" ");
}

async function runOnboarding({
  checkLocal,
  verifyTelegram,
  ensureSession = async () => ({ ok: true }),
  evaluateAccount,
  ensureDryRun,
  startDryRunService,
  saveEvidence = recordDoctorEvidence,
} = {}) {
  try {
    await ensureDryRun();
    const local = await checkLocal();
    if (!local?.ok) return finalStatus(FINAL_STATUSES.blocked, local?.detail, local?.action);
    const telegram = await verifyTelegram();
    if (!telegram?.ok) return finalStatus(FINAL_STATUSES.blocked, telegram?.detail, telegram?.action);
    const session = await ensureSession();
    if (!session?.ok) return finalStatus(FINAL_STATUSES.blocked, session?.detail, session?.action);
    const evidence = await evaluateAccount();
    if (!evidence || evidence.state === "unavailable") {
      return finalStatus(
        FINAL_STATUSES.blocked,
        "Die aktuelle lokale Marktplatz-Sitzung kann den privaten Read nicht ausführen.",
        "Einmal im auf diesem Mac geöffneten Chrome-Profil anmelden und npm run onboard erneut ausführen."
      );
    }
    saveEvidence(evidence);
    const service = await startDryRunService();
    if (!service?.ok) return finalStatus(FINAL_STATUSES.blocked, service?.detail, service?.action);
    return evidence.state === "degraded"
      ? finalStatus(
        FINAL_STATUSES.degraded,
        "Telegram, private Reads und der Dry-run-Dienst funktionieren; nur die vorsorgliche Sitzungserneuerung ist derzeit nicht belegt."
      )
      : finalStatus(
        FINAL_STATUSES.ready,
        "Telegram, private Reads und der Dry-run-Dienst sind bereit. Die Formularprüfung erfolgt mit dem ersten echten Telegram-Vorschlag."
      );
  } catch {
    return finalStatus(
      FINAL_STATUSES.blocked,
      "Die geführte Einrichtung konnte nicht sicher abgeschlossen werden.",
      "npm run onboard einmal erneut ausführen; bleibt der Status blockiert, die Entwicklerdiagnostik verwenden."
    );
  }
}

function liveEvidenceAcceptable(evidence, { now = Date.now(), minimumLifetimeMs = 15 * 60 * 1000 } = {}) {
  if (!evidence || !["ready", "degraded"].includes(evidence.state)) return false;
  if (evidence.refreshOk === true) return true;
  const expiresAt = Date.parse(evidence.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt - Number(now) >= Number(minimumLifetimeMs);
}

async function enableLive({
  cookieHeader,
  userAgent = "",
  readState = readOperationalState,
  refreshEvidence,
  unresolved = unresolvedOperations,
  setLiveMode,
  setDryRunMode,
  restartService,
  now = Date.now(),
} = {}) {
  const revision = sessionRevision(cookieHeader, { userAgent });
  let state = readState();
  let proposal = state.telegramDryRunProposal;
  if (!proposal?.complete || (
    proposal.sessionRevision
    && proposal.sessionRevision !== "none"
    && String(proposal.sessionRevision) !== String(revision)
  )) {
    return {
      ok: false,
      refreshed: false,
      reason: "telegram_dry_run_missing",
      message: "Live bleibt gesperrt: Zuerst mit der aktuellen Sitzung ein vollständiges Telegram-Dry-run-Angebot erzeugen.",
    };
  }
  let evidence = state.doctorEvidence;
  let refreshed = false;
  const activationEvidenceFresh = current => (
    evidenceIsFresh(current, { sessionRevision: revision, now })
    && String(current.formFingerprint || "") === String(proposal?.formFingerprint || "")
    && /^[a-f0-9]{64}$/.test(String(current.formFingerprint || ""))
  );
  if (!activationEvidenceFresh(evidence)) {
    refreshed = true;
    evidence = await refreshEvidence();
    state = readState();
    proposal = state.telegramDryRunProposal;
  }
  if (!activationEvidenceFresh(evidence)) {
    return {
      ok: false,
      refreshed,
      reason: "stale_evidence",
      message: "Live bleibt gesperrt: Für die aktuelle Sitzung fehlt frische Doctor-Evidenz.",
    };
  }
  if (!liveEvidenceAcceptable(evidence, { now })) {
    return {
      ok: false,
      refreshed,
      reason: "session_lifetime",
      message: "Live bleibt gesperrt: Die aktuelle Sitzung hat keine ausreichend belegte Laufzeit oder Erneuerbarkeit.",
    };
  }
  if (unresolved().length) {
    return {
      ok: false,
      refreshed,
      reason: "unresolved_operation",
      message: "Live bleibt gesperrt: Mindestens ein externer Vorgang hat noch keinen eindeutigen Ausgang.",
    };
  }
  try {
    await setLiveMode();
  } catch {
    if (typeof setDryRunMode === "function") {
      try { await setDryRunMode(); } catch {}
    }
    return {
      ok: false,
      refreshed,
      reason: "mode_update_failed",
      message: "Live bleibt gesperrt: Der lokale Betriebsmodus konnte nicht sicher aktualisiert werden.",
    };
  }
  let restarted;
  try {
    restarted = await restartService();
  } catch {
    restarted = { ok: false };
  }
  if (!restarted?.ok) {
    let rolledBack = false;
    if (typeof setDryRunMode === "function") {
      try {
        await setDryRunMode();
        rolledBack = true;
      } catch {}
    }
    return {
      ok: false,
      refreshed,
      reason: "restart_failed",
      message: rolledBack
        ? "Live bleibt gesperrt: Der Dienststart ist fehlgeschlagen; Dry-run wurde wiederhergestellt. Bitte npm run onboard ausführen."
        : "Der Dienststart ist fehlgeschlagen. Vor dem nächsten Start muss der Modus sicher auf Dry-run gesetzt werden.",
    };
  }
  return {
    ok: true,
    refreshed,
    reason: "enabled",
    message: "Live ist aktiviert; die erste Mutation benötigt weiterhin ihre exakte Go-Freigabe.",
  };
}

module.exports = {
  FINAL_STATUSES,
  enableLive,
  finalStatus,
  formatFinalStatus,
  liveEvidenceAcceptable,
  runOnboarding,
};
