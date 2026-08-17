"use strict";

const SAFE_MESSAGES = Object.freeze({
  KA_FORM_STATE_DRIFT:
    "Der sichtbare Anzeigenzustand hat sich seit der Vorschau geändert. Es wurde nichts veröffentlicht; die Vorbereitung muss erneuert werden.",
  KA_BROWSER_REJECTED:
    "Kleinanzeigen hat den erneuten Aufruf der sichtbaren Anzeigenmaske abgelehnt. Das ist kein Beleg für eine IP-Sperre. Es wurde nichts veröffentlicht; Bilder und Angaben bleiben erhalten.",
  KA_PUBLISH_PRECHECK_FAILED:
    "Die bereits geprüfte Anzeigenmaske konnte vor dem Veröffentlichen nicht sicher wieder aufgenommen werden. Es wurde nichts veröffentlicht. Bilder und Angaben bleiben erhalten; denselben Vorschlag einmal neu vorbereiten, ohne sie erneut zu senden.",
  KA_PUBLISH_OUTCOME_UNKNOWN:
    "Kleinanzeigen hat nach dem Absenden keinen eindeutigen Abschluss bestätigt. Nicht automatisch wiederholen; zuerst die eigenen Anzeigen prüfen.",
  MEDIA_HASH_MISMATCH:
    "Ein ausgewähltes Foto hat sich seit der Vorschau geändert. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  MEDIA_MISSING:
    "Ein ausgewähltes Foto ist nicht mehr verfügbar. Es wurde nichts geschrieben; bitte das Foto erneut senden.",
  OPERATION_ALREADY_CLAIMED:
    "Diese Freigabe wurde bereits verbraucht. Es wird kein zweiter Schreibversuch gestartet.",
  OPERATION_EXPIRED:
    "Diese Freigabe ist abgelaufen. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  OPERATION_MODE_CHANGED:
    "Der Betriebsmodus hat sich seit der Vorschau geändert. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  OPERATION_FINGERPRINT_BLOCKED:
    "Für denselben Vorgang ist der externe Ausgang noch ungeklärt. Vor einem neuen Versuch muss der Marktplatzstand gelesen werden.",
  OPERATION_BINDING_MISMATCH:
    "Die vorgemerkte Freigabe wurde seit der Vorschau verändert. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  OPERATION_ACCOUNT_CHANGED:
    "Das aktive Marketplace-Konto hat sich seit der Vorschau geändert. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  OPERATION_SESSION_CHANGED:
    "Die Marketplace-Sitzung hat sich seit der Vorschau geändert. Es wurde nichts geschrieben; bitte den Vorschlag neu erstellen.",
  LOCAL_PERSIST_FAILED:
    "Der Marktplatz hat die Aktion bestätigt, aber die lokale Nachführung ist noch offen. Die externe Aktion wird nicht wiederholt.",
});

function redactUnsafeText(value) {
  return String(value || "")
    .replace(/(?:^|\s)(?:\/[^\s:]+){2,}/g, " [lokaler Pfad]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [geschützt]")
    .replace(/\bCookie\b["']?\s*[:=]\s*[^\r\n]+/gi, "Cookie [geschützt]")
    .replace(/\b(refresh_token|access_token)\b["']?\s*[:=]\s*["']?[^,;\s}\]]+/gi, "$1 [geschützt]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[geschützt]")
    .trim();
}

function classifyError(error, {
  phase = "preflight",
  requestStarted = false,
  safeMessage = null,
} = {}) {
  const code = String(error?.code || "INTERNAL_FAILURE").slice(0, 80);
  const normalizedPhase = ["preflight", "upload", "commit", "reconcile", "local_persist"]
    .includes(phase) ? phase : "preflight";
  const definitive = normalizedPhase === "preflight";
  const writeCertainty = definitive || !requestStarted
    ? "definitive_no_write"
    : error?.confirmedRemoteWrite === true
      ? "confirmed_write"
      : "ambiguous";
  const fallback = writeCertainty === "ambiguous"
    ? "Der externe Ausgang ist unklar. Der Vorgang wird nicht automatisch wiederholt; bitte zuerst den aktuellen Marktplatzstand prüfen."
    : writeCertainty === "confirmed_write"
      ? "Die externe Aktion ist bestätigt, aber die lokale Nachführung ist noch offen. Die externe Aktion wird nicht wiederholt."
      : "Der Vorgang wurde sicher vor einer externen Änderung beendet. Bitte den fachlichen Vorschlag erneut prüfen.";
  return {
    code,
    phase: normalizedPhase,
    writeCertainty,
    safeMessage: redactUnsafeText(safeMessage || SAFE_MESSAGES[code] || error?.safeMessage || fallback)
      .slice(0, 700),
  };
}

module.exports = { classifyError, redactUnsafeText };
