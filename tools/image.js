"use strict";

/**
 * Image processing via Gemini (gemini-2.0-flash-exp).
 *
 * Sends listing photos to Gemini with a minimal-edit prompt and writes the
 * result back to disk. Pass-through if GEMINI_API_KEY is not set.
 *
 * Exports:
 *   saveTemp(buffer, ext?)  → local file path  (used by agent when photo arrives)
 *   processImages({ paths, instructions? }) → { paths }
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL   = "gemini-2.0-flash-exp";
const TEMP_DIR       = process.env.NEMOCLAW_TEMP_DIR || "/tmp/nemoclaw";

function ensureTemp() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function saveTemp(buffer, ext = ".jpg") {
  ensureTemp();
  const name = `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
  const file = path.join(TEMP_DIR, name);
  fs.writeFileSync(file, buffer);
  return file;
}

async function processImages({ paths: inputPaths, instructions = "" }) {
  if (!GEMINI_API_KEY) {
    console.warn("[image] GEMINI_API_KEY nicht gesetzt — Bilder werden unverändert durchgereicht.");
    return { paths: inputPaths };
  }

  ensureTemp();
  const outputPaths = [];

  for (const inputPath of inputPaths) {
    const inputBuffer  = fs.readFileSync(inputPath);
    const outputBuffer = await _callGemini(inputBuffer, instructions);
    const outputPath   = inputPath.replace(/(\.\w+)$/, "_processed$1");
    fs.writeFileSync(outputPath, outputBuffer);
    outputPaths.push(outputPath);
  }

  return { paths: outputPaths };
}

function _buildPrompt(extra = "") {
  const base =
    "Edit this second-hand listing photo with minimal, honest changes only. " +
    "You may: softly blur or remove a distracting background, make small brightness/contrast adjustments, straighten the horizon. " +
    "Do not: hide scratches, dents, stains, or wear; add glows, reflections, or HDR; smooth textures; change colours significantly. " +
    "The result must look like a real casual photo, not AI-generated or professionally retouched. " +
    "Output the edited image as JPEG at the same resolution.";
  return extra ? `${base} Additional context: ${extra}` : base;
}

function _callGemini(imageBuffer, extra = "") {
  const prompt = _buildPrompt(extra);
  const body   = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: imageBuffer.toString("base64") } },
      ],
    }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  });

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "generativelanguage.googleapis.com",
      path:     `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };

    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Gemini Fehler (${res.statusCode}): ${raw}`));
        }
        try {
          const json  = JSON.parse(raw);
          const parts = json.candidates?.[0]?.content?.parts || [];
          const img   = parts.find((p) => p.inline_data?.mime_type?.startsWith("image/"));
          if (!img) return reject(new Error("Gemini hat kein Bild zurückgegeben: " + raw.slice(0, 300)));
          resolve(Buffer.from(img.inline_data.data, "base64"));
        } catch (e) {
          reject(new Error("Gemini Parse-Fehler: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { saveTemp, processImages };
