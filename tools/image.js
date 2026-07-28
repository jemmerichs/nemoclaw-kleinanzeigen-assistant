"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const IMAGE_ROOT = process.env.NEMOCLAW_IMAGE_DIR
  ? path.resolve(process.env.NEMOCLAW_IMAGE_DIR)
  : path.resolve(__dirname, "../workspace/images");
const RAW_DIR = path.join(IMAGE_ROOT, "raw");

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

module.exports = { saveTemp };
