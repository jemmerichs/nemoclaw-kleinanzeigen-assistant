# Skill: Meine Anzeigen

Jannik's aktive Anzeigen anzeigen und verwalten.

**Wann:** Jannik fragt nach seinen Anzeigen.

**Ablauf:**
1. `getMyAds` aufrufen
2. Liste ausgeben: Titel, Preis, Aufrufe, Status

**Hard skills in Entwicklung:** `deleteAd`, `setAdStatus` (pausieren/reaktivieren)

## DB-Sync

Nach `getMyAds` abgleichen wenn DB-Einträge mit `status='active'` vorhanden sind:

```
db({ sql: "SELECT id, ka_id FROM ads WHERE status='active'" })
```

ka_ids die im Live-Ergebnis fehlen → abgelaufen:
```
db({ sql: "UPDATE ads SET status='expired', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ka_id=?",
     params: [kaId] })
```
