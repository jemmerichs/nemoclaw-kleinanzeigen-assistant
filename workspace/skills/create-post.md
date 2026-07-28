# Skill: Anzeige erstellen

## Ziel

Aus Fotos und kurzem Kontext einen ehrlichen, marktgerechten Anzeigenvorschlag erstellen. Noch vor jeder Kontomutation zeigt die Bridge die exakte Aktion. Ein eigenständiges `Go` führt nur diese vorgemerkte Aktion aus.

## Ablauf

1. Fotos und Caption analysieren. Sichtbare Marke, Modell, Zustand und Mängel nennen; nichts erfinden.
   - Zeigen die Bilder offensichtlich mehrere verschiedene Artikel und ist nicht klar, ob sie als Set oder einzeln verkauft werden sollen, vor Recherche oder Posting genau diese eine Entscheidung erfragen.
2. Doppelte, unscharfe oder wenig hilfreiche Bilder aussortieren und eine sinnvolle Reihenfolge wählen: aussagekräftiges Titelbild, weitere Ansichten, Details und zuletzt sichtbare Mängel.
   - Fotos mit Briefen, Adressen, Gesichtern oder anderen unnötigen privaten Informationen nicht verwenden. Nur peripheren privaten Inhalt wegschneiden, wenn Produkt und Zustand vollständig ehrlich sichtbar bleiben; sonst das Foto auslassen und Jannik darauf hinweisen.
3. Nur einzelne Fotos mit einem konkreten Problem über `image_edit` korrigieren. Das Tool zeigt jede bearbeitete Version als Telegram-Vorschau; nach der visuellen Kontrolle Original oder Ausgabe auswählen.
4. Fehlt genau eine entscheidende Angabe (zum Beispiel Funktionstest oder Größe), höchstens eine gebündelte Rückfrage stellen.
5. Mit `ka_search_ads` vergleichbare Angebote recherchieren. Bezahlte Top-Anzeigen nicht als normalen Marktpreis behandeln.
6. Eine konkrete Preisempfehlung und die belastbarste Kategorie-ID wählen. Kategorie-ID nicht aus alten Beispielen raten.
7. Direkt einen vollständigen Vorschlag mit Titel, Beschreibung, Preis, Kategorie, Ort und ausgewählter Bildreihenfolge vorbereiten.
8. Wenn Jannik veröffentlichen möchte, `ka_create_ad` mit genau den ausgewählten Original- und/oder bearbeiteten `imagePaths` in der gewünschten Reihenfolge aufrufen. Die Bridge führt den Aufruf noch nicht aus, sondern merkt exakt diese Aktion vor.
9. Nach dem technischen Ergebnis Link und lokalen Asset-Verweis nennen.

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

- Bis zu 20 Bilder können veröffentlicht werden; höchstens 12 werden pro Agent-Turn visuell analysiert. Bei mehr als 12 Bildern bitte um eine Vorauswahl oder teile sie sinnvoll in Artikelgruppen.
- Kleinanzeigen akzeptiert aktuell höchstens 12 MB pro Bild.
- Bearbeitungen dürfen nur Orientierung, moderaten Zuschnitt, leichte Helligkeit-/Kontrast-/Sättigungskorrektur, Schärfung und Größenoptimierung betreffen.
- Keine Bearbeitung vorschlagen, die Kratzer, Dellen, Flecken, Verschleiß, Logos, Seriennummern oder andere kaufrelevante Details versteckt.
- Originalpfade bleiben erhalten und werden erst beim bestätigten Schreibvorgang übertragen.
