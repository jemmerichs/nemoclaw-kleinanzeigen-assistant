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
  importSession = null,
  recoverSession = null,
  evaluateAccount,
  ensureDryRun,
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
    let evidence = await evaluateAccount();
    if (
      evidence?.state === "unavailable"
      && evidence.loginRequired === true
      && session.loginPerformed !== true
    ) {
      if (typeof importSession === "function") {
        const imported = await importSession();
        if (imported?.ok) evidence = await evaluateAccount();
      }
      if (evidence?.state === "unavailable" && evidence.loginRequired === true
        && typeof recoverSession === "function") {
        const recovery = await recoverSession();
        if (!recovery?.ok) {
          return finalStatus(FINAL_STATUSES.blocked, recovery?.detail, recovery?.action);
        }
        evidence = await evaluateAccount();
      }
    }
    if (!evidence || evidence.state === "unavailable") {
      if (evidence?.loginRequired === true) {
        return finalStatus(
          FINAL_STATUSES.blocked,
          "Der einmalige Login hat noch keine gültige private Marktplatz-Sitzung erzeugt.",
          "npm run login separat abschließen und danach npm run onboard erneut ausführen."
        );
      }
      return finalStatus(
        FINAL_STATUSES.blocked,
        "Der private Marktplatz-Read ist trotz vorhandener Sitzung nicht erreichbar.",
        "Netzwerkzugriff kurz prüfen und npm run onboard einmal erneut ausführen; kein erneuter Login ohne Login-Hinweis."
      );
    }
    saveEvidence(evidence);
    return evidence.state === "degraded"
      ? finalStatus(
        FINAL_STATUSES.degraded,
        "Telegram, private Reads und die Dry-run-Konfiguration sind bereit; nur die vorsorgliche Sitzungserneuerung ist derzeit nicht belegt. Start mit npm start."
      )
      : finalStatus(
        FINAL_STATUSES.ready,
        "Telegram, private Reads und die Dry-run-Konfiguration sind bereit. Start mit npm start; die Formularprüfung erfolgt mit der ersten echten Anzeige."
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
  now = Date.now(),
} = {}) {
  const revision = sessionRevision(cookieHeader, { userAgent });
  const state = readState();
  let evidence = state.doctorEvidence;
  let refreshed = false;
  const activationEvidenceFresh = current => (
    evidenceIsFresh(current, { sessionRevision: revision, now })
  );
  if (!activationEvidenceFresh(evidence)) {
    refreshed = true;
    evidence = await refreshEvidence();
  }
  if (!activationEvidenceFresh(evidence)) {
    const loginRequired = evidence?.loginRequired === true;
    return {
      ok: false,
      refreshed,
      reason: loginRequired ? "session_login_required" : "stale_evidence",
      message: loginRequired
        ? "Live bleibt gesperrt: Die Marktplatz-Sitzung benötigt einen neuen Login. " +
          "npm run onboard öffnet das dedizierte Chrome-Profil und prüft danach automatisch erneut."
        : "Live bleibt gesperrt: Für die aktuelle Sitzung fehlt frische Doctor-Evidenz. Bitte npm run onboard ausführen.",
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
  return {
    ok: true,
    refreshed,
    reason: "enabled",
    message: "Live ist konfiguriert. Einen laufenden Bot beenden und mit npm start neu starten; die erste Mutation benötigt weiterhin ihre exakte Go-Freigabe.",
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
