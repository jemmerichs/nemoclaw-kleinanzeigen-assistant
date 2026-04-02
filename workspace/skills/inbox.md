# Skill: Inbox

Neue Nachrichten aus dem Kleinanzeigen-Postfach abrufen und an Jannik weiterleiten.

**Wann:** Jannik fragt nach Nachrichten, oder Heartbeat-Trigger.

**Ablauf:**
1. `ka_get_conversations` — ungelesene Konversationen finden
2. Für jede ungelesene: `ka_get_messages` aufrufen
3. Rohe Nachricht an Jannik: Absender, Anzeigentitel, Nachrichtentext — keine Zusammenfassung
4. Auf "Go" oder "Skip" warten
5. "Go" → Jannik nach Antworttext fragen → `ka_send_message`
6. "Skip" → nächste Nachricht
