# Skill: Asset-Datenbank verwalten

Lokale Datenbank abfragen und pflegen.

**Wann:** Jannik fragt nach seinen Sachen, möchte etwas eintragen, als verkauft markieren, oder Infos ergänzen.

---

## Schema

| Tabelle | Zweck |
|---|---|
| `assets` | Physische Gegenstände die Jannik besitzt/vermietet |
| `ka_listings` | KA-Inserat-Versuche pro Asset (1 Asset → viele Listings) |
| `ka_snapshots` | Preis- und Aufrufe-Verlauf pro Listing |

### assets
`id`, `name` (NOT NULL, interner Name), `listing_name` (Titel der KA-Anzeige), `description`, `category_id`, `last_price_cents` (letzter bekannter Preis, ÷100=€), `has_active_listing` (0|1), `status` (`available`|`sold`), `sold_at`, `sold_price_cents`, `created_at`, `updated_at`

### ka_listings
`id`, `asset_id` → assets(id), `ka_id` (KA-Anzeigen-ID, UNIQUE, NULL wenn manuell), `ka_link`, `price_cents`, `status` (`active`|`expired`|`removed`|`draft`), `posted_at`, `expired_at`, `created_at`

### ka_snapshots
`id`, `listing_id` → ka_listings(id), `price_cents`, `views`, `recorded_at`

⚠️ **Kein DELETE** — stattdessen `status` aktualisieren.

---

## Asset eintragen (ohne aktives KA-Inserat)

```
db_query({ sql: "INSERT INTO assets (name, listing_name, description, last_price_cents) VALUES (?,?,?,?)",
           params: ["Klettersteigset", "Klettersteigset zu vermieten", "Beschreibung...", 5000] })
```

## Asset + KA-Listing eintragen

```
db_query({ sql: "INSERT INTO assets (name, listing_name, description, last_price_cents, has_active_listing) VALUES (?,?,?,?,1)",
           params: ["Fahrrad", "Fahrrad 28 Zoll", "...", 15000] })
// lastInsertRowid = asset_id
db_query({ sql: "INSERT INTO ka_listings (asset_id, ka_id, ka_link, price_cents, status, posted_at) VALUES (?,?,?,?,?,?)",
           params: [assetId, "ka123", "https://...", 15000, "active", "2024-01-01T00:00:00Z"] })
```

## Typische Abfragen

```sql
-- Alle verfügbaren Assets
SELECT id, name, listing_name, last_price_cents/100.0 AS eur, has_active_listing FROM assets WHERE status='available'

-- Asset mit aktiven KA-Listings
SELECT a.name, l.ka_id, l.ka_link, l.price_cents/100.0 AS eur
FROM assets a JOIN ka_listings l ON l.asset_id=a.id
WHERE l.status='active'

-- Preis-/Aufrufe-Verlauf
SELECT s.recorded_at, s.price_cents/100.0 AS eur, s.views
FROM ka_snapshots s WHERE s.listing_id=?
ORDER BY s.recorded_at
```

## Als verkauft markieren

```
db_query({ sql: "UPDATE assets SET status='sold', has_active_listing=0, sold_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), sold_price_cents=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
           params: [soldPriceCents, assetId] })
db_query({ sql: "UPDATE ka_listings SET status='removed' WHERE asset_id=? AND status='active'",
           params: [assetId] })
```

## Snapshot schreiben

Nach jedem KA-Datenabruf und nach jeder Preisänderung:
```
db_query({ sql: "INSERT INTO ka_snapshots (listing_id, price_cents, views) VALUES (?,?,?)",
           params: [listingId, priceCents, views] })
// Auch last_price_cents im Asset aktualisieren:
db_query({ sql: "UPDATE assets SET last_price_cents=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
           params: [priceCents, assetId] })
```
