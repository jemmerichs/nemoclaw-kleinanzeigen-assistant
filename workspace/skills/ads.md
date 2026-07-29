# Skill: Anzeigen und Entwürfe

## Kleinanzeigen

- Aktive Anzeigen: `ka_get_my_ads`
- Alle Anzeigen-Bundles inklusive pausierter: `ka_get_ad_bundles`
- Entwürfe: `ka_get_drafts`
- Lokales Inventar: `inventory_list`
- Entwurf speichern: vollständigen Vorschlag zeigen, dann `ka_save_draft` vormerken
- Entwurf löschen: ID und Titel zeigen, dann `ka_delete_draft` vormerken
- Anzeige löschen: ID und Titel zeigen, dann `ka_delete_ad` vormerken

## Vinted

- Angemeldetes Profil prüfen: `vinted_get_account`
- Aktive Artikel: `vinted_get_my_items`
- Öffentliche Recherche: `vinted_search_items`
- Entwurf speichern: vollständigen Vorschlag zeigen, dann `vinted_save_draft` vormerken
- Artikel veröffentlichen: vollständigen Vorschlag zeigen, dann `vinted_create_item` vormerken
- Artikel löschen: ID und Titel zeigen, dann `vinted_delete_item` vormerken
- Vinted-Entwürfe lesen/löschen sowie gefüllte Nachrichtenverläufe lesen oder beantworten sind noch nicht freigeschaltet, solange die aktuelle Oberfläche nicht an echten, harmlosen Beispielen eindeutig belegt wurde. Keine Ersatz-Endpunkte oder Selektoren raten.

## Gemeinsames Inventar

- Lokal als verkauft markieren: `inventory_mark_sold` vormerken; klar sagen, dass dies keine externe Anzeige löscht
- Unverknüpften lokalen Fehl-/Testeintrag löschen: `inventory_delete_asset` vormerken

Nie aus einem leeren oder fehlerhaften API-Ergebnis schließen, dass keine Anzeigen existieren.
