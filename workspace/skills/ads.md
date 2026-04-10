# Skill: Anzeigen & Entwürfe

Jannik's aktive Anzeigen und Entwürfe anzeigen.

**Wann:** Jannik fragt nach seinen Anzeigen oder Entwürfen.

**Ablauf:**
- Aktive Anzeigen: `ka_get_my_ads` → Titel, Preis, Aufrufe, Status
- Alle inkl. pausierte: `ka_get_ad_bundles`
- Entwürfe: `ka_get_drafts` → Titel, Kategorie, Preis-Typ, Anzahl Fotos

Entwürfe haben ggf. leere Beschreibung und keine Fotos — darauf hinweisen.
Entwurf zur Bearbeitung ausgewählt → `create-post` Skill.

**Snapshots:** Nach jedem Abruf von KA-Anzeigendaten und nach jeder Preisänderung einen Eintrag in `ka_snapshots` schreiben (`listing_id`, `price_cents`, `views`).
