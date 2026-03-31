# Skill: Anzeigen-Store verwalten

Lokale Anzeigendatenbank abfragen und pflegen.

**Wann:** Jannik fragt nach abgelaufenen Anzeigen, Preisverlauf, möchte eine als verkauft markieren oder Infos ergänzen.

---

## Schema

| Tabelle | Zweck |
|---|---|
| `ads` | Alle Anzeigen, auch abgelaufene und verkaufte |
| `price_history` | Preisverlauf (eine Zeile pro Änderung) |
| `market_research` | Recherche-Ergebnisse zu Preisen |

**Wichtige Spalten in `ads`:** `id`, `ka_id`, `title`, `status` (draft/active/paused/expired/sold), `price_cents` (÷100 = €), `facts` (JSON-String), `ka_link`, `sold_at`, `sold_price_cents`

⚠️ **Kein DELETE verwenden** — immer `UPDATE ... SET status='deleted'` für soft-delete.

---

## Typische Abfragen

```sql
-- Aktive Anzeigen
SELECT id, title, price_cents/100.0 AS eur, ka_link FROM ads WHERE status='active'

-- Abgelaufene
SELECT id, title, price_cents/100.0 AS eur, updated_at FROM ads WHERE status='expired' ORDER BY updated_at DESC

-- Preisverlauf
SELECT ph.changed_at, ph.price_cents/100.0 AS eur, ph.note
FROM price_history ph JOIN ads a ON a.id=ph.ad_id WHERE a.ka_id=?
ORDER BY ph.changed_at
```

## Als verkauft markieren

```
db({ sql: "UPDATE ads SET status='sold', sold_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), sold_price_cents=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ka_id=?",
     params: [soldPriceCents, kaId] })
```

## Facts aktualisieren

facts ist freies JSON. Lesen → mergen → schreiben:
```
db({ sql: "SELECT id, facts FROM ads WHERE title LIKE ?", params: ["%stichwort%"] })
// facts parsen, Felder ergänzen, dann:
db({ sql: "UPDATE ads SET facts=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
     params: [JSON.stringify(updatedFacts), id] })
```

## Marktrecherche speichern

Nach `searchAds` optional persistieren (besonders wenn eine Anzeige dazu existiert):
```
db({ sql: "INSERT INTO market_research (query, category_id, median_cents, recommended_cents, ad_id) VALUES (?,?,?,?,?)",
     params: [keyword, categoryId, medianCents, recommendedCents, localAdId] })
```
`ad_id` = null bei eigenständiger Recherche ohne zugehörige Anzeige.
