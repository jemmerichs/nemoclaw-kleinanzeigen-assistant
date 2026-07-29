# Skill: Vinted

## Sicherer Umfang

- Öffentliche Suche: `vinted_search_items`
- Profilprüfung: `vinted_get_account`
- Eigene aktive Artikel: `vinted_get_my_items`
- Inbox read-only: `vinted_get_conversations` (die aktuelle Leeransicht ist belegt)
- Entwurf, Veröffentlichung und Löschung: ausschließlich über die entsprechenden `vinted_*`-Tools und das exakte `Go`

Vinted wird über die aktuelle sichtbare Web-Oberfläche in einem separaten persistenten Chrome-Profil bedient. Keine privaten Endpunkte, Tokens, IDs, Selektoren oder Werte erfinden. Eine Challenge, ein Login-Redirect, ein unerwartetes Seitenformat oder eine uneindeutige Erfolgsanzeige ist ein harter Abbruch ohne automatische Wiederholung.

## Vorschlag

Vor `vinted_create_item` müssen sicher feststehen:

- Titel, ehrliche Beschreibung und Preis
- sichtbarer Kategoriename plus vollständiger sichtbarer Kategoriepfad
- Marke oder bewusst „ohne Marke“
- einer der aktuell unterstützten Zustände
- alle kategoriespezifischen Pflichtattribute mit exakt sichtbarem Wert
- eine in der aktuellen Kategorie belegte Paketgrößen-ID
- mindestens ein, höchstens 20 lokale Bilder in finaler Reihenfolge

Die bisher belegte Laptop-Oberfläche bietet die Paketgrößen-IDs 8, 9 und 10. Für andere Kategorien wird nicht aus diesen IDs extrapoliert. Wenn die sichtbaren Werte nicht belegt sind, Jannik um einen manuellen UI-Schritt bitten oder den Vorgang als Vorschlag belassen.

## Account-Schonung

- Keine schnellen Wiederholungen, kein Polling nach Fehlern und keine parallelen Vinted-Browserfenster.
- Der normale Smoke-Test liest genau das Profil. `--full` ist nur für eine bewusste zusätzliche Prüfung eigener Artikel und Inbox.
- Eine fehlende oder nicht eindeutig erkannte UI-Liste niemals als „leer“ ausgeben.
- Gefüllte Vinted-Verläufe werden noch nicht gelesen und Nachrichten nicht gesendet, solange ein echter harmloser Verlauf samt Composer nicht eindeutig belegt ist.
