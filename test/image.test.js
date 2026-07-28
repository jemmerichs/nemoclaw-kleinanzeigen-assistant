"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const sharp = require("sharp");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-"));
process.env.NEMOCLAW_IMAGE_DIR = path.join(directory, "images");
const image = require("../tools/image");

test.after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

test("image edit preserves the original and records deterministic provenance", async () => {
  const sourceBuffer = await sharp({
    create: {
      width: 1600,
      height: 1000,
      channels: 3,
      background: { r: 140, g: 90, b: 40 },
    },
  }).jpeg().toBuffer();
  const sourcePath = image.saveTemp(sourceBuffer);
  const sourceBefore = fs.readFileSync(sourcePath);
  const operations = {
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    brightness: 1.05,
    contrast: 1.05,
    saturation: 0.95,
    sharpen: true,
    maxLongEdge: 1200,
  };

  const first = await image.editImage(sourcePath, operations);
  const second = await image.editImage(sourcePath, operations);

  assert.equal(first.outputPath, second.outputPath);
  assert.equal(first.kind, "edited");
  assert.equal(first.sourcePath, sourcePath);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
  assert.equal(fs.existsSync(`${first.outputPath}.provenance.json`), true);
  assert.equal(first.outputSha256, image.fileSha256(first.outputPath));
  assert.equal(first.outputDimensions.width <= 1200, true);
  assert.equal(first.outputDimensions.height <= 1200, true);
  assert.equal(fs.statSync(first.outputPath).mode & 0o777, 0o600);
  assert.deepEqual(image.readProvenance(first.outputPath), first);
});

test("image edit rejects escape paths and aggressive or unknown operations", async () => {
  const outside = path.join(directory, "outside.jpg");
  fs.writeFileSync(outside, Buffer.from("not-an-image"));
  await assert.rejects(() => image.editImage(outside, {}), /außerhalb/);

  const sourceBuffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: "white",
    },
  }).jpeg().toBuffer();
  const sourcePath = image.saveTemp(sourceBuffer);
  await assert.rejects(() => image.editImage(sourcePath, { brightness: 1.8 }), /zwischen 0.8 und 1.2/);
  await assert.rejects(() => image.editImage(sourcePath, { removeScratches: true }), /Unbekannte Bildoperation/);
  await assert.rejects(
    () => image.editImage(sourcePath, { crop: { x: 0.8, y: 0, width: 0.5, height: 1 } }),
    /außerhalb/
  );
});

test("explicit rotation is applied after orientation normalization", async () => {
  const sourceBuffer = await sharp({
    create: {
      width: 300,
      height: 150,
      channels: 3,
      background: "navy",
    },
  }).jpeg().toBuffer();
  const sourcePath = image.saveTemp(sourceBuffer);
  const edited = await image.editImage(sourcePath, {
    rotate: 90,
    maxLongEdge: 1200,
  });
  assert.deepEqual(edited.outputDimensions, { width: 150, height: 300 });
});
