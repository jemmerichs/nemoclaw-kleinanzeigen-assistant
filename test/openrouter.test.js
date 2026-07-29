"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { OpenRouterClient, estimatePromptTokens, normalizeUsage } = require("../tools/openrouter");

const fakeKey = `sk-or-v1-${"a".repeat(64)}`;

class StubOpenRouter extends OpenRouterClient {
  constructor(options = {}) {
    super({ apiKey: fakeKey, maxRetries: 0, ...options });
    this.requests = [];
    this.response = {
      model: "google/gemini-3.6-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "ping", arguments: "{\"value\":\"ok\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
    };
  }

  async _requestJson(body) {
    this.requests.push(body);
    return this.response;
  }
}

test("OpenRouter request uses configured model, reasoning, and single-tool mode", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-"));
  try {
    const client = new StubOpenRouter({
      usageFile: path.join(directory, "usage.json"),
      reasoningEffort: "medium",
      maxTokens: 1024,
    });
    const result = await client.complete({
      messages: [{ role: "user", content: "ping" }],
      tools: [{
        type: "function",
        function: {
          name: "ping",
          description: "test",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
    });
    assert.equal(client.requests[0].model, "google/gemini-3.6-flash");
    assert.deepEqual(client.requests[0].reasoning, { effort: "medium", exclude: true });
    assert.equal(client.requests[0].parallel_tool_calls, false);
    assert.equal(client.requests[0].max_tokens, 1024);
    assert.equal(result.message.tool_calls[0].function.name, "ping");
    assert.equal(result.usage.costUsd, 0.001);
    assert.equal(client.usageSummary().requests, 1);
    assert.equal(client.usageSummary().modelRequests, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MAX_TOKENS is reported cleanly and still counted in the spend ledger", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-truncated-"));
  try {
    const client = new StubOpenRouter({
      usageFile: path.join(directory, "usage.json"),
      maxTokens: 1024,
    });
    client.response = {
      id: "provider-response-that-must-not-leak",
      model: "google/gemini-3.6-flash",
      choices: [{
        finish_reason: "length",
        native_finish_reason: "MAX_TOKENS",
        message: { role: "assistant", content: null },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 1024, cost: 0.003 },
    };
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      error => {
        assert.equal(error.code, "OPENROUTER_OUTPUT_TRUNCATED");
        assert.match(error.message, /Ausgabelimit/);
        assert.doesNotMatch(error.message, /provider-response-that-must-not-leak/);
        return true;
      }
    );
    const usage = client.usageSummary();
    assert.equal(usage.requests, 1);
    assert.equal(usage.completionTokens, 1024);
    assert.equal(usage.costUsd, 0.003);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an optional per-model budget blocks only the configured expensive tier", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-model-budget-"));
  try {
    const usageFile = path.join(directory, "usage.json");
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(usageFile, JSON.stringify({
      [day]: {
        requests: 2,
        costUsd: 0.2,
        models: {
          "moonshotai/kimi-k3": { requests: 2, costUsd: 0.2 },
        },
      },
    }));
    const client = new StubOpenRouter({
      model: "moonshotai/kimi-k3",
      usageFile,
      dailyBudgetUsd: 1,
      modelDailyBudgetUsd: 0.2,
    });
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      /Modellbudget.*kimi-k3/
    );
    assert.equal(client.requests.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("usage estimation falls back to configured token prices", () => {
  const usage = normalizeUsage(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    { inputPricePerMillion: 1.5, outputPricePerMillion: 7.5 }
  );
  assert.equal(usage.costUsd, 9);
  assert.equal(usage.costEstimated, true);
});

test("prompt estimates ignore base64 size but reserve image tokens", () => {
  const withoutImage = estimatePromptTokens([{ role: "user", content: "hello" }], []);
  const withImage = estimatePromptTokens([{
    role: "user",
    content: [{
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${"A".repeat(100_000)}` },
    }],
  }], []);
  assert.ok(withImage >= withoutImage + 2000);
  assert.ok(withImage < withoutImage + 2200);
});

test("projected maximum cost cannot cross the remaining budget", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-projection-"));
  try {
    const usageFile = path.join(directory, "usage.json");
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(usageFile, JSON.stringify({ [day]: { requests: 1, costUsd: 0.045 } }));
    const client = new StubOpenRouter({
      usageFile,
      dailyBudgetUsd: 0.05,
      inputPricePerMillion: 0,
      outputPricePerMillion: 10,
      maxTokens: 1024,
    });
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      /Tagesbudget erreicht oder würde überschritten/
    );
    assert.equal(client.requests.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent clients sharing a ledger cannot oversubscribe the budget", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-concurrent-"));
  try {
    const usageFile = path.join(directory, "usage.json");
    const options = {
      usageFile,
      dailyBudgetUsd: 0.05,
      inputPricePerMillion: 0,
      outputPricePerMillion: 50,
      maxTokens: 1000,
    };
    const first = new StubOpenRouter(options);
    const second = new StubOpenRouter(options);
    const results = await Promise.allSettled([
      first.complete({ messages: [{ role: "user", content: "first" }] }),
      second.complete({ messages: [{ role: "user", content: "second" }] }),
    ]);

    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.match(
      results.find(result => result.status === "rejected").reason.message,
      /Tagesbudget erreicht oder würde überschritten/
    );
    assert.equal(first.requests.length + second.requests.length, 1);
    assert.equal(first.usageSummary().requests, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous provider timeout reserves conservative cost", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-timeout-"));
  try {
    class TimeoutClient extends StubOpenRouter {
      async _requestJson(body) {
        this.requests.push(body);
        const error = new Error("OpenRouter: Timeout.");
        error.ambiguousCost = true;
        throw error;
      }
    }
    const client = new TimeoutClient({
      usageFile: path.join(directory, "usage.json"),
      inputPricePerMillion: 0,
      outputPricePerMillion: 10,
      maxTokens: 1000,
    });
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      /Timeout/
    );
    const usage = client.usageSummary();
    assert.equal(usage.requests, 1);
    assert.equal(usage.ambiguousRequests, 1);
    assert.equal(usage.costUsd, 0.01);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daily budget blocks additional requests before network use", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-budget-"));
  try {
    const usageFile = path.join(directory, "usage.json");
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(usageFile, JSON.stringify({ [day]: { requests: 1, costUsd: 0.05 } }));
    const client = new StubOpenRouter({ usageFile, dailyBudgetUsd: 0.05 });
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      /Tagesbudget erreicht/
    );
    assert.equal(client.requests.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cumulative app budget persists across ledger days", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrouter-total-budget-"));
  try {
    const usageFile = path.join(directory, "usage.json");
    fs.writeFileSync(usageFile, JSON.stringify({
      "2026-07-25": { requests: 3, costUsd: 1.25 },
      "2026-07-26": { requests: 3, costUsd: 1.75 },
    }));
    const client = new StubOpenRouter({
      usageFile,
      dailyBudgetUsd: 1,
      totalBudgetUsd: 3,
    });
    assert.equal(client.usageSummary().totalCostUsd, 3);
    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "ping" }] }),
      /Gesamtbudget erreicht/
    );
    assert.equal(client.requests.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid keys are rejected without exposing their content", () => {
  assert.throws(() => new OpenRouterClient({ apiKey: "secret" }), /OPENROUTER_API_KEY fehlt oder ist ungültig/);
});
