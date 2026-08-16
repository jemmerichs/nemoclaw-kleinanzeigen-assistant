#!/usr/bin/env node
/** Standards-based OIDC refresh of an existing still-valid session. */

"use strict";

const { refreshStoredSession } = require("../tools/auth");

refreshStoredSession()
  .then(result => console.log(`Session erneuert bis ${result.expiresAt}.`))
  .catch(e => { console.error("Error:", e.message); process.exit(1); });
