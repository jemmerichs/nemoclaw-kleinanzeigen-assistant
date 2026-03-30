# Skill: Preisrecherche

Marktpreise für einen Artikel auf Kleinanzeigen recherchieren.

**Wann:** Jannik fragt nach einem Preis, oder während Anzeige-Erstellung.

**Ablauf:**
1. Artikelname und ggf. Kategorie erfragen falls nicht gegeben
2. `searchAds` aufrufen mit passendem keyword + categoryId
3. Preise der Ergebnisse analysieren — Spanne und Median nennen
4. Empfehlung geben: unter/über Markt oder passend
5. Top-Anzeigen (topAd: true) separat kennzeichnen — die sind bezahlt und verzerren ggf. den Preis

**Hinweise:**
- categorySlug und categoryId zusammen angeben für präzise Ergebnisse (z.B. categoryId: 217, categorySlug: "fahrraeder")
- Ohne categoryId sucht das Tool quer durch alle Kategorien
- Preis kommt als String ("2.200 € VB") — VB = Verhandlungsbasis, muss beim Vergleich beachtet werden
