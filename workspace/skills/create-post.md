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

**Vor "Go" — Entwurf anlegen + Bildpfade speichern:**
```
db_query({ sql: "INSERT INTO assets (name, listing_name, description, last_price_cents, image_paths) VALUES (?,?,?,?,?)",
           params: [name, title, description, priceInCents, JSON.stringify(finalPaths)] })
→ lastInsertRowid = assetId
```
`finalPaths` = optimierte Pfade falls `processImages` aufgerufen wurde, sonst Rohpfade.

**Bildpfade nachträglich aktualisieren** (falls Asset schon existiert):
```
db_query({ sql: "UPDATE assets SET image_paths=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
           params: [JSON.stringify(finalPaths), assetId] })
```

**Vor "Go" prüfen:** Falls `image_paths` bereits gesetzt ist, Pfade aus DB laden — kein erneuter Download nötig (Neustart-sicher).

**Nach "Go" — KA erstellen + DB aktualisieren:**
```
// Bildpfade aus DB holen:
db_query({ sql: "SELECT image_paths FROM assets WHERE id=?", params: [assetId] })
→ JSON.parse(row.image_paths) = paths[]

ka_create_ad({ title, description, categoryId, price, priceType: "NEGOTIABLE" }) → { id: kaId, link }
ka_upload_photo({ adId: kaId, filePath })  // einmal pro Pfad aus image_paths

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
