"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const test = require("node:test");

const {
  LABEL,
  buildPlist,
  expectedAgentProcess,
  servicePaths,
  waitForProcessExit,
} = require("../scripts/launch-agent");

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
  assert.equal(paths.serviceStartRequestPath, `${root}/workspace/service-start.request`);
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /Nemo &amp; Claw/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
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
  const serviceScript = fs.readFileSync(path.resolve(__dirname, "../scripts/launch-agent.js"), "utf8");
  assert.match(startScript, /exec caffeinate -i -s node workspace\/agent\.js/);
  assert.match(startScript, /NEMOCLAW_SERVICE/);
  assert.match(startScript, /service-start\.request/);
  assert.match(startScript, /Automatischer Start ist deaktiviert/);
  assert.match(startScript, /doctor\.js --telegram/);
  assert.doesNotMatch(startScript, /doctor\.js --telegram --account/);
  assert.match(serviceScript, /"--telegram",\s*"--account"/);
  assert.match(startScript, /Agent läuft bereits \(PID \$existing_pid\)/);
  assert.match(startScript, /workspace\/agent\.pid/);
  assert.match(startScript, /kill -0/);
  assert.match(startScript, /keinen gültigen PID-Lock übernommen/);
  assert.doesNotMatch(startScript, /pgrep -f/);
  assert.doesNotMatch(startScript, /osascript[^\n]*\|\| true/);
});

test("legacy launchd definitions cannot start the bot without a fresh manual request", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manual-launch-"));
  const project = path.join(directory, "project");
  const scripts = path.join(project, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(project, "workspace"), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../scripts/start.sh"), path.join(scripts, "start.sh"));

  try {
    const result = spawnSync("/bin/bash", [path.join(scripts, "start.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_SERVICE: "launchd",
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Automatischer Start ist deaktiviert/);
    assert.equal(fs.existsSync(path.join(project, "workspace", "agent.pid")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("service restart may signal only the expected agent in the same checkout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-process-guard-"));
  const ps = path.join(directory, "ps");
  const matchingLsof = path.join(directory, "lsof-match");
  const otherLsof = path.join(directory, "lsof-other");
  fs.writeFileSync(ps, "#!/bin/sh\nprintf '%s\\n' 'node workspace/agent.js'\n", { mode: 0o755 });
  fs.writeFileSync(matchingLsof, `#!/bin/sh\nprintf '%s\\n' 'p123' 'n${directory}'\n`, { mode: 0o755 });
  fs.writeFileSync(otherLsof, "#!/bin/sh\nprintf '%s\\n' 'p123' 'n/another/checkout'\n", { mode: 0o755 });
  try {
    const paths = { root: directory };
    assert.equal(expectedAgentProcess(123, paths, { psPath: ps, lsofPath: matchingLsof }), true);
    assert.equal(expectedAgentProcess(123, paths, { psPath: ps, lsofPath: otherLsof }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("service restart waits for the process itself instead of only its PID lock", () => {
  let checks = 0;
  let waits = 0;
  const exited = waitForProcessExit(123, {
    isRunning(pid) {
      assert.equal(pid, 123);
      checks++;
      return checks < 3;
    },
    wait(milliseconds) {
      assert.equal(milliseconds, 250);
      waits++;
    },
    timeoutMs: 1000,
  });

  assert.equal(exited, true);
  assert.equal(checks, 3);
  assert.equal(waits, 2);
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
  fs.writeFileSync(
    path.join(project, "workspace", "service-start.request"),
    `${Math.floor(Date.now() / 1000)}\n`,
  );
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
