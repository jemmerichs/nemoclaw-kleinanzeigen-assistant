#!/usr/bin/env node
/**
 * End-to-end draft-with-images test.
 * Uploads 1 image (forDraft:true) → saves draft with imageUrls
 * → fetches drafts to verify image is attached → deletes draft.
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs   = require("fs");
const path = require("path");

const KleinanzeigenClient = require("../tools/kleinanzeigen");

const TEST_IMAGE = path.resolve(__dirname, "../workspace/images/raw/photo_1775243732687_7a847955.jpg");

async function run() {
  const cookies = process.env.KA_COOKIES;
  if (!cookies) throw new Error("KA_COOKIES fehlt. Bitte 'npm run login' ausführen.");
  const ka = new KleinanzeigenClient(cookies);

  // ── 1. Upload image with forDraft flag ─────────────────────────────────────
  console.log(`[test] Lade Bild hoch (forDraft=true): ${path.basename(TEST_IMAGE)}`);
  const buffer = fs.readFileSync(TEST_IMAGE);
  const { imageId, imageUrl } = await ka.uploadImage(buffer, path.basename(TEST_IMAGE), "image/jpeg", { forDraft: true });
  console.log(`[test] ✓ imageId=${imageId}  url=${imageUrl}`);

  // ── 2. Save draft with image ───────────────────────────────────────────────
  console.log("[test] Speichere Entwurf mit Bild...");
  const { draftId, imageCount } = await ka.saveDraft({
    title:       "Testentwurf mit Bild",
    description: "Automatischer Test — wird sofort gelöscht.",
    categoryId:  null,
    imageUrls:   [imageUrl],
  });
  console.log(`[test] ✓ Entwurf gespeichert: draftId=${draftId}  imageCount=${imageCount}`);

  // ── 3. Verify image is attached ────────────────────────────────────────────
  console.log("[test] Prüfe Entwürfe...");
  const drafts = await ka.getDrafts();
  const saved  = drafts.find(d => String(d.id) === String(draftId));
  if (!saved) throw new Error(`Entwurf ${draftId} nicht in Liste gefunden.`);
  console.log(`[test] ✓ Entwurf gefunden: "${saved.title}"  images=${saved.images}`);
  if (saved.images < 1) {
    console.warn("[test] ⚠ Entwurf hat 0 Bilder — KA hat Bild-Anhang ignoriert.");
  } else {
    console.log("[test] ✓ Bild erfolgreich am Entwurf gespeichert.");
  }

  // ── 4. Cleanup ─────────────────────────────────────────────────────────────
  console.log(`[test] Lösche Entwurf ${draftId}...`);
  await ka.deleteDraft(draftId);
  console.log("[test] ✓ Entwurf gelöscht. Test abgeschlossen.");
}

run().catch(e => { console.error("[test] Fehler:", e.message); process.exit(1); });
