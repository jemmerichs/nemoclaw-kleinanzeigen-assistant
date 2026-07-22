# nemoclaw-kleinanzeigen

A German-language Kleinanzeigen assistant controlled through a private Telegram bot. It can research prices, prepare listing drafts and photos, track inventory in SQLite, inspect conversations, and—after an explicit `Go`—publish a listing or send a reply.

## Safety model

The runtime enforces the important boundaries in code:

- Only chat IDs in `TELEGRAM_ALLOWED_CHAT_ID(S)` are accepted.
- Publishing, sending messages, deleting drafts, and changing skill files require the owner's current message to be a standalone `Go`.
- One `Go` authorizes at most one protected action.
- The Claude subprocess does not receive Telegram, Kleinanzeigen, password, or Gemini secrets.
- Agent-controlled SQL is limited to one `SELECT`, `WITH`, `INSERT`, or `UPDATE` statement.
- Memory and image tools are confined to their configured directories.

Saving a non-public Kleinanzeigen draft remains intentionally allowed without `Go`.

## Requirements

- Node.js 20 or newer
- The authenticated `claude` CLI in `PATH`, or `CLAUDE_BIN` in `.env`
- A Telegram bot token and your numeric Telegram chat ID
- Google Chrome/Chromium for the one-time Kleinanzeigen login

## Setup

```bash
npm run setup
```

Edit the generated `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=123456789
```

Then create the persistent Kleinanzeigen browser session and start the bot:

```bash
npm run login
npm start
```

`npm run launch` does the same start through `scripts/start.sh` and applies the OpenShell network policy when OpenShell is installed.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Start the Telegram agent |
| `npm run login` | Open the browser for Kleinanzeigen login/2FA |
| `npm run refresh-auth` | Refresh cookies from the saved browser profile |
| `npm test` | Run the offline regression suite (no live API calls) |
| `npm run check` | Syntax-check the main runtime files |

The scripts named `test-post.js` and `test-draft-images.js` are manual live smoke tests. They mutate the real Kleinanzeigen account and are never run by `npm test`.

## Runtime structure

```text
tools/
  kleinanzeigen.js  Kleinanzeigen HTTP client
  telegram.js       Telegram transport and long polling
  auth.js           Playwright login and cookie refresh
  image.js          persistent images and optional Gemini processing
  adstore.js        guarded SQLite inventory store
workspace/
  agent.js           orchestration, permissions, retry, persistence
  runtime.js         pure runtime helpers
  agent.md           agent identity and rules
  skills/            task playbooks loaded into the agent context
```

Session history and the last Telegram update offset are stored atomically in ignored local files. Images and the browser profile also stay local.

## Operational notes

- The bot continues to start without `KA_COOKIES` so it can report setup errors through Telegram; Kleinanzeigen tools remain unavailable until `npm run login` succeeds.
- Telegram uses sequential long polling, exponential reconnect backoff, message chunking, and persistent update offsets.
- Kleinanzeigen and Telegram requests have timeouts and reject malformed or non-success responses instead of silently returning empty data.
- Scheduled inbox checks run every three to six hours and share the same per-chat queue as user messages.
