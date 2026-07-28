"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const IMAGE_ROOT = process.env.NEMOCLAW_IMAGE_DIR
  ? path.resolve(process.env.NEMOCLAW_IMAGE_DIR)
  : path.resolve(__dirname, "../workspace/images");
const RAW_DIR = path.join(IMAGE_ROOT, "raw");
const EDITED_DIR = path.join(IMAGE_ROOT, "edited");

function isInsideImageRoot(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  return resolved !== IMAGE_ROOT && resolved.startsWith(IMAGE_ROOT + path.sep);
}

function assertLocalImage(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!isInsideImageRoot(resolved)) {
    throw new Error("Bildpfad liegt außerhalb des erlaubten Bildverzeichnisses.");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Bild nicht gefunden: ${resolved}`);
  }
  return resolved;
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function boundedNumber(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return parsed;
}

function normalizeOperations(raw = {}) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("Bildoperationen müssen ein Objekt sein.");
  }
  const allowed = new Set([
    "rotate",
    "crop",
    "brightness",
    "contrast",
    "saturation",
    "sharpen",
    "maxLongEdge",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unbekannte Bildoperation: ${key}`);
  }

  const rotate = raw.rotate === undefined ? 0 : Number(raw.rotate);
  if (![0, 90, 180, 270].includes(rotate)) {
    throw new Error("rotate muss 0, 90, 180 oder 270 sein.");
  }
  let crop = null;
  if (raw.crop !== undefined && raw.crop !== null) {
    if (Array.isArray(raw.crop) || typeof raw.crop !== "object") {
      throw new Error("crop muss ein Objekt sein.");
    }
    for (const key of Object.keys(raw.crop)) {
      if (!["x", "y", "width", "height"].includes(key)) {
        throw new Error(`Unbekanntes crop-Feld: ${key}`);
      }
    }
    crop = {
      x: boundedNumber(raw.crop.x, "crop.x", 0, 0.95),
      y: boundedNumber(raw.crop.y, "crop.y", 0, 0.95),
      width: boundedNumber(raw.crop.width, "crop.width", 0.05, 1),
      height: boundedNumber(raw.crop.height, "crop.height", 0.05, 1),
    };
    if (crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) {
      throw new Error("Der normalisierte crop-Bereich liegt außerhalb des Bildes.");
    }
  }
  return {
    rotate,
    crop,
    brightness: boundedNumber(raw.brightness, "brightness", 0.8, 1.2, 1),
    contrast: boundedNumber(raw.contrast, "contrast", 0.8, 1.2, 1),
    saturation: boundedNumber(raw.saturation, "saturation", 0.8, 1.2, 1),
    sharpen: raw.sharpen === undefined ? false : raw.sharpen,
    maxLongEdge: Math.round(boundedNumber(raw.maxLongEdge, "maxLongEdge", 1200, 3000, 2000)),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function orientedDimensions(metadata, extraRotation) {
  let width = Number(metadata.width);
  let height = Number(metadata.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Bildabmessungen konnten nicht gelesen werden.");
  }
  if ([5, 6, 7, 8].includes(metadata.orientation)) [width, height] = [height, width];
  if ([90, 270].includes(extraRotation)) [width, height] = [height, width];
  return { width, height };
}

function provenanceSidecar(filePath) {
  return `${filePath}.provenance.json`;
}

function readProvenance(filePath) {
  const resolved = assertLocalImage(filePath);
  const sidecar = provenanceSidecar(resolved);
  if (!fs.existsSync(sidecar)) {
    return {
      kind: "original",
      sourcePath: resolved,
      outputPath: resolved,
      outputSha256: fileSha256(resolved),
      operations: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (parsed.outputPath !== resolved || parsed.outputSha256 !== fileSha256(resolved)) {
      throw new Error("Provenienz stimmt nicht mit der Bilddatei überein.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Bildprovenienz ist ungültig: ${error.message}`);
  }
}

async function editImage(inputPath, rawOperations = {}) {
  const sourcePath = assertLocalImage(inputPath);
  const operations = normalizeOperations(rawOperations);
  if (typeof operations.sharpen !== "boolean") throw new Error("sharpen muss true oder false sein.");
  const inputSha256 = fileSha256(sourcePath);
  const editId = crypto
    .createHash("sha256")
    .update(`${inputSha256}\n${stableJson(operations)}`)
    .digest("hex")
    .slice(0, 16);
  fs.mkdirSync(EDITED_DIR, { recursive: true });
  const outputPath = path.join(EDITED_DIR, `edited_${editId}.jpg`);
  const sidecar = provenanceSidecar(outputPath);

  if (fs.existsSync(outputPath) && fs.existsSync(sidecar)) {
    return readProvenance(outputPath);
  }

  const metadata = await sharp(sourcePath, { failOn: "error" }).metadata();
  const dimensions = orientedDimensions(metadata, operations.rotate);
  const autoOriented = sharp(sourcePath, { failOn: "error" }).rotate();
  let pipeline = operations.rotate
    ? sharp(await autoOriented.toBuffer(), { failOn: "error" }).rotate(operations.rotate)
    : autoOriented;

  if (operations.crop) {
    const left = Math.floor(dimensions.width * operations.crop.x);
    const top = Math.floor(dimensions.height * operations.crop.y);
    const width = Math.max(1, Math.min(
      dimensions.width - left,
      Math.round(dimensions.width * operations.crop.width)
    ));
    const height = Math.max(1, Math.min(
      dimensions.height - top,
      Math.round(dimensions.height * operations.crop.height)
    ));
    pipeline = pipeline.extract({ left, top, width, height });
  }
  if (operations.contrast !== 1) {
    pipeline = pipeline.linear(operations.contrast, 128 * (1 - operations.contrast));
  }
  if (operations.brightness !== 1 || operations.saturation !== 1) {
    pipeline = pipeline.modulate({
      brightness: operations.brightness,
      saturation: operations.saturation,
    });
  }
  if (operations.sharpen) pipeline = pipeline.sharpen({ sigma: 1 });
  pipeline = pipeline
    .resize({
      width: operations.maxLongEdge,
      height: operations.maxLongEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" });

  await pipeline.toFile(outputPath);
  fs.chmodSync(outputPath, 0o600);
  const outputMetadata = await sharp(outputPath).metadata();
  const provenance = {
    kind: "edited",
    sourcePath,
    outputPath,
    inputSha256,
    outputSha256: fileSha256(outputPath),
    operations,
    sourceDimensions: { width: metadata.width, height: metadata.height },
    outputDimensions: { width: outputMetadata.width, height: outputMetadata.height },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(sidecar, JSON.stringify(provenance, null, 2), { mode: 0o600 });
  return provenance;
}

function saveTemp(buffer, ext = ".jpg") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Leeres Bild kann nicht gespeichert werden.");
  }
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const safeExt = /^\.(?:jpe?g|png|gif|webp|bmp)$/i.test(ext) ? ext.toLowerCase() : ".jpg";
  const name = `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`;
  const file = path.join(RAW_DIR, name);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

module.exports = {
  assertLocalImage,
  editImage,
  fileSha256,
  normalizeOperations,
  readProvenance,
  saveTemp,
};
