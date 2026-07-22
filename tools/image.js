"use strict";

/**
 * Image processing via Gemini (gemini-3.1-flash-image-preview).
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

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL    = process.env.GEMINI_MODEL || "gemini-3.1-flash-image-preview";
const IMAGE_ROOT      = process.env.NEMOCLAW_IMAGE_DIR
  ? path.resolve(process.env.NEMOCLAW_IMAGE_DIR)
  : path.resolve(__dirname, "../workspace/images");
const RAW_DIR         = path.join(IMAGE_ROOT, "raw");
const OPTIMIZED_DIR   = path.join(IMAGE_ROOT, "optimized");

function imageMimeType(filePath) {
  return {
    ".gif": "image/gif",
    ".png": "image/png",
    ".webp": "image/webp",
  }[path.extname(filePath).toLowerCase()] || "image/jpeg";
}

function ensureDirs() {
  if (!fs.existsSync(RAW_DIR))       fs.mkdirSync(RAW_DIR,       { recursive: true });
  if (!fs.existsSync(OPTIMIZED_DIR)) fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });
}

function saveTemp(buffer, ext = ".jpg") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Leeres Bild kann nicht gespeichert werden.");
  ensureDirs();
  const safeExt = /^\.(?:jpe?g|png|gif|webp)$/i.test(ext) ? ext.toLowerCase() : ".jpg";
  const name = `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`;
  const file = path.join(RAW_DIR, name);
  fs.writeFileSync(file, buffer);
  return file;
}

async function processImages({ paths: inputPaths, instructions = "" }) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error("Keine Bildpfade übergeben.");
  if (inputPaths.length > 10) throw new Error("Maximal 10 Bilder pro Verarbeitung.");
  for (const inputPath of inputPaths) {
    if (typeof inputPath !== "string" || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
      throw new Error(`Bild nicht gefunden: ${inputPath}`);
    }
  }
  if (!GEMINI_API_KEY) {
    console.warn("[image] GEMINI_API_KEY nicht gesetzt — Bilder werden unverändert durchgereicht.");
    return { paths: inputPaths };
  }

  ensureDirs();
  const outputPaths = [];

  for (const inputPath of inputPaths) {
    const inputBuffer  = fs.readFileSync(inputPath);
    const outputBuffer = await _callGemini(inputBuffer, imageMimeType(inputPath), instructions);
    const basename     = path.basename(inputPath, path.extname(inputPath));
    const outputPath   = path.join(OPTIMIZED_DIR, `${basename}_opt.jpg`);
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

function _callGemini(imageBuffer, mimeType = "image/jpeg", extra = "") {
  const prompt = _buildPrompt(extra);
  const body   = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBuffer.toString("base64") } },
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
      res.on("data", (c) => {
        raw += c;
        if (raw.length > 30 * 1024 * 1024) req.destroy(new Error("Gemini-Antwort ist größer als 30 MB"));
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Gemini Fehler (${res.statusCode}): ${raw}`));
        }
        try {
          const json  = JSON.parse(raw);
          const parts = json.candidates?.[0]?.content?.parts || [];
          const img   = parts.find((p) => (p.inline_data || p.inlineData)?.mimeType?.startsWith("image/") || p.inline_data?.mime_type?.startsWith("image/"));
          if (!img) return reject(new Error("Gemini hat kein Bild zurückgegeben: " + raw.slice(0, 300)));
          const imgData = img.inline_data || img.inlineData;
          resolve(Buffer.from(imgData.data, "base64"));
        } catch (e) {
          reject(new Error("Gemini Parse-Fehler: " + e.message));
        }
      });
    });

    req.setTimeout(120000, () => req.destroy(new Error("Gemini: Timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { saveTemp, processImages, imageMimeType };
