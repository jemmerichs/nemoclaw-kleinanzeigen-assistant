# Skill: Lokales Inventar verwalten

`inventory_list` zeigt lokale Assets, Preise, Status, Bildpfade und Entwurfsreferenzen.

`inventory_mark_sold` markiert ein Asset nach exakter Bestätigung lokal als verkauft. Der Status einer weiterhin aktiven externen Anzeige bleibt dabei bewusst erhalten; wenn sie ebenfalls gelöscht werden soll, ist das eine separate `ka_delete_ad`-Aktion mit eigener Bestätigung.

`inventory_delete_asset` entfernt nach exakter Bestätigung ausschließlich einen unverknüpften lokalen Fehl- oder Testeintrag. Sobald eine Entwurfs-ID oder irgendeine Anzeigenhistorie existiert, blockiert die Bridge die Löschung.

Veröffentlichte Anzeigen und Entwürfe werden durch `ka_create_ad` beziehungsweise `ka_save_draft` automatisch lokal erfasst. Keine freien SQL-Schreibzugriffe anfordern.
