#!/usr/bin/env node
"use strict";

const path = require("path");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), override: true });

const { saveToEnv } = require("../tools/auth");
const KleinanzeigenClient = require("../tools/kleinanzeigen");
const {
  evaluatePrivateRead,
  recordDoctorEvidence,
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
      const client = new KleinanzeigenClient(cookies, process.env.KA_BEARER_TOKEN || null);
      const evidence = await evaluatePrivateRead({
        cookieHeader: cookies,
        userAgent,
        privateRead: () => client.getMyAds({ limit: 1 }),
      });
      return recordDoctorEvidence(evidence);
    },
    setLiveMode: async () => {
      saveToEnv({ NEMOCLAW_MODE: "live" });
      process.env.NEMOCLAW_MODE = "live";
    },
    setDryRunMode: async () => {
      saveToEnv({ NEMOCLAW_MODE: "dry-run" });
      process.env.NEMOCLAW_MODE = "dry-run";
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
