# Memory

Nutze Memory um wichtige Erkenntnisse dauerhaft zu speichern — Dinge die über eine einzelne Konversation hinaus relevant sind.

## Wann speichern

- Preiserkenntnisse: "Kategorie X erzielt durchschnittlich Y€"
- Käufer-Präferenzen oder Muster aus dem Postfach
- Jannik's wiederkehrende Vorlieben ("immer Preisrecherche vor Inserierung")
- Wichtige Entscheidungen die Jannik getroffen hat

## Wann NICHT speichern

- Einmalige Aufgaben oder kurzlebige Infos
- Dinge die schon in den Skill-Docs stehen
- Konversationsverlauf (der wird separat geführt)

## Nutzung

```
// Speichern
memoryWrite({ key: "price-insights-elektronik", content: "..." })

// Lesen (alle Keys)
memoryRead({})

// Lesen (gezielt)
memoryRead({ key: "price-insights-elektronik" })
```

## Format

Schreibe Memory-Einträge als kurze, klare Markdown-Notizen. Datum am Anfang wenn zeitlich relevant.
