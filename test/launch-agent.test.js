"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { LABEL, buildPlist, servicePaths } = require("../scripts/launch-agent");

test("launchd plist is portable, restart-safe, and contains no secrets", () => {
  const root = "/Users/test/Nemo & Claw";
  const paths = servicePaths({
    homeDir: "/Users/test",
    nodePath: "/opt/homebrew/bin/node",
    root,
  });
  const plist = buildPlist({
    homeDir: "/Users/test",
    nodePath: "/opt/homebrew/bin/node",
    root,
  });

  assert.equal(paths.plistPath, `/Users/test/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(paths.agentPidPath, `${root}/workspace/agent.pid`);
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /Nemo &amp; Claw/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.doesNotMatch(plist, /caffeinate/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/local\/bin/);
  assert.match(plist, new RegExp(
    path.join("scripts", "start\\.sh").replaceAll("/", "\\/")
  ));
  assert.doesNotMatch(
    plist,
    /OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN|KA_COOKIES|access_token|refresh_token/
  );
});

test("foreground launcher ties caffeinate to the visible agent process", () => {
  const startScript = fs.readFileSync(path.resolve(__dirname, "../scripts/start.sh"), "utf8");
  assert.match(startScript, /exec caffeinate -i -s node workspace\/agent\.js/);
  assert.match(startScript, /NEMOCLAW_SERVICE/);
});
