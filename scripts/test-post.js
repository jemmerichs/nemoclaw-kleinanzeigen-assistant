#!/usr/bin/env node
/**
 * End-to-end post test for asset id=1 (Klettersteigset).
 * Uploads 2 images → creates ad → prints link → deletes ad.
 * Dangerous manual diagnostic: briefly publishes a real ad.
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs   = require("fs");
const path = require("path");

const KleinanzeigenClient = require("../tools/kleinanzeigen");
const { query: dbQuery }  = require("../tools/adstore");

function requireExplicitMutationOptIn() {
  const flag = "--i-understand-this-publishes-a-real-ad";
  if (process.env.NEMOCLAW_MODE !== "live" || !process.argv.includes(flag)) {
    throw new Error(
      `Blockiert. Nur bewusst mit NEMOCLAW_MODE=live und Flag ${flag} ausführen. ` +
      "Bevorzugt den Agenten mit exakter Go-Freigabe verwenden."
    );
  }
}

async function run() {
  requireExplicitMutationOptIn();
  // ── 1. Load asset from DB ──────────────────────────────────────────────────
  const rows = dbQuery({ sql: "SELECT * FROM assets WHERE id=1" });
  if (!rows.length) throw new Error("Asset id=1 nicht gefunden.");
  const asset = rows[0];

  const imagePaths = JSON.parse(asset.image_paths || "[]");
  if (imagePaths.length < 2) throw new Error("Weniger als 2 Bilder in der DB.");

  console.log(`[test] Asset: "${asset.listing_name}" — ${imagePaths.length} Bilder, Preis: ${asset.last_price_cents / 100}€`);

  // ── 2. Init client ─────────────────────────────────────────────────────────
  const cookies = process.env.KA_COOKIES;
  if (!cookies) throw new Error("KA_COOKIES fehlt. Bitte 'npm run login' ausführen.");
  const ka = new KleinanzeigenClient(cookies);

  // ── 3. Upload images ───────────────────────────────────────────────────────
  const imageUrls = [];
  for (const filePath of imagePaths) {
    console.log(`[test] Lade Bild hoch: ${path.basename(filePath)}`);
    const buffer = fs.readFileSync(filePath);
    const { imageId, imageUrl } = await ka.uploadImage(buffer, path.basename(filePath));
    console.log(`[test] ✓ imageId=${imageId}  url=${imageUrl}`);
    imageUrls.push(imageUrl);
  }

  let kaId = null;
  try {
    // ── 4. Create ad ─────────────────────────────────────────────────────────
    console.log("[test] Erstelle Anzeige...");
    const created = await ka.createAd({
      title:       asset.listing_name,
      description: asset.description,
      categoryId:  asset.category_id,
      price:       asset.last_price_cents / 100,
      priceType:   "NEGOTIABLE",
      zipCode:     process.env.KA_DEFAULT_ZIP_CODE,
      locationId:  process.env.KA_DEFAULT_LOCATION_ID,
      contactName: process.env.KA_CONTACT_NAME,
      imageUrls,
      attributes: {},
    });
    kaId = created.id;
    console.log(`[test] ✓ Anzeige erstellt: id=${kaId}  link=${created.link}`);

    // ── 5. Write to DB ───────────────────────────────────────────────────────
    dbQuery({
      sql: `INSERT INTO ka_listings (asset_id, ka_id, ka_link, price_cents, status, posted_at)
            VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      params: [asset.id, kaId, created.link, asset.last_price_cents, "active"],
    });
    dbQuery({
      sql: `UPDATE assets SET has_active_listing=1, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
      params: [asset.id],
    });
    console.log("[test] ✓ DB aktualisiert.");
  } finally {
    if (kaId) {
      console.log(`[test] Lösche Testanzeige ${kaId}...`);
      const deleted = await ka.deleteAd(kaId);
      console.log(`[test] ✓ Gelöscht (status=${deleted.status})`);
      dbQuery({
        sql: `UPDATE ka_listings SET status='removed' WHERE ka_id=?`,
        params: [kaId],
      });
      dbQuery({
        sql: `UPDATE assets
              SET has_active_listing=CASE WHEN EXISTS (
                SELECT 1 FROM ka_listings WHERE asset_id=? AND status='active'
              ) THEN 1 ELSE 0 END,
                  updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE id=?`,
        params: [asset.id, asset.id],
      });
      console.log("[test] ✓ DB bereinigt.");
    }
  }
  console.log("[test] ✓ Test erfolgreich.");
}

run().catch(e => { console.error("[test] Fehler:", e.message); process.exit(1); });
