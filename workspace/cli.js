#!/usr/bin/env node
"use strict";

const readline = require("readline");
const {
  createLlmClientFromEnv,
  loadKleinanzeigenSession,
  runAgent,
  validateConfig,
} = require("./agent");

async function main() {
  validateConfig({ requireTelegram: false });
  const llmClient = createLlmClientFromEnv();
  const hasKaSession = loadKleinanzeigenSession();
  const gateway = {
    async send(_chatId, text) {
      process.stdout.write(`\nnemoclaw> ${text}\n\n`);
    },
    async sendPhoto(_chatId, filePath, caption = "") {
      process.stdout.write(`\nnemoclaw> [Foto: ${filePath}]${caption ? ` ${caption}` : ""}\n\n`);
    },
  };

  process.stdout.write(
    `nemoclaw console | ${llmClient.model} | Kleinanzeigen-Session: ${hasKaSession ? "geladen" : "fehlt"}\n` +
    "Schreibe /help für Hilfe oder /quit zum Beenden.\n" +
    "Für Fotos: /compose, FOTO-Zeilen + Caption einfügen, danach /send.\n\n"
  );
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let composing = false;
  let composition = [];
  input.setPrompt("du> ");
  input.prompt();
  for await (const line of input) {
    const raw = line.replace(/\r$/, "");
    const command = raw.trim().toLowerCase();
    if (["/quit", "/exit"].includes(command)) break;

    if (composing) {
      if (command === "/send") {
        const message = composition.join("\n").trim();
        composing = false;
        composition = [];
        if (!message) {
          process.stdout.write("\nNichts zu senden.\n\n");
          input.prompt();
          continue;
        }
        try {
          await runAgent("console", message, { llmClient, gateway });
        } catch (error) {
          process.stdout.write(`\nFehler: ${error.message}\n\n`);
        }
        input.setPrompt("du> ");
        input.prompt();
        continue;
      }
      if (command === "/cancel-compose") {
        composing = false;
        composition = [];
        process.stdout.write("\nFoto-Eingabe verworfen.\n\n");
        input.setPrompt("du> ");
        input.prompt();
        continue;
      }
      composition.push(raw);
      input.prompt();
      continue;
    }

    if (command === "/compose" || /^\s*\[FOTO path:[^\]]+\]/.test(raw)) {
      composing = true;
      composition = command === "/compose" ? [] : [raw];
      input.setPrompt("foto> ");
      process.stdout.write("Foto-Eingabe aktiv. Mit /send absenden, mit /cancel-compose verwerfen.\n");
      input.prompt();
      continue;
    }

    const message = raw.trim();
    if (message) {
      try {
        await runAgent("console", message, { llmClient, gateway });
      } catch (error) {
        process.stdout.write(`\nFehler: ${error.message}\n\n`);
      }
    }
    input.prompt();
  }
  input.close();
}

main().catch(error => {
  console.error(`Start fehlgeschlagen: ${error.message}`);
  process.exitCode = 1;
});
