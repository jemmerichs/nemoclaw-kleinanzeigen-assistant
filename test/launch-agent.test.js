"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const test = require("node:test");

const { LABEL, buildPlist, servicePaths } = require("../scripts/launch-agent");

test("launchd plist is portable, private, and contains no secrets", () => {
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
  assert.match(startScript, /workspace\/agent\.pid/);
  assert.match(startScript, /kill -0/);
  assert.match(startScript, /keinen gültigen PID-Lock übernommen/);
  assert.doesNotMatch(startScript, /pgrep -f/);
  assert.doesNotMatch(startScript, /osascript[^\n]*\|\| true/);
});

test("launchd startup fails when Terminal cannot be opened", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launcher-"));
  const project = path.join(directory, "project");
  const scripts = path.join(project, "scripts");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(project, "workspace"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../scripts/start.sh"), path.join(scripts, "start.sh"));
  fs.writeFileSync(path.join(project, ".env"), "NEMOCLAW_MODE=dry-run\n");
  fs.writeFileSync(path.join(bin, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "osascript"), "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });

  try {
    const result = spawnSync("/bin/bash", [path.join(scripts, "start.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_SERVICE: "launchd",
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Terminal konnte nicht geöffnet werden/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
