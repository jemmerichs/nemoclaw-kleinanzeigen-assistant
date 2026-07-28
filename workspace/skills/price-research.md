# Skill: Preisrecherche

Marktpreise für einen Artikel auf Kleinanzeigen recherchieren.

**Wann:** Jannik fragt nach einem Preis, oder während Anzeige-Erstellung.

**Ablauf:**
1. Artikel aus Foto/Caption bestimmen; nur bei entscheidender Unklarheit nachfragen
2. `ka_search_ads` aufrufen mit passendem keyword + categoryId
3. Vergleichbare Treffer zählen, numerische Preise extrahieren und offensichtlich defekte, gesuchte, verschenkte oder unpassende Artikel ausschließen
4. Bereinigte Spanne, Stichprobengröße und Median nennen
5. Immer genau einen konkreten Angebotspreis ausgeben, zum Beispiel `Empfohlener Angebotspreis: 299 € VB`. Eine Spanne allein ist keine Empfehlung.
6. Top-Anzeigen (topAd: true) separat kennzeichnen — die sind bezahlt und verzerren ggf. den Preis
7. Für eine Veröffentlichung nur eine Kategorie-ID verwenden, die aus aktuellen Suchergebnissen oder einer verifizierten Kategorienavigation folgt

**Hinweise:**
- categorySlug und categoryId zusammen angeben, wenn beide sicher bekannt sind
- Ohne categoryId sucht das Tool quer durch alle Kategorien
- Preis kommt als String ("2.200 € VB") — VB = Verhandlungsbasis, muss beim Vergleich beachtet werden
