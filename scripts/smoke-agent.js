#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const images = [];
  const requiredFacts = [];
  let context = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--image") {
      const value = argv[++index];
      if (!value) throw new Error("--image benötigt einen Pfad.");
      images.push(path.resolve(value));
    } else if (arg === "--context") {
      const value = argv[++index];
      if (!value) throw new Error("--context benötigt Text.");
      context = value;
    } else if (arg === "--require-fact") {
      const value = argv[++index];
      if (!value) throw new Error("--require-fact benötigt Text.");
      requiredFacts.push(value);
    } else {
      throw new Error(`Unbekanntes Argument: ${arg}`);
    }
  }
  if (!images.length) throw new Error("Mindestens ein --image Pfad ist erforderlich.");
  if (images.length > 6) throw new Error("Der Smoke-Test akzeptiert höchstens 6 Bilder.");
  for (const image of images) {
    if (!fs.existsSync(image) || !fs.statSync(image).isFile()) {
      throw new Error(`Bild nicht gefunden: ${image}`);
    }
  }
  return { images, context, requiredFacts };
}

function verifySmokeResult({
  result,
  pending,
  images,
  expectedModel,
  proposal = "",
  requiredFacts = [],
  imageSourceResolver = imagePath => imagePath,
}) {
  if (!result?.toolCalls?.includes("ka_search_ads")) {
    throw new Error(`Agent hat keine Preisrecherche ausgeführt. Tools: ${(result?.toolCalls || []).join(", ") || "keine"}`);
  }
  if (!pending || pending.tool !== "ka_create_ad") {
    throw new Error(`Agent hat keine Anzeige vorgemerkt. Tools: ${(result?.toolCalls || []).join(", ") || "keine"}`);
  }
  if (result.route.tier !== "fast" || result.route.model !== expectedModel) {
    throw new Error(`Smoke-Test wurde unerwartet geroutet: ${result.route.tier}/${result.route.model}`);
  }
  if (!Array.isArray(pending.args.imagePaths) || pending.args.imagePaths.length < 1) {
    throw new Error("Vorgemerkte Anzeige enthält keine ausgewählten Bilder.");
  }
  if (pending.args.imagePaths.length > images.length) {
    throw new Error(`Vorgemerkte Bildauswahl ist größer als der Eingang (${pending.args.imagePaths.length}/${images.length}).`);
  }
  if (new Set(pending.args.imagePaths).size !== pending.args.imagePaths.length) {
    throw new Error("Vorgemerkte Bildauswahl enthält doppelte Pfade.");
  }
  const allowedSources = new Set(images.map(image => path.resolve(image)));
  for (const selectedPath of pending.args.imagePaths) {
    const sourcePath = path.resolve(imageSourceResolver(selectedPath));
    if (!allowedSources.has(sourcePath)) {
      throw new Error(`Vorgemerktes Bild stammt nicht aus dem Testalbum: ${selectedPath}`);
    }
  }
  if (pending.materials.length !== pending.args.imagePaths.length) {
    throw new Error(`Bild-Manifeste fehlen (${pending.materials.length}/${pending.args.imagePaths.length}).`);
  }
  const observedCategoryIds = new Set(
    result.toolTrace
      .filter(entry => entry.tool === "ka_search_ads")
      .flatMap(entry => entry.result?.categoryIds || [])
  );
  if (!observedCategoryIds.has(Number(pending.args.categoryId))) {
    throw new Error(
      `Kategorie ${pending.args.categoryId} kam nicht in den Suchergebnissen vor ` +
      `(beobachtet: ${[...observedCategoryIds].join(", ") || "keine"}).`
    );
  }
  for (const field of ["title", "description", "zipCode", "locationId", "contactName"]) {
    if (!String(pending.args[field] || "").trim()) {
      throw new Error(`Vorgemerkte Anzeige hat kein Feld ${field}.`);
    }
  }
  const proposalText = String(proposal || "");
  for (const expected of [
    pending.args.title,
    String(pending.args.categoryId),
    String(pending.args.description),
    `${pending.args.imagePaths.length}`,
  ]) {
    if (!proposalText.includes(expected)) {
      throw new Error(`Telegram-Vorschlag enthält den erwarteten Anzeigeninhalt nicht: ${expected}`);
    }
  }
  if (!/sha256:[a-f0-9]{12}/i.test(proposalText)) {
    throw new Error("Telegram-Vorschlag enthält kein gebundenes Foto-Hash-Manifest.");
  }
  if (!/Dry-run|eigenständige Nachricht nur mit „Go“/i.test(proposalText)) {
    throw new Error("Telegram-Vorschlag enthält keinen eindeutigen Freigabehinweis.");
  }
  for (const fact of requiredFacts) {
    const normalized = String(fact).trim().toLocaleLowerCase("de-DE");
    if (!normalized) continue;
    if (!String(pending.args.description).toLocaleLowerCase("de-DE").includes(normalized)) {
      throw new Error(`Pflichtfakt fehlt in der Anzeigenbeschreibung: ${fact}`);
    }
    if (!proposalText.toLocaleLowerCase("de-DE").includes(normalized)) {
      throw new Error(`Pflichtfakt fehlt im Telegram-Vorschlag: ${fact}`);
    }
  }
}

async function main() {
  require("dotenv").config({ path: path.join(root, ".env") });
  const { images, context, requiredFacts } = parseArgs(process.argv.slice(2));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-smoke-"));
  process.env.NEMOCLAW_MODE = "dry-run";
  process.env.NEMOCLAW_COMPLEXITY_ROUTING = "manual";
  process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
  process.env.NEMOCLAW_PENDING_FILE = path.join(temporary, "pending.json");
  process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");

  const {
    clearPending,
    createLlmClientFromEnv,
    loadKleinanzeigenSession,
    runAgent,
    validateConfig,
  } = require("../workspace/agent");
  const { readProvenance } = require("../tools/image");

  const sent = [];
  const gateway = {
    async send(_chatId, text) { sent.push(text); },
    async sendPhoto() {},
  };

  try {
    validateConfig({ requireTelegram: false });
    loadKleinanzeigenSession();
    const llmClient = createLlmClientFromEnv();
    const prompt = [
      ...images.map(image => `[FOTO path:${image}]`),
      context || "Nur ein Dry-run-Test: Erkenne den Artikel, recherchiere vergleichbare aktuelle Angebote und bereite eine vollständige ehrliche Verkaufsanzeige vor. Nichts ausführen.",
      "Rufe für den fertigen Vorschlag ka_create_ad auf; die Bridge darf ihn ausschließlich als blockierte Dry-run-Aktion vormerken.",
    ].join("\n");
    const result = await runAgent("agent-smoke", prompt, { llmClient, gateway });
    const pending = result?.pending;
    verifySmokeResult({
      result,
      pending,
      images,
      expectedModel: llmClient.model,
      proposal: sent.at(-1),
      requiredFacts,
      imageSourceResolver: imagePath => readProvenance(imagePath).sourcePath,
    });
    console.log([
      "Agent-Smoke OK",
      `model=${result.route.model}`,
      `route=${result.route.tier}:${result.route.reason}`,
      `tools=${result.toolCalls.join(" → ")}`,
      `action=${pending.id}`,
      `title=${pending.args.title}`,
      `categoryId=${pending.args.categoryId}`,
      `price=${pending.args.price} EUR`,
      `images=${pending.args.imagePaths.length}/${images.length} selected`,
    ].join(" | "));
  } finally {
    clearPending("agent-smoke");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Agent-Smoke fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, verifySmokeResult };
