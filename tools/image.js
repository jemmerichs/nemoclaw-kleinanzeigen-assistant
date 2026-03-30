/**
 * Image processing — nano-banana integration
 *
 * nano-banana is an AI image editor used to prepare listing photos.
 * Philosophy: minimal, honest edits. The goal is "casual but not sloppy" —
 * tidy up the background, improve brightness/contrast, but never hide flaws
 * or make items look artificially perfect.
 *
 * Usage from agent:
 *   processImages({ paths: ["/tmp/..."], instructions: "..." })
 *   → returns { paths: ["/tmp/..."] }  (processed files, same order)
 *
 * TODO: fill in NANO_BANANA_URL + NANO_BANANA_API_KEY in .env once the service
 * is deployed. Until then the function copies files unchanged so the rest of the
 * pipeline still works end-to-end.
 */

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const NANO_BANANA_URL     = process.env.NANO_BANANA_URL || "";
const NANO_BANANA_API_KEY = process.env.NANO_BANANA_API_KEY || "";
const TEMP_DIR            = process.env.NEMOCLAW_TEMP_DIR || "/tmp/nemoclaw";

function ensureTemp() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Save a raw Buffer to a temp file and return its local path.
 * Used by agent.js when photos arrive via Telegram.
 *
 * @param {Buffer} buffer
 * @param {string} [ext=".jpg"]
 * @returns {string} absolute path
 */
function saveTemp(buffer, ext = ".jpg") {
  ensureTemp();
  const filename = `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filepath = path.join(TEMP_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Process listing photos via nano-banana.
 *
 * Applies the standard prompt from workspace/skills/image-prep.md:
 * light background cleanup / blur, no hiding of flaws, no AI-perfect finish.
 *
 * @param {object}   opts
 * @param {string[]} opts.paths        local file paths of raw photos
 * @param {string}   [opts.instructions]  extra per-item instructions (optional)
 * @returns {Promise<{ paths: string[] }>}  processed local file paths, same order
 */
async function processImages({ paths: inputPaths, instructions = "" }) {
  ensureTemp();

  if (!NANO_BANANA_URL || !NANO_BANANA_API_KEY) {
    // Stub: nano-banana not configured — pass images through unchanged.
    console.warn("[image] nano-banana nicht konfiguriert (NANO_BANANA_URL fehlt). Bilder werden unverändert durchgereicht.");
    return { paths: inputPaths };
  }

  const outputPaths = [];

  for (const inputPath of inputPaths) {
    const inputBuffer = fs.readFileSync(inputPath);
    const outputBuffer = await _callNanoBanana(inputBuffer, instructions);
    const outputPath = inputPath.replace(/(\.\w+)$/, "_processed$1");
    fs.writeFileSync(outputPath, outputBuffer);
    outputPaths.push(outputPath);
  }

  return { paths: outputPaths };
}

/**
 * Send one image to nano-banana and return the processed bytes.
 *
 * TODO: replace with the real nano-banana API call.
 * Expected interface (adjust to match actual service):
 *   POST {NANO_BANANA_URL}/process
 *   Authorization: Bearer {NANO_BANANA_API_KEY}
 *   Content-Type: multipart/form-data
 *   Fields: image (file), prompt (string)
 *   Response: raw image bytes (Content-Type: image/jpeg)
 *
 * The prompt is constructed from the standard image-prep guidelines.
 * See workspace/skills/image-prep.md for the full prompting philosophy.
 */
async function _callNanoBanana(imageBuffer, extraInstructions = "") {
  const prompt = buildPrompt(extraInstructions);
  const boundary = "----NBBoundary" + Math.random().toString(36).slice(2);

  const parts = [];
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`
  ));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  ));
  parts.push(imageBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const url = new URL(NANO_BANANA_URL + "/process");
  const proto = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers:  {
        "Authorization": `Bearer ${NANO_BANANA_API_KEY}`,
        "Content-Type":  `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = proto.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`nano-banana Fehler (${res.statusCode}): ${Buffer.concat(chunks).toString()}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Build the standard nano-banana prompt for listing photos.
 * Full guidelines live in workspace/skills/image-prep.md.
 */
function buildPrompt(extraInstructions = "") {
  const base = [
    "Minimal, honest photo cleanup for a second-hand listing.",
    "Allowed: remove or softly blur distracting background, minor brightness/contrast adjustment, straighten horizon.",
    "Not allowed: hide scratches, dents, stains, or any damage visible in the original.",
    "Result must look like a real, casual photo — NOT AI-generated or professionally retouched.",
    "Keep natural lighting and textures. Do not add reflections, glows, or HDR effects.",
    "Output: JPEG, same resolution as input.",
  ].join(" ");

  return extraInstructions ? `${base} Additional: ${extraInstructions}` : base;
}

module.exports = { saveTemp, processImages };
