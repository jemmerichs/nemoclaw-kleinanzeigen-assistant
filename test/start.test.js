"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const sourceScript = path.resolve(__dirname, "../scripts/start.sh");

test("package exposes only the manual runtime start", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
  assert.equal(packageJson.scripts.start, "bash scripts/start.sh");
  for (const command of [
    "launch",
    "service:print",
    "service:install",
    "service:status",
    "service:restart",
    "service:uninstall",
  ]) {
    assert.equal(packageJson.scripts[command], undefined);
  }
  assert.equal(fs.existsSync(path.resolve(__dirname, "../scripts/launch-agent.js")), false);
});

test("manual launcher ties caffeinate to the visible agent process", () => {
  const startScript = fs.readFileSync(sourceScript, "utf8");
  assert.match(startScript, /exec caffeinate -i -s node workspace\/agent\.js/);
  assert.match(startScript, /doctor\.js --telegram/);
  assert.doesNotMatch(startScript, /doctor\.js --telegram --account/);
  assert.match(startScript, /Agent läuft bereits \(PID \$existing_pid\)/);
  assert.match(startScript, /workspace\/agent\.pid/);
  assert.match(startScript, /kill -0/);
  assert.doesNotMatch(startScript, /service-start\.request/);
  assert.doesNotMatch(startScript, /pgrep -f/);
  assert.doesNotMatch(startScript, /osascript[^\n]*\|\| true/);
});

test("legacy launchd registrations cannot start the bot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retired-launchd-"));
  const project = path.join(directory, "project");
  const scripts = path.join(project, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(project, "workspace"), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(scripts, "start.sh"));

  try {
    const result = spawnSync("/bin/bash", [path.join(scripts, "start.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_SERVICE: "launchd",
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /alte launchd-Integration wurde entfernt/);
    assert.equal(fs.existsSync(path.join(project, "workspace", "agent.pid")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual startup fails when Terminal cannot be opened", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launcher-"));
  const project = path.join(directory, "project");
  const scripts = path.join(project, "scripts");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(project, "workspace"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(sourceScript, path.join(scripts, "start.sh"));
  fs.writeFileSync(path.join(project, ".env"), "NEMOCLAW_MODE=dry-run\n");
  fs.writeFileSync(path.join(bin, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "osascript"), "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });

  try {
    const result = spawnSync("/bin/bash", [path.join(scripts, "start.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Terminal konnte nicht geöffnet werden/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
