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
processImages({ paths: [...], instructions: "item description, mention visible flaws" })
```

Bis zu 3 Bilder auswählen (Gesamtansicht, Detail, Zustand). Rohfotos die komplett unbrauchbar sind überspringen.

## Proposal

Zuerst die aufbereiteten Fotos senden (`sendTelegramPhoto`), dann den Anzeigentext als Nachricht.

**Beschreibung:** Natürliche Sprache, kein Marketing. Zustand ehrlich beschreiben inkl. Mängel. Kurz halten.

**Titel:** Max. 60 Zeichen, prägnant.

Klar kommunizieren was Jannik mit "Go" bestätigt und was er noch ändern kann.

## Erstellen (nur nach "Go")

```
createAd({ title, description, categoryId, price, priceType: "NEGOTIABLE" }) → { id, link }
uploadPhoto({ adId, filePath })  // einmal pro Bild
```

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
