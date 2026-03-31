# Skill: Anzeigen & Entwürfe

Jannik's aktive Anzeigen und Entwürfe anzeigen.

**Wann:** Jannik fragt nach seinen Anzeigen oder Entwürfen.

**Ablauf:**
- Aktive Anzeigen: `getMyAds` → Titel, Preis, Aufrufe, Status
- Alle inkl. pausierte: `getAdBundles`
- Entwürfe: `getDrafts` → Titel, Kategorie, Preis-Typ, Anzahl Fotos

Entwürfe haben ggf. leere Beschreibung und keine Fotos — darauf hinweisen.
Entwurf zur Bearbeitung ausgewählt → `create-post` Skill.

**Hard skills in Entwicklung:** `deleteAd`, `setAdStatus` (pausieren/reaktivieren)
