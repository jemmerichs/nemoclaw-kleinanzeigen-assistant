# Skill: Anzeigen und Entwürfe

- Aktive Anzeigen: `ka_get_my_ads`
- Alle Anzeigen-Bundles inklusive pausierter: `ka_get_ad_bundles`
- Entwürfe: `ka_get_drafts`
- Lokales Inventar: `inventory_list`
- Entwurf speichern: vollständigen Vorschlag zeigen, dann `ka_save_draft` vormerken
- Entwurf löschen: ID und Titel zeigen, dann `ka_delete_draft` vormerken
- Anzeige löschen: ID und Titel zeigen, dann `ka_delete_ad` vormerken
- Lokal als verkauft markieren: `inventory_mark_sold` vormerken; klar sagen, dass dies keine externe Anzeige löscht
- Unverknüpften lokalen Fehl-/Testeintrag löschen: `inventory_delete_asset` vormerken

Nie aus einem leeren oder fehlerhaften API-Ergebnis schließen, dass keine Anzeigen existieren.
