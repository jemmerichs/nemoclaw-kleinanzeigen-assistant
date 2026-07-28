# Skill: Inbox

Neue Nachrichten aus dem Kleinanzeigen-Postfach abrufen und an Jannik weiterleiten.

**Wann:** Jannik fragt nach Nachrichten, oder Heartbeat-Trigger.

**Ablauf:**
1. `ka_get_conversations` — ungelesene Konversationen finden
2. Für jede ungelesene: `ka_get_messages` aufrufen
3. Rohe Nachricht an Jannik: Absender, Anzeigentitel, Nachrichtentext — keine Zusammenfassung
4. Exakten Antworttext vorschlagen und `ka_send_message` aufrufen; die Bridge merkt Empfänger und Wortlaut unveränderlich vor
5. Die Bridge verarbeitet ein direkt folgendes eigenständiges "Go" und sendet genau diese vorgemerkte Antwort
6. "Skip" → nächste Nachricht
