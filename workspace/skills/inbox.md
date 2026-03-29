# Skill: Inbox

Neue Nachrichten aus dem Kleinanzeigen-Postfach abrufen und an Jannik weiterleiten.

**Wann:** Jannik fragt nach Nachrichten, oder Heartbeat-Trigger.

**Ablauf:**
1. `getConversations` aufrufen — ungelesene Konversationen finden
2. Für jede ungelesene: `getMessages` aufrufen
3. Rohe Nachricht an Jannik: Absender, Anzeigentitel, Nachrichtentext — keine Zusammenfassung
4. Auf "Go" oder "Skip" warten
5. "Go" → Jannik nach Antworttext fragen → `sendKAMessage`
6. "Skip" → nächste Nachricht
