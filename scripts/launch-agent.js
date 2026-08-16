#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LABEL = "de.nemoclaw.kleinanzeigen";
const projectDir = path.resolve(__dirname, "..");

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function servicePaths({
  homeDir = os.homedir(),
  nodePath = process.execPath,
  root = projectDir,
} = {}) {
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logDir = path.join(root, "workspace", "logs");
  return {
    root,
    nodePath,
    launchAgentsDir,
    plistPath: path.join(launchAgentsDir, `${LABEL}.plist`),
    agentPidPath: path.join(root, "workspace", "agent.pid"),
    logDir,
    stdoutPath: path.join(logDir, "launchd.stdout.log"),
    stderrPath: path.join(logDir, "launchd.stderr.log"),
  };
}

function buildPlist(options = {}) {
  const paths = servicePaths(options);
  const nodeDir = path.dirname(paths.nodePath);
  const launchPath = [
    nodeDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry, index, all) => all.indexOf(entry) === index).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xml(path.join(paths.root, "scripts", "start.sh"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(launchPath)}</string>
    <key>NEMOCLAW_SERVICE</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args, { tolerateFailure = false, inherit = true } = {}) {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error && !tolerateFailure) throw result.error;
  if (result.status !== 0 && !tolerateFailure) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`launchctl ${args[0]} fehlgeschlagen${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function assertMac() {
  if (process.platform !== "darwin") {
    throw new Error("Der Hintergrunddienst kann nur auf macOS installiert werden.");
  }
}

function assertReady(paths) {
  if (!fs.existsSync(path.join(paths.root, ".env"))) {
    throw new Error(".env fehlt. Führe zuerst npm run setup aus.");
  }
  const doctor = spawnSync(paths.nodePath, [
    path.join(paths.root, "scripts", "doctor.js"),
    "--telegram",
  ], { cwd: paths.root, encoding: "utf8", stdio: "inherit" });
  if (doctor.error) throw doctor.error;
  if (doctor.status !== 0) {
    throw new Error("Der strikte Telegram-/Runtime-Check ist fehlgeschlagen.");
  }
}

function writePrivate(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function install() {
  assertMac();
  const paths = servicePaths();
  assertReady(paths);
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  writePrivate(paths.plistPath, buildPlist());
  const domain = `gui/${process.getuid()}`;
  launchctl(["bootout", domain, paths.plistPath], { tolerateFailure: true, inherit: false });
  launchctl(["bootstrap", domain, paths.plistPath]);
  launchctl(["kickstart", "-k", `${domain}/${LABEL}`]);
  console.log(`✓ nemoclaw läuft als macOS-Benutzerdienst (${LABEL}).`);
  console.log(`Status: npm run service:status`);
  console.log(`Logs: ${paths.stdoutPath} / ${paths.stderrPath}`);
}

function uninstall() {
  assertMac();
  const paths = servicePaths();
  const domain = `gui/${process.getuid()}`;
  launchctl(["bootout", domain, paths.plistPath], { tolerateFailure: true, inherit: false });
  if (fs.existsSync(paths.plistPath)) fs.unlinkSync(paths.plistPath);
  console.log(`✓ ${LABEL} wurde entladen und die LaunchAgent-Datei entfernt.`);
  console.log(`Lokale Daten und Logs unter ${paths.root}/workspace bleiben erhalten.`);
}

function status() {
  assertMac();
  const domain = `gui/${process.getuid()}/${LABEL}`;
  const result = launchctl(["print", domain], { tolerateFailure: true, inherit: false });
  if (result.status !== 0) {
    console.log(`○ ${LABEL} ist nicht geladen.`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout);
}

function restart() {
  assertMac();
  const paths = servicePaths();
  try {
    const pid = Number(fs.readFileSync(paths.agentPidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      process.kill(pid, 0);
      console.log(`○ Der Agent läuft bereits sichtbar (PID ${pid}). Schließe zuerst sein Terminal-Fenster und starte ihn dann neu.`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    if (error?.code === "EPERM") {
      console.log("○ Der Agent läuft bereits, kann von diesem Benutzer aber nicht geprüft werden.");
      process.exitCode = 1;
      return;
    }
  }
  const domain = `gui/${process.getuid()}`;
  const loaded = launchctl(["print", `${domain}/${LABEL}`], { tolerateFailure: true, inherit: false });
  if (loaded.status !== 0) {
    console.log(`○ ${LABEL} ist nicht geladen — installiere zuerst mit 'npm run service:install'.`);
    process.exitCode = 1;
    return;
  }
  launchctl(["kickstart", "-k", `${domain}/${LABEL}`]);
  console.log(`✓ ${LABEL} wurde neu gestartet.`);
  console.log(`Status: npm run service:status`);
  console.log(`Logs: ${paths.stdoutPath} / ${paths.stderrPath}`);
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "print") {
    process.stdout.write(buildPlist());
    return;
  }
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command === "status") return status();
  if (command === "restart") return restart();
  throw new Error("Verwendung: launch-agent.js print|install|status|uninstall|restart");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Service-Fehler: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { LABEL, buildPlist, main, servicePaths };
