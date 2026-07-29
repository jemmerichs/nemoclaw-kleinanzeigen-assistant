"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");

const DEFAULT_MODEL = "google/gemini-3.6-flash";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_DAILY_BUDGET_USD = 1;
const DEFAULT_TOTAL_BUDGET_USD = 3;
const DEFAULT_INPUT_PRICE_PER_MILLION = 1.5;
const DEFAULT_OUTPUT_PRICE_PER_MILLION = 7.5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);
const ledgerQueues = new Map();

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function currentDay() {
  return new Date().toISOString().slice(0, 10);
}

function privateAtomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tempFile, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, filePath);
}

function readLedger(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUsage(usage, { inputPricePerMillion, outputPricePerMillion }) {
  const promptTokens = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  const reportedCost = Number(usage?.cost);
  const estimatedCost =
    (promptTokens * inputPricePerMillion + completionTokens * outputPricePerMillion) / 1_000_000;
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number(usage?.total_tokens) || promptTokens + completionTokens || 0,
    costUsd: Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : estimatedCost,
    costEstimated: !(Number.isFinite(reportedCost) && reportedCost >= 0),
  };
}

function estimatePromptTokens(messages, tools) {
  let imageCount = 0;
  const serialized = JSON.stringify({ messages, tools }, (_key, value) => {
    if (typeof value === "string" && /^data:image\/[^;]+;base64,/i.test(value)) {
      imageCount++;
      return "[image]";
    }
    return value;
  });
  return Math.ceil(String(serialized || "").length / 4) + imageCount * 2048;
}

function enqueueLedger(usageFile, task) {
  const key = path.resolve(usageFile);
  const previous = ledgerQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  ledgerQueues.set(key, current);
  current.finally(() => {
    if (ledgerQueues.get(key) === current) ledgerQueues.delete(key);
  }).catch(() => {});
  return current;
}

class OpenRouterClient {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    reasoningEffort = process.env.OPENROUTER_REASONING_EFFORT || "medium",
    maxTokens = process.env.OPENROUTER_MAX_TOKENS,
    timeoutMs = process.env.OPENROUTER_TIMEOUT_MS,
    dailyBudgetUsd = process.env.OPENROUTER_DAILY_BUDGET_USD,
    totalBudgetUsd = process.env.OPENROUTER_TOTAL_BUDGET_USD,
    modelDailyBudgetUsd,
    usageFile = path.resolve(__dirname, "../.openrouter-usage.json"),
    inputPricePerMillion = process.env.OPENROUTER_INPUT_PRICE_PER_MILLION,
    outputPricePerMillion = process.env.OPENROUTER_OUTPUT_PRICE_PER_MILLION,
    maxRetries = 2,
  } = {}) {
    if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(String(apiKey || ""))) {
      throw new Error("OPENROUTER_API_KEY fehlt oder ist ungültig.");
    }
    if (!String(model || "").trim()) throw new Error("OPENROUTER_MODEL fehlt.");
    if (!VALID_REASONING_EFFORTS.has(reasoningEffort)) {
      throw new Error("OPENROUTER_REASONING_EFFORT muss none, minimal, low, medium oder high sein.");
    }

    this.apiKey = String(apiKey);
    this.model = String(model).trim();
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = Math.round(clampNumber(maxTokens, { min: 256, max: 16384, fallback: DEFAULT_MAX_TOKENS }));
    this.timeoutMs = Math.round(clampNumber(timeoutMs, { min: 10000, max: 600000, fallback: DEFAULT_TIMEOUT_MS }));
    this.dailyBudgetUsd = clampNumber(dailyBudgetUsd, { min: 0.05, max: 100, fallback: DEFAULT_DAILY_BUDGET_USD });
    this.totalBudgetUsd = clampNumber(totalBudgetUsd, { min: 0.1, max: 1000, fallback: DEFAULT_TOTAL_BUDGET_USD });
    this.modelDailyBudgetUsd = modelDailyBudgetUsd === undefined || modelDailyBudgetUsd === null || modelDailyBudgetUsd === ""
      ? null
      : clampNumber(modelDailyBudgetUsd, { min: 0.01, max: 100, fallback: 0.25 });
    this.inputPricePerMillion = clampNumber(inputPricePerMillion, {
      min: 0,
      max: 1000,
      fallback: DEFAULT_INPUT_PRICE_PER_MILLION,
    });
    this.outputPricePerMillion = clampNumber(outputPricePerMillion, {
      min: 0,
      max: 1000,
      fallback: DEFAULT_OUTPUT_PRICE_PER_MILLION,
    });
    this.usageFile = usageFile;
    this.maxRetries = Math.round(clampNumber(maxRetries, { min: 0, max: 4, fallback: 2 }));
  }

  usageSummary(day = currentDay()) {
    const ledger = readLedger(this.usageFile);
    const record = ledger[day] || {};
    const modelRecord = record.models?.[this.model] || {};
    const totalCostUsd = Object.values(ledger)
      .reduce((sum, entry) => sum + (Number(entry?.costUsd) || 0), 0);
    return {
      day,
      requests: Number(record.requests) || 0,
      promptTokens: Number(record.promptTokens) || 0,
      completionTokens: Number(record.completionTokens) || 0,
      costUsd: Number(record.costUsd) || 0,
      dailyBudgetUsd: this.dailyBudgetUsd,
      remainingUsd: Math.max(0, this.dailyBudgetUsd - (Number(record.costUsd) || 0)),
      totalCostUsd,
      totalBudgetUsd: this.totalBudgetUsd,
      totalRemainingUsd: Math.max(0, this.totalBudgetUsd - totalCostUsd),
      model: this.model,
      modelRequests: Number(modelRecord.requests) || 0,
      modelCostUsd: Number(modelRecord.costUsd) || 0,
      ambiguousRequests: Number(record.ambiguousRequests) || 0,
      modelAmbiguousRequests: Number(modelRecord.ambiguousRequests) || 0,
      modelDailyBudgetUsd: this.modelDailyBudgetUsd,
      modelRemainingUsd: this.modelDailyBudgetUsd === null
        ? null
        : Math.max(0, this.modelDailyBudgetUsd - (Number(modelRecord.costUsd) || 0)),
    };
  }

  _assertBudget(projectedCostUsd = 0) {
    const summary = this.usageSummary();
    const projected = Math.max(0, Number(projectedCostUsd) || 0);
    if (summary.costUsd + projected > this.dailyBudgetUsd) {
      throw new Error(
        `OpenRouter-Tagesbudget erreicht oder würde überschritten ` +
        `(${(summary.costUsd + projected).toFixed(4)} / ${this.dailyBudgetUsd.toFixed(2)} USD).`
      );
    }
    if (summary.totalCostUsd + projected > this.totalBudgetUsd) {
      throw new Error(
        `OpenRouter-Gesamtbudget erreicht oder würde überschritten ` +
        `(${(summary.totalCostUsd + projected).toFixed(4)} / ${this.totalBudgetUsd.toFixed(2)} USD).`
      );
    }
    if (
      this.modelDailyBudgetUsd !== null &&
      summary.modelCostUsd + projected > this.modelDailyBudgetUsd
    ) {
      throw new Error(
        `OpenRouter-Modellbudget für ${this.model} erreicht ` +
        `oder würde überschritten ` +
        `(${(summary.modelCostUsd + projected).toFixed(4)} / ${this.modelDailyBudgetUsd.toFixed(2)} USD).`
      );
    }
  }

  _recordUsage(usage, { ambiguous = false } = {}) {
    const day = currentDay();
    const ledger = readLedger(this.usageFile);
    const previous = ledger[day] || {};
    const previousModels = previous.models && typeof previous.models === "object" ? previous.models : {};
    const previousModel = previousModels[this.model] || {};
    ledger[day] = {
      requests: (Number(previous.requests) || 0) + 1,
      promptTokens: (Number(previous.promptTokens) || 0) + usage.promptTokens,
      completionTokens: (Number(previous.completionTokens) || 0) + usage.completionTokens,
      costUsd: (Number(previous.costUsd) || 0) + usage.costUsd,
      ambiguousRequests: (Number(previous.ambiguousRequests) || 0) + (ambiguous ? 1 : 0),
      models: {
        ...previousModels,
        [this.model]: {
          requests: (Number(previousModel.requests) || 0) + 1,
          promptTokens: (Number(previousModel.promptTokens) || 0) + usage.promptTokens,
          completionTokens: (Number(previousModel.completionTokens) || 0) + usage.completionTokens,
          costUsd: (Number(previousModel.costUsd) || 0) + usage.costUsd,
          ambiguousRequests: (Number(previousModel.ambiguousRequests) || 0) + (ambiguous ? 1 : 0),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    privateAtomicWriteJson(this.usageFile, ledger);
  }

  withOverrides(overrides = {}) {
    return new OpenRouterClient({
      apiKey: this.apiKey,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
      dailyBudgetUsd: this.dailyBudgetUsd,
      totalBudgetUsd: this.totalBudgetUsd,
      modelDailyBudgetUsd: this.modelDailyBudgetUsd,
      usageFile: this.usageFile,
      inputPricePerMillion: this.inputPricePerMillion,
      outputPricePerMillion: this.outputPricePerMillion,
      maxRetries: this.maxRetries,
      ...overrides,
    });
  }

  complete({ messages, tools = [] }) {
    return enqueueLedger(this.usageFile, () => this._complete({ messages, tools }));
  }

  async _complete({ messages, tools = [] }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error("OpenRouter messages fehlen.");
    if (!Array.isArray(tools)) throw new Error("OpenRouter tools muss eine Liste sein.");
    const projectedPromptTokens = estimatePromptTokens(messages, tools);
    const projectedCostUsd =
      (projectedPromptTokens * this.inputPricePerMillion + this.maxTokens * this.outputPricePerMillion) /
      1_000_000;
    this._assertBudget(projectedCostUsd);

    const body = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: 0.2,
      parallel_tool_calls: false,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      ...(this.reasoningEffort === "none"
        ? { reasoning: { enabled: false, exclude: true } }
        : { reasoning: { effort: this.reasoningEffort, exclude: true } }),
    };

    let parsed;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        parsed = await this._requestJson(body);
        break;
      } catch (error) {
        if (error.ambiguousCost === true) {
          this._recordUsage({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costUsd: projectedCostUsd,
            costEstimated: true,
          }, { ambiguous: true });
          error.ambiguousCost = false;
        }
        const retryable = error.retryable === true;
        if (!retryable || attempt === this.maxRetries) throw error;
        this._assertBudget(projectedCostUsd);
        const delay = Math.min(10000, 750 * 2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const choice = parsed?.choices?.[0];
    const message = choice?.message;
    const usage = normalizeUsage(parsed?.usage, {
      inputPricePerMillion: this.inputPricePerMillion,
      outputPricePerMillion: this.outputPricePerMillion,
    });
    this._recordUsage(usage);

    const finishReason = String(choice?.finish_reason || "").toLowerCase();
    const nativeFinishReason = String(
      choice?.native_finish_reason || parsed?.native_finish_reason || ""
    ).toUpperCase();
    if (
      finishReason === "length"
      || finishReason === "max_tokens"
      || nativeFinishReason === "MAX_TOKENS"
    ) {
      const error = new Error(
        "OpenRouter hat das Ausgabelimit erreicht, bevor eine vollständige Antwort vorlag."
      );
      error.code = "OPENROUTER_OUTPUT_TRUNCATED";
      error.finishReason = choice?.finish_reason || null;
      error.nativeFinishReason = choice?.native_finish_reason || parsed?.native_finish_reason || null;
      error.partialContent = typeof message?.content === "string" ? message.content : "";
      throw error;
    }
    if (choice?.finish_reason === "error" || choice?.error || parsed?.error) {
      const detail = choice?.error?.message || parsed?.error?.message || "unbekannter Modellfehler";
      throw new Error(`OpenRouter-Modellfehler: ${detail}`);
    }
    if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
      const error = new Error(
        `OpenRouter lieferte keine Text- oder Tool-Antwort ` +
        `(finish_reason: ${choice?.finish_reason || "unbekannt"}).`
      );
      error.code = "OPENROUTER_EMPTY_RESPONSE";
      throw error;
    }
    return {
      message: {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : "",
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
      },
      usage,
      model: parsed.model || this.model,
      finishReason: choice.finish_reason,
    };
  }

  _requestJson(body) {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let requestFinished = false;
      const request = https.request({
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "HTTP-Referer": "https://github.com/jemmerichs/nemoclaw-kleinanzeigen",
          "X-Title": "nemoclaw-kleinanzeigen",
        },
      }, response => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          raw += chunk;
          if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("OpenRouter-Antwort ist größer als 10 MB."));
          }
        });
        response.on("end", () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            return reject(new Error(`OpenRouter lieferte ungültiges JSON (${response.statusCode}).`));
          }
          if (response.statusCode < 200 || response.statusCode >= 300 || parsed.error) {
            const detail = parsed.error?.message || raw.slice(0, 300) || "unbekannter Fehler";
            const error = new Error(`OpenRouter fehlgeschlagen (${response.statusCode}): ${detail}`);
            error.retryable = response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500;
            return reject(error);
          }
          resolve(parsed);
        });
      });
      request.setTimeout(this.timeoutMs, () => {
        const error = new Error("OpenRouter: Timeout.");
        error.ambiguousCost = true;
        request.destroy(error);
      });
      request.on("finish", () => {
        requestFinished = true;
      });
      request.on("error", error => {
        if (requestFinished && error.ambiguousCost !== false) error.ambiguousCost = true;
        reject(error);
      });
      request.end(data);
    });
  }
}

module.exports = {
  DEFAULT_MODEL,
  OpenRouterClient,
  VALID_REASONING_EFFORTS,
  estimatePromptTokens,
  normalizeUsage,
};
