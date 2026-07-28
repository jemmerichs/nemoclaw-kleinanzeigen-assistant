# Skill: Anzeige erstellen

## Ziel

Aus Fotos und kurzem Kontext einen ehrlichen, marktgerechten Anzeigenvorschlag erstellen. Noch vor jeder Kontomutation zeigt die Bridge die exakte Aktion. Ein eigenständiges `Go` führt nur diese vorgemerkte Aktion aus.

## Ablauf

1. Fotos und Caption analysieren. Sichtbare Marke, Modell, Zustand und Mängel nennen; nichts erfinden.
2. Fehlt genau eine entscheidende Angabe (zum Beispiel Funktionstest oder Größe), höchstens eine gebündelte Rückfrage stellen.
3. Mit `ka_search_ads` vergleichbare Angebote recherchieren. Bezahlte Top-Anzeigen nicht als normalen Marktpreis behandeln.
4. Eine konkrete Preisempfehlung und die belastbarste Kategorie-ID wählen. Kategorie-ID nicht aus alten Beispielen raten.
5. Direkt einen vollständigen Vorschlag mit Titel, Beschreibung, Preis, Kategorie, Ort und Bildanzahl vorbereiten.
6. Wenn Jannik veröffentlichen möchte, `ka_create_ad` mit den originalen lokalen `imagePaths` aufrufen. Die Bridge führt den Aufruf noch nicht aus, sondern merkt exakt diese Aktion vor.
7. Nach dem technischen Ergebnis Link und lokalen Asset-Verweis nennen.

## Tool-Aufruf zur Veröffentlichung

`ka_create_ad` bekommt:

- `title` (maximal 65 Zeichen)
- `description` (ehrlich, inklusive bekannter Mängel)
- `categoryId` (verifiziert)
- `price` in EUR
- `priceType`: `FIXED`, `NEGOTIABLE` oder `GIVE_AWAY`
- `imagePaths`: exakt die lokalen Pfade aus den `[FOTO path:...]`-Tokens
- optional `assetName`, `assetId`, `attributes`, `zipCode`, `locationId`, `contactName`

Die Bridge lädt Bilder erst nach `Go` hoch, veröffentlicht die Anzeige und erfasst sie danach automatisch in der lokalen Datenbank. Keine separaten Upload- oder SQL-Aufrufe nötig.

## Entwurf statt Veröffentlichung

Wenn Jannik ausdrücklich einen Entwurf möchte, `ka_save_draft` mit denselben lokalen Bildpfaden verwenden. Auch ein Entwurf verändert das externe Konto und wird deshalb exakt vorgemerkt.

## Fotos

- Bis zu 20 Bilder sind technisch möglich; konzentriere dich auf die aussagekräftigen Fotos.
- Kleinanzeigen akzeptiert aktuell höchstens 12 MB pro Bild.
- Keine Bearbeitung vorschlagen, die Kratzer, Dellen, Flecken oder Verschleiß versteckt.
- Originalpfade bleiben erhalten und werden erst beim bestätigten Schreibvorgang übertragen.
