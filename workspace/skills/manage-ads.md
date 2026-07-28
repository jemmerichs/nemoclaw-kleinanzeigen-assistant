# Skill: Lokales Inventar verwalten

`inventory_list` zeigt lokale Assets, Preise, Status, Bildpfade und Entwurfsreferenzen.

`inventory_get_asset` zeigt für einen Artikel das kanonische letzte Posting, die geordnete Bildauswahl samt Original-/Bearbeitungsprovenienz, alle bisherigen Anzeigenversuche und je Versuch einen kompakten Preis-/Aufrufverlauf. Dieses Tool für Relists, Performance-Checks und Käuferfragen zu einem bekannten Asset bevorzugen.

`inventory_mark_sold` markiert ein Asset nach exakter Bestätigung lokal als verkauft. Der Status einer weiterhin aktiven externen Anzeige bleibt dabei bewusst erhalten; wenn sie ebenfalls gelöscht werden soll, ist das eine separate `ka_delete_ad`-Aktion mit eigener Bestätigung.

`inventory_delete_asset` entfernt nach exakter Bestätigung ausschließlich einen unverknüpften lokalen Fehl- oder Testeintrag. Sobald eine Entwurfs-ID oder irgendeine Anzeigenhistorie existiert, blockiert die Bridge die Löschung.

Veröffentlichte Anzeigen und Entwürfe werden durch `ka_create_ad` beziehungsweise `ka_save_draft` automatisch lokal erfasst. Keine freien SQL-Schreibzugriffe anfordern.

Der Anzeigen-Lifecycle-Check toleriert einen einzelnen fehlenden Abruf. Nach zwei erfolgreichen Abrufen ohne eine zuvor aktive Anzeige informiert er proaktiv, prüft nach Möglichkeit den Bundle-Status und schlägt ein Relist aus dem gespeicherten kanonischen Posting vor. Niemals selbst veröffentlichen. Verkaufte Assets und Dubletten mit bereits aktiver Anzeige werden von der Bridge blockiert.

## Aktive, aber schwache Anzeige

Wenn Jannik nach einer schlecht laufenden oder „stalen“ Anzeige fragt:

1. Mit `inventory_get_asset` den letzten Prüfzeitpunkt, Aufrufdelta, Preisänderungen, Posting-Text und Bildauswahl lesen.
2. Fehlende oder kurze Historie offen benennen. Aus wenigen Snapshots keine Nachfrageentwicklung erfinden.
3. Mit `ka_search_ads` aktuelle, wirklich vergleichbare Angebote recherchieren.
4. Zuerst Diagnose und priorisierte Änderung vorschlagen: Titel/Keywords, ehrlich besseres Titelbild, fehlende Zustandsangaben oder Preis. Nicht automatisch alles gleichzeitig ändern.
5. Preis niemals allein wegen weniger Aufrufe senken und keine automatische Preisgrenze erfinden. Eine konkrete Änderung oder ein neuer Post bleibt eine eigene geschützte Aktion mit vollständiger Vorschau und frischem `Go`.
