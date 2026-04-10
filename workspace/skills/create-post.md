# Skill: Anzeige erstellen

**Wann:** Jannik möchte etwas verkaufen / schickt Fotos.

**Flow:** Kontext sammeln → Preisrecherche → Fotos aufbereiten → Proposal → "Go" → posten.

---

## Kontext

Fotos kommen als `[FOTO path:/absoluter/pfad/workspace/images/raw/photo_....jpg]` Tokens an (Bridge speichert sie persistent als absoluten Pfad vor). Artikel und Zustand entweder aus Caption oder nachfragen (max. 1 Rückfrage).

## Preisrecherche

Automatisch via `ka_search_ads` durchführen. Einen konkreten Preis empfehlen (keine Spanne).

## Fotos aufbereiten

Bis zu 3 Bilder auswählen (Gesamtansicht, Detail, Zustand). Rohfotos die komplett unbrauchbar sind überspringen.

`processImages` nur aufrufen wenn nötig — schlechte Beleuchtung, unruhiger Hintergrund, schiefes Bild. Handyfotos die schon okay sind direkt verwenden. API-Aufrufe sparen.

```
processImages({ paths: [...], instructions: "item description, mention visible flaws" })
```

## Proposal

Fotos senden: `"photo": "/pfad/zum/bild"` Feld in der Antwort (eines pro Nachricht), dann Anzeigentext.

**Beschreibung:** Natürliche Sprache, kein Marketing. Zustand ehrlich beschreiben inkl. Mängel. Kurz halten.

**Titel:** Max. 60 Zeichen, prägnant.

Klar kommunizieren was Jannik mit "Go" bestätigt und was er noch ändern kann.

## Ad-Store (vor und nach "Go")

**Vor "Go" — Entwurf anlegen:**
```
db_query({ sql: "INSERT INTO assets (name, listing_name, description, last_price_cents) VALUES (?,?,?,?)",
           params: [name, title, description, priceInCents] })
→ lastInsertRowid = assetId
```

**Bildpfade speichern / aktualisieren** (nach Foto-Eingang oder processImages):
```
saveImages({ assetId, paths: ["/absoluter/pfad/foto1.jpg", ...] })
→ { assetId, imageCount, paths }
```
Merged automatisch mit bestehenden Pfaden — kein JSON.stringify, kein manuelles Lesen nötig.

**Vor "Go" prüfen:** Falls `image_paths` bereits gesetzt ist, Pfade aus DB laden — kein erneuter Download nötig (Neustart-sicher).

**Nach "Go" — KA erstellen + DB aktualisieren:**
```
// Bildpfade aus DB holen:
saveImages({ assetId, paths: [] })  // oder db_query SELECT image_paths
→ paths[] direkt verwenden

// Bilder zuerst hochladen (vor der Anzeige):
ka_upload_image({ filePath })  // einmal pro Pfad → { imageId }
// alle imageIds sammeln, dann:
ka_create_ad({ title, description, categoryId, price, priceType: "NEGOTIABLE", imageIds: ["id1","id2",...] }) → { id: kaId, link }

db_query({ sql: "INSERT INTO ka_listings (asset_id, ka_id, ka_link, price_cents, status, posted_at) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
           params: [assetId, kaId, link, priceInCents, "active"] })
db_query({ sql: "UPDATE assets SET has_active_listing=1, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
           params: [assetId] })
```

Preise als Cent-Integer (45€ → 4500).

---

## Kategorien (häufige Beispiele)

| Artikel           | categoryId | categorySlug       |
|-------------------|------------|--------------------|
| Fahrräder         | 217        | fahrraeder         |
| Smartphones       | 162        | handys-smartphones |
| Laptops           | 278        | laptops            |
| Kleidung (Herren) | 176        | herrenkleidung     |
| Möbel             | 83         | moebel             |
| Sportartikel      | 221        | sportartikel       |

Kategorie unbekannt → `ka_search_ads` aufrufen, Ergebnisse zeigen die richtige Kategorie.
