"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { databaseForHostState } = require("./adstore");

const IMAGE_ROOT = process.env.NEMOCLAW_IMAGE_DIR
  ? path.resolve(process.env.NEMOCLAW_IMAGE_DIR)
  : path.resolve(__dirname, "../workspace/images");
const RAW_DIR = path.join(IMAGE_ROOT, "raw");
const MEDIA_ID_PATTERN = /^[a-f0-9]{24}$/;
const MEDIA_TOKEN_PATTERN = /\[MEDIA id:([a-f0-9]{24})\]/g;

function safeExtension(value) {
  const extension = String(value || "").toLowerCase();
  return /^\.(?:jpe?g|png|gif|webp|bmp)$/.test(extension) ? extension : ".jpg";
}

function mimeTypeForExtension(extension) {
  return {
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
  }[safeExtension(extension)] || "image/jpeg";
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertManagedPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (resolved === IMAGE_ROOT || !resolved.startsWith(`${IMAGE_ROOT}${path.sep}`)) {
    const error = new Error("Das Medium liegt außerhalb des verwalteten Speichers.");
    error.code = "MEDIA_PATH_UNMANAGED";
    throw error;
  }
  return resolved;
}

function publicRecord(row) {
  if (!row) return null;
  return {
    mediaId: row.media_id,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    mimeType: row.mime_type,
    source: row.source,
    availability: row.availability,
    createdAt: row.created_at,
    checkedAt: row.checked_at,
  };
}

function insertManagedRecord({ mediaId, managedPath, buffer, mimeType, source }) {
  const db = databaseForHostState();
  db.prepare(`
    INSERT INTO media_assets (
      media_id,managed_path,sha256,byte_size,mime_type,source,availability
    ) VALUES (?,?,?,?,?,?,'available')
  `).run(
    mediaId,
    managedPath,
    sha256Buffer(buffer),
    buffer.length,
    mimeType,
    String(source || "incoming").slice(0, 80)
  );
  return publicRecord(db.prepare("SELECT * FROM media_assets WHERE media_id=?").get(mediaId));
}

function persistIncomingMedia(buffer, {
  extension = ".jpg",
  mimeType = null,
  source = "incoming",
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error("Ein leeres Medium kann nicht gespeichert werden.");
    error.code = "MEDIA_EMPTY";
    throw error;
  }
  const ext = safeExtension(extension);
  const mediaId = randomBytes(12).toString("hex");
  if (!MEDIA_ID_PATTERN.test(mediaId)) throw new Error("Ungültige Media-ID erzeugt.");
  fs.mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 });
  const finalPath = path.join(RAW_DIR, `media_${mediaId}${ext}`);
  const temporaryPath = path.join(RAW_DIR, `.media_${mediaId}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, finalPath);
    return insertManagedRecord({
      mediaId,
      managedPath: finalPath,
      buffer,
      mimeType: mimeType || mimeTypeForExtension(ext),
      source,
    });
  } catch (error) {
    if (descriptor !== null && descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    for (const candidate of [temporaryPath, finalPath]) {
      try { fs.unlinkSync(candidate); } catch {}
    }
    throw error;
  }
}

function registerManagedMedia(filePath, { source = "managed", randomBytes = crypto.randomBytes } = {}) {
  const managedPath = assertManagedPath(filePath);
  if (!fs.existsSync(managedPath) || !fs.statSync(managedPath).isFile()) {
    const error = new Error("Das verwaltete Medium ist nicht verfügbar.");
    error.code = "MEDIA_MISSING";
    throw error;
  }
  const db = databaseForHostState();
  const existing = db.prepare("SELECT * FROM media_assets WHERE managed_path=?").get(managedPath);
  if (existing) return publicRecord(existing);
  const buffer = fs.readFileSync(managedPath);
  const mediaId = randomBytes(12).toString("hex");
  return insertManagedRecord({
    mediaId,
    managedPath,
    buffer,
    mimeType: mimeTypeForExtension(path.extname(managedPath)),
    source,
  });
}

function importLocalMedia(filePath, { source = "host-import" } = {}) {
  const resolved = path.resolve(String(filePath || ""));
  if (resolved.startsWith(`${IMAGE_ROOT}${path.sep}`)) {
    return registerManagedMedia(resolved, { source });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error("Das zu importierende Medium ist nicht verfügbar.");
    error.code = "MEDIA_MISSING";
    throw error;
  }
  return persistIncomingMedia(fs.readFileSync(resolved), {
    extension: path.extname(resolved),
    source,
  });
}

function mediaRow(mediaId) {
  const id = String(mediaId || "").trim();
  if (!MEDIA_ID_PATTERN.test(id)) {
    const error = new Error("Die Media-ID ist ungültig.");
    error.code = "MEDIA_ID_INVALID";
    throw error;
  }
  const row = databaseForHostState().prepare("SELECT * FROM media_assets WHERE media_id=?").get(id);
  if (!row) {
    const error = new Error("Das Medium ist nicht bekannt.");
    error.code = "MEDIA_NOT_FOUND";
    throw error;
  }
  return row;
}

function resolveMediaAsset(mediaId, { verifyHash = true } = {}) {
  const row = mediaRow(mediaId);
  const managedPath = assertManagedPath(row.managed_path);
  let availability = "available";
  let observedHash = "";
  try {
    const stat = fs.statSync(managedPath);
    if (!stat.isFile()) availability = "missing";
    else if (verifyHash) observedHash = sha256Buffer(fs.readFileSync(managedPath));
  } catch {
    availability = "missing";
  }
  if (availability === "available" && verifyHash && observedHash !== row.sha256) {
    availability = "corrupt";
  }
  databaseForHostState().prepare(`
    UPDATE media_assets
    SET availability=?,checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE media_id=?
  `).run(availability, row.media_id);
  if (availability !== "available") {
    const error = new Error(
      availability === "corrupt"
        ? "Das gespeicherte Medium stimmt nicht mehr mit seiner Freigabe überein."
        : "Das gespeicherte Medium ist nicht verfügbar."
    );
    error.code = availability === "corrupt" ? "MEDIA_HASH_MISMATCH" : "MEDIA_MISSING";
    error.mediaId = row.media_id;
    throw error;
  }
  return {
    ...publicRecord({ ...row, availability, checked_at: new Date().toISOString() }),
    managedPath,
  };
}

function getMediaAsset(mediaId) {
  return publicRecord(mediaRow(mediaId));
}

function extractMediaIds(message, maximum = 20) {
  const ids = [];
  let match;
  const pattern = new RegExp(MEDIA_TOKEN_PATTERN.source, "g");
  while ((match = pattern.exec(String(message || ""))) && ids.length < maximum) ids.push(match[1]);
  return [...new Set(ids)];
}

module.exports = {
  IMAGE_ROOT,
  MEDIA_ID_PATTERN,
  extractMediaIds,
  getMediaAsset,
  importLocalMedia,
  persistIncomingMedia,
  registerManagedMedia,
  resolveMediaAsset,
};
