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
5. Den Zielmarktplatz klären. Mit `ka_search_ads` oder `vinted_search_items` vergleichbare Angebote dort recherchieren. Bezahlte Top-/Bumped-Anzeigen nicht als normalen Marktpreis behandeln.
6. Eine konkrete Preisempfehlung und die belastbarste Kategorie wählen. Kleinanzeigen-Kategorie-ID, Vinted-Kategoriepfad, Attribute, Zustand und Paketgröße nie aus alten Beispielen raten.
   - Für Kleinanzeigen nach der Kategorie-ID immer `ka_get_category_requirements` aufrufen. Ist die Kategorie noch nicht im kurzlebigen Cache, den sichtbaren Kategoriepfad mit den gelieferten `choices` schrittweise vervollständigen; keine internen Schlüssel oder Werte raten. Verifizierte Pflichtfelder exakt übernehmen. Für Versand gilt Janniks automatisch geladene Memory-Präferenz „Nur Abholung“, sofern der aktuelle Kategorievertrag genau diese sichtbare Option anbietet und Jannik nichts anderes verlangt. Nur bei abweichendem Wunsch oder fehlender eindeutiger Option nachfragen. Eine unverifizierte Kategorie darf nicht zur Bestätigung vorgemerkt werden.
   - Kommt trotz Vorprüfung ein Kategorie-Formularvalidierungsfehler zurück, wurde nichts erfolgreich bestätigt und die Bridge sperrt den abgelehnten Kategorievertrag. `ka_get_category_requirements` mit `refresh: true` verwenden, das Kategorieformular erneut inspizieren, neue Pflichtfelder übernehmen und erst nach erfolgreicher Verifizierung eine neue Aktion mit neuem Go vorbereiten. Eine Nutzerantwort wie „Kein Versand“ ist nur die Auswahlentscheidung und ersetzt den Formular-Refresh nicht. Technische Backend-Feldnamen aus der Fehlermeldung, insbesondere Varianten mit einem Suffix wie `_s`, niemals als Formularschlüssel übernehmen. Bei Ortsfehlern PLZ und Location-ID als Paar neu auflösen; die PLZ ist niemals selbst die Location-ID. Niemals denselben Schreibversuch automatisch wiederholen. Nach einem unklaren Schreibergebnis blockiert die Bridge denselben unveränderten Aktions-Fingerprint.
   - Schlägt die Formularinspektion technisch fehl, keine sachlich unpassende Ausweichkategorie anbieten, um den Vertrag zu umgehen. Die Kategorie nur ändern, wenn die sichtbare Taxonomie die bisherige Einordnung inhaltlich widerlegt und Jannik die neue Kategorie bestätigt.
7. Direkt einen vollständigen plattformspezifischen Vorschlag mit Titel, Beschreibung, Preis, Kategorie, verifizierten Pflichtattributen und ausgewählter Bildreihenfolge vorbereiten.
8. Wenn Jannik veröffentlichen möchte, `ka_create_ad` oder `vinted_create_item` mit genau den ausgewählten Original- und/oder bearbeiteten `imagePaths` in der gewünschten Reihenfolge aufrufen. Die Bridge führt den Aufruf noch nicht aus, sondern merkt exakt diese Aktion vor.
   - Für Kleinanzeigen die Standort- und Kontaktargumente weglassen. Der verbindliche Bridge-Zustand zeigt, ob die lokale Veröffentlichungskonfiguration bereit ist; bei „bereit“ niemals einen fehlenden oder unaufgelösten Standort behaupten.
   - Soll derselbe Artikel auf beiden Marktplätzen erscheinen, zuerst nur eine Plattform vormerken und ausführen. Danach die zweite Aktion separat vollständig zeigen und ein neues `Go` verlangen.
9. Nach dem technischen Ergebnis Link und lokalen Asset-Verweis nennen.

## Tool-Aufruf zur Veröffentlichung

`ka_create_ad` bekommt:

- `title` (maximal 65 Zeichen)
- `description` (ehrlich, inklusive bekannter Mängel)
- `categoryId` (verifiziert)
- `price` in EUR
- `priceType`: `FIXED`, `NEGOTIABLE` oder `GIVE_AWAY`
- `imagePaths`: exakt die lokalen Pfade aus den `[FOTO path:...]`-Tokens
- optional `assetName`, `assetId`, `attributes`; Standort und Kontakt setzt die Bridge aus der festen Konfiguration ein

Die Bridge validiert aktuelle Kategoriepflichtfelder bereits vor der Freigabe und blockiert unbekannte oder unverifizierte Kategorien. Erst nach `Go` lädt sie Bilder hoch, veröffentlicht die Anzeige und erfasst sie danach automatisch in der lokalen Datenbank. Keine separaten Upload- oder SQL-Aufrufe nötig.

## Entwurf statt Veröffentlichung

Wenn Jannik ausdrücklich einen Entwurf möchte, `ka_save_draft` mit denselben lokalen Bildpfaden verwenden. Auch ein Entwurf verändert das externe Konto und wird deshalb exakt vorgemerkt.

Für Vinted `vinted_save_draft` verwenden. Die aktuelle UI muss alle angegebenen Felder eindeutig anbieten; bei einem unbekannten Kategorie-, Marken-, Zustands-, Attribut- oder Paketwert abbrechen, nicht approximieren.

## Fotos

- Bis zu 20 Bilder können veröffentlicht und pro Agent-Turn berücksichtigt werden. Die Bridge zeigt sie dem Modell in visuellen Batches von höchstens 12 Bildern; ein endgültiger Anzeigen-/Entwurfsvorschlag wird erst zugelassen, nachdem alle Albumfotos visuell bereitgestellt wurden.
- Kleinanzeigen akzeptiert aktuell höchstens 12 MB pro Bild.
- Bearbeitungen dürfen nur Orientierung, moderaten Zuschnitt, leichte Helligkeit-/Kontrast-/Sättigungskorrektur, Schärfung und Größenoptimierung betreffen.
- Keine Bearbeitung vorschlagen, die Kratzer, Dellen, Flecken, Verschleiß, Logos, Seriennummern oder andere kaufrelevante Details versteckt.
- Originalpfade bleiben erhalten und werden erst beim bestätigten Schreibvorgang übertragen.
