#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), override: true });

const { adoptNewerObservedSession, saveToEnv } = require("../tools/auth");
const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { inspectCategoryForm } = require("../tools/kleinanzeigen-form");
const { normalizeCategoryPath } = require("../tools/kleinanzeigen-listing-preparation");
const {
  evaluatePrivateRead,
  readOperationalState,
  recordDoctorEvidence,
  sessionRevision,
} = require("../tools/session-readiness");
const { enableLive } = require("../tools/target-mac-setup");

async function main() {
  const result = await enableLive({
    cookieHeader: process.env.KA_COOKIES || "",
    userAgent: process.env.KA_USER_AGENT || "",
    refreshEvidence: async () => {
      const fixture = process.env.NEMOCLAW_ENABLE_LIVE_REFRESH_FIXTURE;
      if (fixture) return recordDoctorEvidence(JSON.parse(fixture));
      const cookies = process.env.KA_COOKIES || "";
      const userAgent = process.env.KA_USER_AGENT || "";
      const proposal = readOperationalState().telegramDryRunProposal;
      const categoryPath = normalizeCategoryPath(proposal?.category);
      if (!categoryPath.length) {
        const error = new Error("Der aktuelle Dry-run-Nachweis enthält keine wiederholbare Formularvorbereitung.");
        error.code = "DRY_RUN_FORM_EVIDENCE_MISSING";
        throw error;
      }
      const client = new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
      const evidence = await evaluatePrivateRead({
        cookieHeader: cookies,
        userAgent,
        privateRead: () => client.getMyAds({ limit: 1 }),
      });
      const form = await inspectCategoryForm({
        categoryPath,
        onSessionObserved: adoptNewerObservedSession,
      });
      if (form?.status !== "ready" || !form.formState?.formFingerprint) {
        const error = new Error("Die sichtbare Formularvorbereitung konnte nicht erneut belegt werden.");
        error.code = "FORM_EVIDENCE_UNAVAILABLE";
        throw error;
      }
      const revision = sessionRevision(cookies, { userAgent });
      if (String(form.formState.sessionRevision) !== String(revision)) {
        const error = new Error("Browserprofil und Runtime verwenden nicht dieselbe Session-Revision.");
        error.code = "SESSION_REVISION_DRIFT";
        throw error;
      }
      return recordDoctorEvidence({
        ...evidence,
        formFingerprint: form.formState.formFingerprint,
      });
    },
    setLiveMode: async () => {
      saveToEnv({ NEMOCLAW_MODE: "live" });
      process.env.NEMOCLAW_MODE = "live";
    },
    setDryRunMode: async () => {
      saveToEnv({ NEMOCLAW_MODE: "dry-run" });
      process.env.NEMOCLAW_MODE = "dry-run";
    },
    restartService: async () => {
      if (process.env.NEMOCLAW_ENABLE_LIVE_FIXTURE === "success") return { ok: true };
      const command = spawnSync(process.execPath, [path.join(root, "scripts", "launch-agent.js"), "restart"], {
        cwd: root,
        encoding: "utf8",
      });
      return { ok: command.status === 0 };
    },
  }).catch(() => ({
    ok: false,
    message: "Live bleibt gesperrt: Die aktuelle Evidenz konnte nicht sicher erneuert werden.",
  }));
  process.stdout.write(`${result.message}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main };
