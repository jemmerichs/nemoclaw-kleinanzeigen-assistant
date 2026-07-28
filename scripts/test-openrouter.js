#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { OpenRouterClient } = require("../tools/openrouter");

async function main() {
  const client = new OpenRouterClient({
    reasoningEffort: "minimal",
    maxTokens: 512,
    maxRetries: 1,
  });
  const response = await client.complete({
    messages: [
      {
        role: "system",
        content: "Du bist ein kurzer Verbindungstest. Rufe das bereitgestellte ping-Tool genau einmal mit value=ok auf.",
      },
      { role: "user", content: "Teste die Tool-Verbindung." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "ping",
        description: "Verbindungstest",
        parameters: {
          type: "object",
          properties: { value: { type: "string", enum: ["ok"] } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    }],
  });
  const call = response.message.tool_calls?.[0];
  if (call?.function?.name !== "ping") {
    throw new Error(`Modell hat ping nicht aufgerufen: ${JSON.stringify(response.message).slice(0, 300)}`);
  }
  const args = JSON.parse(call.function.arguments || "{}");
  if (args.value !== "ok") throw new Error("ping-Argument war nicht ok.");
  console.log(
    `OpenRouter OK | model=${response.model} | tokens=${response.usage.totalTokens} | cost=$${response.usage.costUsd.toFixed(6)}`
  );
}

main().catch(error => {
  console.error(`OpenRouter-Test fehlgeschlagen: ${error.message}`);
  process.exitCode = 1;
});
