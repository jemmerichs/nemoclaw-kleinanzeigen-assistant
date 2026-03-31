# Skill: Anzeige erstellen

**Wann:** Jannik möchte etwas verkaufen / schickt Fotos.

**Flow:** Kontext sammeln → Preisrecherche → Fotos aufbereiten → Proposal → "Go" → posten.

---

## Kontext

Fotos kommen als `[FOTO file_id:xxx]` Tokens in der Konversation an. Artikel und Zustand entweder aus Caption oder nachfragen (max. 1 Rückfrage).

## Preisrecherche

Automatisch via `searchAds` durchführen. Einen konkreten Preis empfehlen (keine Spanne).

## Fotos aufbereiten

```
downloadTelegramPhoto({ fileId }) → { path }   // einmal pro FOTO-Token
```

Bis zu 3 Bilder auswählen (Gesamtansicht, Detail, Zustand). Rohfotos die komplett unbrauchbar sind überspringen.

`processImages` nur aufrufen wenn nötig — schlechte Beleuchtung, unruhiger Hintergrund, schiefes Bild. Handyfotos die schon okay sind direkt verwenden. API-Aufrufe sparen.

```
processImages({ paths: [...], instructions: "item description, mention visible flaws" })
```

## Proposal

Zuerst die aufbereiteten Fotos senden (`sendTelegramPhoto`), dann den Anzeigentext als Nachricht.

**Beschreibung:** Natürliche Sprache, kein Marketing. Zustand ehrlich beschreiben inkl. Mängel. Kurz halten.

**Titel:** Max. 60 Zeichen, prägnant.

Klar kommunizieren was Jannik mit "Go" bestätigt und was er noch ändern kann.

## Ad-Store (vor und nach "Go")

**Vor "Go" — Entwurf anlegen:**
```
db({ sql: "INSERT INTO ads (title, description, category_id, price_cents, status, facts) VALUES (?,?,?,?,?,?)",
     params: [title, description, categoryId, priceInCents, "draft", JSON.stringify({ condition, notes })] })
→ { lastInsertRowid }  // localAdId merken

db({ sql: "INSERT INTO price_history (ad_id, price_cents, note) VALUES (?,?,?)",
     params: [localAdId, priceInCents, "initial"] })
```

**Nach "Go" — KA erstellen + DB aktualisieren:**
```
createAd({ title, description, categoryId, price, priceType: "NEGOTIABLE" }) → { id: kaId, link }
uploadPhoto({ adId, filePath })  // einmal pro Bild

db({ sql: "UPDATE ads SET ka_id=?, ka_link=?, status='active', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
     params: [kaId, link, localAdId] })
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

Kategorie unbekannt → `searchAds` aufrufen, Ergebnisse zeigen die richtige Kategorie.
