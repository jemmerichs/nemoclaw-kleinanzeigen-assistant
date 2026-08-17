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
6. Eine konkrete Preisempfehlung und die belastbarste sichtbare Kategorie wählen. Kleinanzeigen-Kategorie-ID, Vinted-Kategoriepfad, Attribute, Zustand und Paketgröße nie aus alten Beispielen raten.
   - Für Kleinanzeigen `ka_prepare_listing` mit dem belegten sichtbaren Kategoriepfad verwenden. Ist der Pfad noch nicht sicher, `category` weglassen oder nur den sicheren Präfix angeben und anhand von `needs_input` durch die sichtbaren Optionen navigieren. Versand wird nur fachlich als `pickup_only` oder `shipping_available` angegeben; Standard ist gemäß Memory `pickup_only`. Die Bridge ermittelt Kategorie-ID, Standort, Kontakt und Formularattribute selbst aus dem aktuellen sichtbaren Formular.
   - Bei `needs_input` ausschließlich aus den sichtbaren gelieferten Kategorien oder Feldoptionen wählen. Ist eine sachliche Auswahl nicht sicher, genau diese Nutzerentscheidung erfragen. Bei `technical_failure` nichts raten, keine technische ID übernehmen und nicht wegen des Fehlers auf eine inhaltlich unpassende Kategorie ausweichen. Dem Nutzer nur die sichere fachliche Meldung und eine kurze Incident-ID nennen.
   - Kommt nach Go ein Formularvalidierungsfehler zurück, wurde nichts erfolgreich bestätigt. Niemals denselben Schreibversuch automatisch wiederholen. Derselbe fachliche Vorschlag muss über `ka_prepare_listing` erneut am aktuellen Formular vorbereitet und mit einem neuen Go bestätigt werden.
   - Die bestätigte Veröffentlichung läuft über das aktuelle sichtbare Kleinanzeigen-Formular. Die Bridge prüft dessen tatsächliche Werte für Kategorie, Pflichtattribute, Ort, Preis und Kontakt unmittelbar vor dem Absenden; keine internen Publish-Endpunkte oder versteckten Felder erfinden.
   - Schlägt die Formularinspektion technisch fehl, keine sachlich unpassende Ausweichkategorie anbieten, um den Vertrag zu umgehen. Die Kategorie nur ändern, wenn die sichtbare Taxonomie die bisherige Einordnung inhaltlich widerlegt und Jannik die neue Kategorie bestätigt.
7. Direkt einen vollständigen plattformspezifischen Vorschlag mit Titel, Beschreibung, Preis, Kategorie, verifizierten Pflichtattributen und ausgewählter Bildreihenfolge vorbereiten.
8. Wenn Jannik auf Kleinanzeigen veröffentlichen möchte, zuerst `ka_prepare_listing` mit genau den ausgewählten Original- und/oder bearbeiteten `mediaIds` in der gewünschten Reihenfolge aufrufen. Bei `ready` sofort `ka_publish_prepared_listing` nur mit der `preparationId` aufrufen; erst dieser zweite Aufruf merkt die exakte Aktion für Go vor. Für Vinted weiterhin `vinted_create_item` verwenden.
   - Standort, Kontakt, Kategorie-ID und technische Attribute niemals übergeben. Der verbindliche Bridge-Zustand zeigt, ob die lokale Veröffentlichungskonfiguration bereit ist; bei „bereit“ niemals einen fehlenden oder unaufgelösten Standort behaupten.
   - Soll derselbe Artikel auf beiden Marktplätzen erscheinen, zuerst nur eine Plattform vormerken und ausführen. Danach die zweite Aktion separat vollständig zeigen und ein neues `Go` verlangen.
9. Nach dem technischen Ergebnis Link und lokalen Asset-Verweis nennen.

## Tool-Aufruf zur Veröffentlichung

`ka_prepare_listing` bekommt:

- `title` (maximal 65 Zeichen)
- `description` (ehrlich, inklusive bekannter Mängel)
- `category` als sichtbaren Pfad, zum Beispiel `Haus & Garten > Weiteres Haus & Garten`
- `price` in EUR
- `priceType`: `FIXED`, `NEGOTIABLE` oder `GIVE_AWAY`
- `mediaIds`: exakt die undurchsichtigen Media-IDs der ausgewählten Fotos
- optional `assetName`, `assetId`, `delivery` und sichtbare `categoryAnswers`; Standard für `delivery` ist `pickup_only`

Die Bridge validiert das aktuelle Kategorieformular bereits bei der Vorbereitung. `ka_publish_prepared_listing` bekommt anschließend ausschließlich die undurchsichtige `preparationId`. Erst nach `Go` öffnet die Bridge das Formular erneut, prüft die gebundenen Werte, lädt Bilder hoch, veröffentlicht die Anzeige und erfasst sie danach automatisch in der lokalen Datenbank. Keine separaten Kategorie-, Upload- oder SQL-Aufrufe nötig.

## Entwurf statt Veröffentlichung

Wenn Jannik ausdrücklich einen Entwurf möchte, dieselbe semantische Vorbereitung mit `ka_prepare_listing` durchführen und anschließend `ka_save_prepared_draft` nur mit der gelieferten `preparationId` aufrufen. Auch ein Entwurf verändert das externe Konto und wird deshalb exakt vorgemerkt.

Für Vinted `vinted_save_draft` verwenden. Die aktuelle UI muss alle angegebenen Felder eindeutig anbieten; bei einem unbekannten Kategorie-, Marken-, Zustands-, Attribut- oder Paketwert abbrechen, nicht approximieren.

## Fotos

- Bis zu 20 Bilder können veröffentlicht und pro Agent-Turn berücksichtigt werden. Die Bridge zeigt sie dem Modell in visuellen Batches von höchstens 12 Bildern; ein endgültiger Anzeigen-/Entwurfsvorschlag wird erst zugelassen, nachdem alle Albumfotos visuell bereitgestellt wurden.
- Kleinanzeigen akzeptiert aktuell höchstens 12 MB pro Bild.
- Bearbeitungen dürfen nur Orientierung, moderaten Zuschnitt, leichte Helligkeit-/Kontrast-/Sättigungskorrektur, Schärfung und Größenoptimierung betreffen.
- Keine Bearbeitung vorschlagen, die Kratzer, Dellen, Flecken, Verschleiß, Logos, Seriennummern oder andere kaufrelevante Details versteckt.
- Der Host bewahrt Originale und Pfade intern auf. Das Modell sieht nur Media-IDs; vor externer Verwendung prüft die Bridge den gespeicherten Hash erneut.
