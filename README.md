# nemoclaw-kleinanzeigen

A German-language selling assistant for Kleinanzeigen. It analyzes and selects item photos, makes only targeted non-generative corrections, researches comparable offers, proposes an honest listing, monitors conversations and listing lifecycles, and manages a local inventory. OpenRouter provides the model; Telegram is the normal remote interface, while a local console makes testing cheap and predictable.

## What is safe by construction

- The default `NEMOCLAW_MODE=dry-run` blocks every external write.
- Listings, drafts, messages, and deletions are staged as an exact payload with a short action ID.
- A standalone `Go` can execute only the currently staged payload, once, within 30 minutes.
- Any intervening user message invalidates the old approval.
- Images are not uploaded while preparing a proposal. Upload and publication happen together only after approval.
- Original photos are immutable. Edited derivatives store source/output hashes and exact operations; no generative retouching is available.
- Every saved draft or published listing stores a canonical relist payload plus ordered image provenance.
- Automatic inbox and listing checks cannot delete or replace an action already waiting for `Go`.
- A listing must be absent from two consecutive successful own-ad reads before a lifecycle alert. The bot may propose the stored relist, but can never publish it automatically.
- Sold assets and assets with an already-active listing are blocked from duplicate publication.
- A failed external write is never retried automatically after an ambiguous network failure.
- Kleinanzeigen messages and search results are treated as untrusted data, not agent instructions.
- Telegram accepts only configured owner chat IDs.
- OpenRouter spend is capped locally per day (`$1` by default) and cumulatively for this app (`$3` by default). Before each call, its maximum configured output is reserved against those caps; concurrent calls share the same ledger lock, and ambiguous post-send failures reserve their projected cost.
- Secrets, browser state, sessions, pending actions, images, usage records, and the SQLite database are ignored by Git.

## Requirements

- Node.js 20+
- An OpenRouter API key
- Google Chrome/Chromium for the one-time Kleinanzeigen login
- A stable connection on which Kleinanzeigen permits normal browser access (no blocked VPN, proxy, corporate/hosting range, or Private Relay)
- For Telegram operation: a BotFather token and your numeric Telegram chat ID

The default model is `google/gemini-3.6-flash` with medium reasoning. A conservative router can escalate a clearly complex turn to `moonshotai/kimi-k3`; normal listing, search, inbox, and inventory work remains on Flash. Kimi has its own daily cap in addition to the global cap, and is not needed for the smoke tests.

## Setup

```bash
npm run setup
```

Edit `.env`:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-3.6-flash
OPENROUTER_REASONING_EFFORT=medium
OPENROUTER_DAILY_BUDGET_USD=1.00
OPENROUTER_TOTAL_BUDGET_USD=3.00

NEMOCLAW_COMPLEXITY_ROUTING=auto
OPENROUTER_HIGH_MODEL=moonshotai/kimi-k3
OPENROUTER_HIGH_DAILY_BUDGET_USD=0.25

# Start safe. Change to live only after the smoke tests pass.
NEMOCLAW_MODE=dry-run

TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=123456789
NEMOCLAW_INBOX_POLL_MINUTES=45
NEMOCLAW_LISTING_POLL_MINUTES=360

KA_DEFAULT_ZIP_CODE=00000
# KA_DEFAULT_LOCATION_ID=
# KA_CONTACT_NAME=
```

Then:

```bash
npm run doctor
npm run smoke:openrouter
npm run login
npm run smoke:ka
```

`npm run login` opens a native, non-automated Chrome app window with a dedicated persistent profile and navigates to the listing flow. Log in manually and complete any CAPTCHA or 2FA yourself. Once the create-listing page is visible, do not submit anything; press Enter in the terminal. The script gracefully stops only the Chrome process it launched, reopens the closed profile locally without navigating, validates `user_id` and CSRF, and stores the resulting Kleinanzeigen cookie string in the ignored `.env`. This keeps credentials and challenge handling outside browser automation.

This dedicated profile is required for the standalone bot. A signed-in Codex in-app browser is useful for read-only UI verification, but its private cookies are intentionally not copied into the Node process. If Kleinanzeigen reports a blocked IP range, stop retrying. Disable VPN/proxy/iCloud Private Relay and retry later from a normal, stable home or mobile connection. The login helper detects common `403`, `429`, IP-range, and unusual-traffic blocks and exits without an automatic retry.

`npm run login:automated` preserves the older Playwright-driven flow as a diagnostic fallback. It is not the default because Kleinanzeigen may classify browser automation more aggressively than an ordinary native login.

If Chrome remained active in the background after its last window was closed, close that dedicated process and run `npm run login:import`. The import reads the completed dedicated profile without navigating to Kleinanzeigen.

If Kleinanzeigen blocks only the isolated Chrome profile while a normal Chrome profile is already signed in, use the explicit macOS bootstrap fallback:

1. Open DevTools in the signed-in Chrome tab and select **Network**.
2. Open/reload “Meine Anzeigen” and select `m-meine-anzeigen-verwalten.json`.
3. Choose **Copy → Copy as cURL (bash)**.
4. Run `npm run login:clipboard`.
5. Copy any harmless text afterwards to replace the sensitive clipboard contents.

The command reads the clipboard only when invoked, never prints its contents, extracts the Cookie header without executing the cURL command, validates `user_id` and `CSRF-TOKEN`, and writes the same ignored `KA_COOKIES` value used by the native-profile flow. This is a bootstrap method, not a separate runtime.

The minimum configuration for local operation is:

1. `OPENROUTER_API_KEY` and the existing low-cost model/budget defaults.
2. A valid `KA_COOKIES` session created by one successful `npm run login`.
3. `NEMOCLAW_MODE=dry-run` until the read-only and agent smoke tests pass.

Telegram is optional: `npm run chat` works without a bot token or chat ID. Set the two Telegram values only when remote operation is wanted.

Codex and its in-app browser are development aids only. They are not runtime dependencies. The production Mac needs Node.js, this repository, Chrome, the OpenRouter key, and its own successful one-time dedicated-profile login.

Before unattended Telegram operation, also set a real `KA_DEFAULT_ZIP_CODE`, `KA_DEFAULT_LOCATION_ID`, and `KA_CONTACT_NAME`, then run `npm run doctor:telegram`. `npm run launch` runs that strict startup check itself and refuses to start when Telegram configuration is incomplete.

## Target Mac cutover

Use this order on the Mac that will actually run the bot:

```bash
git clone <repository-url>
cd nemoclaw-kleinanzeigen
npm run setup
# Fill .env: OpenRouter, Telegram owner/token, listing defaults; keep dry-run.
npm run login
npm run verify
npm run verify:account
npm run doctor:telegram
```

Then exercise one Telegram photo album in `NEMOCLAW_MODE=dry-run`; the full proposal should appear and `Go` must remain blocked. Only after that succeeds, set `NEMOCLAW_MODE=live` and start:

```bash
npm run launch
```

`npm run launch` is deliberately a foreground process. Inbox and listing checks run only while that process is alive and the Mac is awake with working network access. Keep the terminal/process running or place this same command under the Mac's normal user-level process supervisor after the interactive dry-run has passed. The bot does not need Codex at runtime.

If moving an already-running installation, stop the old process first and copy `.env`, `workspace/ads.db` (including any current WAL/SHM files) and `workspace/images` together. Never run two instances against the same Telegram bot and inventory at once.

## Test locally before Telegram

```bash
npm run chat
```

Useful prompts:

```text
/status
Suche nach gebrauchten ThinkPad T14 und empfehle einen Preis.
Zeige mein lokales Inventar.
/high Analysiere diese Sammlung mehrerer Artikel und plane die Reihenfolge.
/fast Formuliere diesen Titel kürzer.
```

Photo flow in the local console can be tested by passing a normal Telegram-style token:

```text
/compose
[FOTO path:/absolute/path/inside/workspace/images/raw/item.jpg]
Das Gerät funktioniert, hat aber einen Kratzer links.
/send
```

In dry-run mode the agent can research and stage a complete listing, but `Go` remains blocked.

For a repeatable paid-but-low-cost end-to-end model smoke test:

```bash
npm run smoke:agent -- --image /absolute/path/to/item.jpg \
  --context "Dry-run test facts about condition and age."
```

This command forces Flash/manual routing and dry-run, requires current public price research plus a valid staged listing, then clears the test action. It never publishes or saves a draft.

### Complexity routing

- `auto` (default) stays on Flash unless visible task complexity crosses a deterministic threshold, such as a multi-item workflow with several photos and compound analysis.
- `/high <Aufgabe>` selects the configured high model for one turn.
- `/fast <Aufgabe>` forces Flash for one turn.
- `manual` disables automatic escalation but keeps `/high`; `off` disables the high tier.
- Heartbeat/inbox work is always kept on Flash so a buyer message cannot trigger an expensive model.
- The high tier uses the same OpenRouter key. A separate Moonshot or Together key is unnecessary unless a future direct-provider adapter is desired.

## Start Telegram operation

After `npm run doctor`, `npm run smoke:openrouter`, and the read-only account checks succeed:

```dotenv
NEMOCLAW_MODE=live
```

Then:

```bash
npm run launch
```

The bot supports:

- `/status` — mode, model, Kleinanzeigen session, pending action, spend
- `/budget` — today’s OpenRouter usage
- `/cancel` — invalidate the pending action
- `/help` — short usage guide

Send one or more photos as a Telegram album plus a caption. The bot visually analyzes up to 20 photos in batches of at most 12, removes weak/duplicate choices, selectively edits only images with a concrete issue, sends each edited derivative back as a preview, researches the market, and shows the final text and exact ordered photo selection. It cannot stage the final listing before every album photo has been visually supplied to the model. Reply only `Go` if that exact action should happen.

If an album clearly contains different products and it is unclear whether they are a set or separate listings, the agent asks that one decision before researching or staging anything.

When a tracked active listing disappears, the lifecycle monitor waits for a second successful check, verifies the account bundles when possible, and then shows the stored title, text, price and photo set as a relist proposal. Explicit expired/removed states can produce the same guarded proposal immediately. A paused listing is different: the bot recommends reactivating the existing listing and deterministically blocks creation of a duplicate until that paused listing is removed or active again. Manual title or price changes made on Kleinanzeigen are detected and copied back into the local canonical record. No lifecycle event bypasses the normal approval gate.

For buyer messages, each changed unread conversation gets its own serialized agent turn. The bridge reads that full thread exactly once, attaches the matching local asset/listing bundle when the ad is tracked, and exposes only reply/Memory tools for that automatic turn. The model quotes the latest inbound text, identifies the intent, and proposes an exact reply without wandering through account APIs. Only a successfully delivered notification is marked as seen; other conversations and failed notifications remain eligible for the next check. It does not invent price floors, shipping availability, addresses or appointments. Payment links, verification codes, courier/overpayment patterns and conflict/legal messages are handed off instead of autonomously negotiated.

For an active but weak listing, ask the bot to analyze the asset. It reads the retained view/price timeline, checks the last successful observation, researches current comparables, and suggests the smallest useful title/photo/text/price experiment. It does not interpret a short history as a trend or auto-cut the price.

## Commands

| Command | Purpose |
|---|---|
| `npm run doctor` | Secret-safe local configuration diagnosis |
| `npm run doctor:telegram` | Strict production check including Telegram credentials |
| `npm run smoke:openrouter` | One inexpensive live model/tool-calling check |
| `npm run smoke:ka` | Read-only public + authenticated Kleinanzeigen API checks |
| `npm run smoke:agent -- --image …` | Flash vision → research → staged-listing dry-run |
| `npm run smoke:workflows` | Synthetic Flash inbox, scam, negotiation and stale-listing behavior; all external writes dry-run |
| `npm run test:scenarios` | Offline album → edit → listing, relist, inbox, restart and idempotency scenarios |
| `npm run verify` | Free offline regression, syntax, and configuration gate |
| `npm run verify:account` | `verify` plus all read-only Kleinanzeigen account checks |
| `npm run chat` | Interactive local agent |
| `npm run login` | Native manual login, then local session import |
| `npm run login:clipboard` | macOS fallback: import an authenticated Copy-as-cURL request |
| `npm run login:import-file -- /path/request.txt` | Import an authenticated Copy-as-cURL text file |
| `npm run login:import` | Retry only the local import from the closed dedicated profile |
| `npm run login:inspect` | Show only saved Kleinanzeigen cookie names/domains |
| `npm run login:automated` | Explicit Playwright-driven login fallback |
| `npm run refresh-auth` | Refresh cookies from the saved profile |
| `npm run launch` / `npm start` | Strict preflight, optional OpenShell policy, then Telegram bot |
| `npm test` | Offline regression suite |
| `npm run check` | Syntax checks |

`npm run smoke:ka` distinguishes a broken system DNS, a Kleinanzeigen network/IP block, an expired session, and a plain timeout. In particular, a browser may still work through Secure DNS while Node cannot resolve the host; that is not a reason to repeat the account login.

The legacy scripts `scripts/test-post.js` and `scripts/test-draft-images.js` mutate the real account and are intentionally excluded from `npm test`. They now require both live mode and a conspicuous command-line opt-in flag. Prefer the bot’s exact-action flow.

## Runtime layout

```text
tools/
  openrouter.js       OpenRouter client, retries, usage ledger, daily cap
  kleinanzeigen.js    Kleinanzeigen web/gateway client
  telegram.js         Telegram transport and long polling
  auth.js             Dedicated Playwright login profile
  image.js            Immutable originals, bounded edits and provenance
  adstore.js          Guarded SQLite inventory and listing reconciliation
workspace/
  agent.js            tools, approval contract, orchestration, heartbeat
  cli.js              local interactive transport
  agent.md            agent identity and hard rules
  skills/             concise task playbooks
```

## Operational notes

- The inbox monitor checks once 10 seconds after startup, then every configured interval with ±20% jitter (45 minutes by default). `0` disables it.
- It performs one deterministic full-thread read and calls the model only when an unread conversation is new or changed. Each conversation is processed separately with its exact tracked asset bundle when available. A conversation is marked as seen only after its notification succeeds, so temporary model or network failures are retried on the next check.
- The listing monitor checks once 30 seconds after startup, then every configured interval with ±15% jitter (six hours by default). `0` disables it. Network/API errors do not count as a missing listing.
- A lifecycle alert is deduplicated; if the listing reappears, its missing counter and alert state reset. View/price snapshots remain available for later listing analysis.
- Telegram media groups are processed as one item so the model sees the whole photo set together.
- Photo and listing records are durable local state under `workspace/images` and `workspace/ads.db`. Existing databases are migrated in place on first use. Back them up before moving versions, and copy these ignored paths together with `.env` when intentionally migrating the running instance; do not commit them.
- OpenRouter receives the current task text and attached selling photos. It never receives Telegram tokens, Kleinanzeigen cookies, or login credentials.
- The model can read inventory through narrow tools. It cannot self-edit code or skill files.
- Private Kleinanzeigen endpoints are unofficial and may change. Run the read-only smoke checks after login and after any site change before enabling live mode.

The acceptance scenarios and adjacent-use-case decisions for the current production goal are recorded in [GOAL_SESSION.md](./GOAL_SESSION.md).
