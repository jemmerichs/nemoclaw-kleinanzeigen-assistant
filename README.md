# nemoclaw-kleinanzeigen

A German-language selling assistant for Kleinanzeigen and Vinted. It analyzes and selects item photos, makes only targeted non-generative corrections, researches comparable offers, proposes honest marketplace-specific listings, and manages one shared local inventory. OpenRouter provides the model; Telegram is the normal remote interface, while a local console makes testing cheap and predictable.

## What is safe by construction

- The default `NEMOCLAW_MODE=dry-run` blocks every external write.
- Listings, drafts, messages, and deletions are staged as an exact payload with a short action ID.
- A standalone `Go` can execute only the currently staged payload, once, within 30 minutes.
- Any intervening user message invalidates the old approval.
- Images are not uploaded while preparing a proposal. Upload and publication happen together only after approval.
- Kleinanzeigen category contracts are discovered generically from the current signed-in posting form and cached for 14 days. Unknown categories are navigated read-only via their visible category path; exact required fields and permitted values are then validated before approval and upload. A new server-side form validation error is surfaced as repairable schema feedback, never as a claimed publication.
- Original photos are immutable. Edited derivatives store source/output hashes and exact operations; no generative retouching is available.
- Every saved draft or published listing stores a canonical relist payload plus ordered image provenance.
- Automatic inbox and listing checks cannot delete or replace an action already waiting for `Go`.
- A listing must be absent from two consecutive successful own-ad reads before a lifecycle alert. The bot may propose the stored relist, but can never publish it automatically.
- Sold assets are blocked from publication. One physical asset may be cross-posted once on each marketplace, but a second active listing on the same marketplace is blocked.
- A failed external write is never retried automatically after an ambiguous network failure.
- Marketplace messages and search results are treated as untrusted data, not agent instructions.
- Telegram accepts only configured owner chat IDs.
- Telegram replies use compact plain text; Markdown headings, separator rules, code fences, and backticks are removed before delivery.
- OpenRouter spend is capped locally per day (`$1` by default) and cumulatively for this app (`$3` by default). Before each call, its maximum configured output is reserved against those caps; concurrent calls share the same ledger lock, and ambiguous post-send failures reserve their projected cost.
- Model history is limited to the latest 7 entries from the last 24 hours, with a 4,000-character total cap and 1,500 characters per entry, independently from durable inventory and pending approvals. Raw tool results stay only in the current turn instead of displacing conversation messages. Routine turns load only the skills and tools needed for Kleinanzeigen research and posting; inbox, management, and Vinted context is added only when the request needs it, while ambiguous requests retain the full tool set. Normal output is capped at 1,536 tokens with minimal reasoning so a complete listing payload still fits. Legacy history entries without timestamps expire during migration. An output-limit response is discarded and retried exactly once with minimal reasoning and a compact response contract; provider JSON is never dumped into chat.
- Secrets, browser state, sessions, pending actions, images, usage records, and the SQLite database are ignored by Git.

## Requirements

- Node.js 20+
- An OpenRouter API key
- Google Chrome/Chromium and a separate one-time login profile for each marketplace
- A stable connection on which the marketplaces permit normal browser access (no blocked VPN, proxy, corporate/hosting range, or Private Relay)
- For Telegram operation: a BotFather token and your numeric Telegram chat ID

The default model is `google/gemini-3.6-flash` with medium reasoning. Automatic high-tier routing is disabled by default so all normal work stays on Flash; `/high` is unavailable while routing is `off`. If explicitly enabled later, the optional Kimi tier has its own daily cap in addition to the global cap and is not needed for smoke tests.

## Setup

```bash
npm run setup
```

Edit `.env`:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-3.6-flash
OPENROUTER_REASONING_EFFORT=minimal
OPENROUTER_MAX_TOKENS=1536
OPENROUTER_DAILY_BUDGET_USD=1.00
OPENROUTER_TOTAL_BUDGET_USD=3.00

NEMOCLAW_COMPLEXITY_ROUTING=off
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
npm run login:vinted
npm run smoke:vinted
```

`npm run login` opens a native Chrome window with a dedicated persistent profile and navigates to the current listing flow. Log in manually and complete any CAPTCHA or 2FA yourself; do not submit a listing. The script observes only that dedicated local Chrome process, waits until `user_id`/Bearer identity and CSRF are genuinely present, stores the resulting cookie string plus matching Chrome request identity in the ignored `.env`, and then closes the window automatically. It does not rely on an ENTER prompt or reopen the profile headlessly after login. Keeping the request identity aligned matters because Kleinanzeigen's session-protection cookies can reject a request whose browser version does not match the login.

Kleinanzeigen access tokens are short-lived. The runtime checks their embedded expiry locally and renews them before private requests through the login service's published OIDC `refresh_token` flow. Rotated tokens are stored atomically in `.env`; no browser is opened for authentication refresh. As long as the refresh token remains valid, hourly or daily manual login is unnecessary. An already expired or revoked refresh token requires one new bootstrap login. The strict account doctor also rejects a saved request identity from a different Chrome major version; after a Chrome upgrade, re-import one current authenticated request instead of sending mismatched browser headers unattended.

This dedicated profile is required for the standalone bot. A signed-in Codex in-app browser is useful for read-only UI verification, but its private cookies are intentionally not copied into the Node process. If Kleinanzeigen reports a blocked IP range, stop retrying. Disable VPN/proxy/iCloud Private Relay and retry later from a normal, stable home or mobile connection. The login helper detects common `403`, `429`, IP-range, and unusual-traffic blocks and exits without an automatic retry.

Runtime form inspection never uses headless Chrome for Kleinanzeigen network access. An unknown category opens at most one visible window in the dedicated profile; consecutive path selections share that window for up to two minutes. Visible Chrome uses a reserved non-zero loopback debugging port, avoiding Chrome's special WebDriver marker for port `0` without modifying JavaScript, Canvas, WebGL, the user agent, or navigator properties. A browser rejection activates a 30-minute local circuit breaker instead of further automatic attempts. Common categories come from the short-lived verified cache and need no browser window.

`npm run login:vinted` opens a second, Vinted-only ordinary Chrome profile without DevTools attachment, polling, or scripted page interaction. Log in manually, complete any human check yourself, then close that dedicated window completely. Only after it exits does the helper open `about:blank`, import the profile's Vinted cookies into the ignored `.env`, and close again. Do not paste a raw Vinted token into chat or source files. `npm run smoke:vinted` then performs one read-only profile check in a visible browser; `--full` deliberately adds own-item and inbox reads.

Vinted runtime operations use current visible UI controls in that isolated profile, not guessed private endpoints. They fail closed on a challenge, login redirect, unknown field, ambiguous control, or unconfirmed write and do not retry automatically. The currently verified publishing path covers the laptop form and its observed package controls (IDs 8/9/10 for 5/10/20 kg). Other categories remain proposal/read-only work until their current required fields are sampled. The Vinted inbox empty-state can be checked; reading a populated thread, sending messages, and listing/deleting saved drafts are intentionally not exposed until harmless real UI examples can be verified.

`npm run login:automated` preserves the older Playwright-driven flow as a diagnostic fallback. It is not the default because Kleinanzeigen may classify browser automation more aggressively than an ordinary native login.

If Chrome remained active in the background after its last window was closed, close that dedicated process and run `npm run login:import`. The import reads the completed dedicated profile without navigating to Kleinanzeigen.

If Kleinanzeigen blocks only the isolated Chrome profile while a normal Chrome profile is already signed in, use the explicit macOS bootstrap fallback:

1. Open DevTools in the signed-in Chrome tab and select **Network**.
2. Open/reload “Meine Anzeigen” and select `m-meine-anzeigen-verwalten.json`.
3. Choose **Copy → Copy as cURL (bash)**.
4. Run `npm run login:clipboard`.
5. Copy any harmless text afterwards to replace the sensitive clipboard contents.

The command reads the clipboard only when invoked, never prints its contents, extracts the Cookie, User-Agent, and language headers without executing the cURL command, validates CSRF, identity, access token, and refresh token, and writes the same ignored session metadata used by the native-profile flow. This is a one-time bootstrap method, not a separate runtime. Run `npm run smoke:auth-refresh` immediately afterwards; a successful result proves that token rotation works before the background agent starts.

The minimum configuration for local operation is:

1. `OPENROUTER_API_KEY` and the existing low-cost model/budget defaults.
2. A valid `KA_COOKIES` session for Kleinanzeigen and/or a Vinted session created by `npm run login:vinted`, depending on which marketplace is used.
3. `NEMOCLAW_MODE=dry-run` until the read-only and agent smoke tests pass.

Telegram is optional: `npm run chat` works without a bot token or chat ID. Set the two Telegram values only when remote operation is wanted.

Codex and its in-app browser are development aids only. They are not runtime dependencies. The production Mac needs Node.js, this repository, Chrome, the OpenRouter key, and its own successful dedicated-profile login for each enabled marketplace.

Before unattended Telegram operation, also set a real `KA_DEFAULT_ZIP_CODE`, `KA_DEFAULT_LOCATION_ID`, and `KA_CONTACT_NAME`, then run `npm run doctor:account`. Routine `npm start` checks the runtime and Telegram configuration, but an unavailable marketplace session no longer prevents the bot itself from starting; affected account tools remain fail-closed.

`KA_DEFAULT_ZIP_CODE` and `KA_DEFAULT_LOCATION_ID` are one verified pair. The bridge always injects that configured pair into drafts and publications and ignores model-supplied alternatives, so the location is not re-decided for every listing. If Kleinanzeigen rejects the location, re-verify and update the pair itself instead of changing one listing payload.

For a bounded repair on the machine that actually runs the bot, follow [`docs/TARGET_MAC_LISTING_CONFIG_REPAIR.md`](docs/TARGET_MAC_LISTING_CONFIG_REPAIR.md). It includes a copyable prompt for a less capable target-Mac agent and avoids printing `.env` or session secrets.

The tracked `workspace/memory/preferences.md` is loaded automatically. It currently defaults Kleinanzeigen listings to the exact verified “Nur Abholung” option when a category exposes it; an explicit shipping request for the current listing still takes precedence.

## Target Mac cutover

The canonical, agent-readable deployment and migration procedure is [docs/TARGET_MAC_RUNBOOK.md](docs/TARGET_MAC_RUNBOOK.md). It includes the required manual browser handoff, forbidden session/profile transfers, dry-run acceptance gate, and service lifecycle.

The minimum Kleinanzeigen sequence on the Mac that will actually run the bot is:

```bash
git clone <repository-url>
cd nemoclaw-kleinanzeigen
npm run setup
# Fill .env: OpenRouter, Telegram owner/token, listing defaults; keep dry-run.
# In ordinary Chrome on this Mac, copy an authenticated "Meine Anzeigen" request as cURL.
npm run login:clipboard
npm run smoke:auth-refresh
npm run smoke:ka
npm run doctor:account
```

`npm run setup` includes `npm ci`. Do not continue after a failed command, and do not copy marketplace cookies, tokens, or browser profiles from another Mac. If Vinted is enabled, also run `npm run login:vinted` and `npm run smoke:vinted` before the dry-run acceptance test.

Then exercise one Telegram photo album in `NEMOCLAW_MODE=dry-run`; the full proposal should appear and `Go` must remain blocked. Only after that succeeds, set `NEMOCLAW_MODE=live` and start:

```bash
npm run launch
```

`npm run launch` is deliberately a foreground process and is best for the first live session. Inbox and listing checks run only while that process is alive and the Mac is awake with working network access.

After that foreground session is stable, install the included standard macOS user service:

```bash
npm run service:install
npm run service:status
npm run service:restart
```

The installer reruns the strict Telegram/account doctor, writes no secrets into the plist, embeds the current Node/project paths, starts the existing `scripts/start.sh`, and stores private logs under `workspace/logs`. It runs only in the signed-in macOS user session; the Mac must remain awake and online. A PID lock prevents a second bot process from using the same Telegram account and local state.

`scripts/start.sh` wraps the agent in `caffeinate -i -s`, so while the bot runs the Mac will not idle-sleep or system-sleep on AC power. This keeps the bot alive instead of stopping after a short idle timeout. The `caffeinate` process ends together with the agent, so it does not keep the Mac awake when the bot is stopped. Note that closing the lid or a manual sleep still suspends the Mac; for unattended 24/7 operation set Energy Saver to prevent sleep on AC power.

When running as a launchd service, a visible Terminal window opens directly showing the bot. Closing that window stops the bot. Run `npm run service:install` or `npm run service:restart` to start it again; `service:restart` refuses to open another window while the current agent is still running.

To stop automatic operation:

```bash
npm run service:uninstall
```

Uninstalling removes only the LaunchAgent definition. It preserves `.env`, the Chrome profile, inventory, images and logs. The bot does not need Codex at runtime.

If moving an already-running installation, stop the old process first and copy `workspace/ads.db` (including any current WAL/SHM files), `workspace/images`, and the non-marketplace configuration from `.env` together. Never copy `workspace/browser-profile` or `workspace/vinted-browser-profile`; Chrome protects those profiles with machine-local credentials. Bootstrap fresh marketplace sessions in Chrome on the destination Mac, then run the account smoke tests before installing its service. Never run two instances against the same Telegram bot and inventory at once.

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
  --require-fact "Kratzer" \
  --context "Dry-run test: used, functional, with a visible scratch on the left."
```

This command forces Flash/manual routing and dry-run, requires current public price research plus a valid staged listing, then clears the test action. Every repeated `--require-fact` value must occur in both the staged description and the exact Telegram-style proposal. The proposal is also checked for title, category, description, photo count, bound photo hashes and its unambiguous approval notice. It never publishes or saves a draft.

### Complexity routing

- `off` is the recommended low-budget default and prevents any expensive-model escalation.
- `auto` stays on Flash unless visible task complexity crosses a deterministic threshold, such as a multi-item workflow with several photos and compound analysis.
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

- `/status` — mode, model, both marketplace sessions, pending action, spend
- `/budget` — today’s OpenRouter usage
- `/context` — current context limits and the separation between transient model history and durable state
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
| `npm run doctor:telegram` | Startup check including Telegram credentials; marketplace sessions are diagnostic only |
| `npm run doctor:account` | Strict installation gate including Telegram and Kleinanzeigen account readiness |
| `npm run smoke:openrouter` | One inexpensive live model/tool-calling check |
| `npm run smoke:auth-refresh` | Refresh the dedicated Chrome session, persist it, then verify a private message read |
| `npm run smoke:ka` | Read-only public + authenticated Kleinanzeigen API checks |
| `npm run smoke:vinted` | One minimal read-only Vinted profile check (`--full` adds items and inbox) |
| `npm run smoke:agent -- --image …` | Flash vision → research → staged-listing dry-run |
| `npm run smoke:workflows` | Synthetic Flash inbox, scam, negotiation and stale-listing behavior; all external writes dry-run |
| `npm run test:journey` | One offline album → approval → persisted listing → relist → buyer-reply journey |
| `npm run test:scenarios` | Offline journey plus edit, lifecycle, inbox, restart and idempotency scenarios |
| `npm run verify` | Free offline regression, syntax, and configuration gate |
| `npm run verify:account` | `verify` plus read-only Kleinanzeigen and Vinted account checks |
| `npm run chat` | Interactive local agent |
| `npm run login` | Native manual login, then local session import |
| `npm run login:vinted` | Ordinary isolated Vinted login; import only after the window is closed |
| `npm run login:vinted:import` | Retry only the Vinted import from the closed profile |
| `npm run login:vinted:inspect` | Show only Vinted cookie names/domains |
| `npm run refresh-auth:vinted` | Re-import saved Vinted session metadata from `about:blank`; use the smoke test to validate |
| `npm run login:clipboard` | macOS fallback: import an authenticated Copy-as-cURL request |
| `npm run login:import-file -- /path/request.txt` | Import an authenticated Copy-as-cURL text file |
| `npm run login:import` | Retry only the local import from the closed dedicated profile |
| `npm run login:inspect` | Show only saved Kleinanzeigen cookie names/domains |
| `npm run login:automated` | Explicit Playwright-driven login fallback |
| `npm run refresh-auth` | Access-/Refresh-Token per OIDC erneuern und atomar speichern; kein Browserzugriff |
| `npm run launch` / `npm start` | Runtime/Telegram preflight, optional OpenShell policy, then Telegram bot |
| `npm run service:install` | Install/start the bot as a standard macOS user LaunchAgent |
| `npm run service:status` | Inspect the loaded LaunchAgent |
| `npm run service:restart` | Start the loaded LaunchAgent again after its visible bot Terminal has been closed |
| `npm run service:uninstall` | Stop/remove only the LaunchAgent; retain bot data |
| `npm test` | Offline regression suite |
| `npm run check` | Syntax checks |

`npm run smoke:ka` distinguishes a broken system DNS, a public Kleinanzeigen network/IP block, a rejected private browser session, an expired token, and a plain timeout. A private `403` while public search still succeeds is treated as a session/fingerprint problem, not mislabeled as a general IP block. In particular, a browser may still work through Secure DNS while Node cannot resolve the host; that is not a reason to repeat the account login.

The legacy scripts `scripts/test-post.js` and `scripts/test-draft-images.js` mutate the real account and are intentionally excluded from `npm test`. They now require both live mode and a conspicuous command-line opt-in flag. Prefer the bot’s exact-action flow.

## Runtime layout

```text
tools/
  openrouter.js       OpenRouter client, retries, usage ledger, daily cap
  kleinanzeigen.js    Kleinanzeigen web/gateway client
  vinted.js           Fail-closed Vinted browser/UI client
  vinted-auth.js      Isolated ordinary-Chrome login and session import
  telegram.js         Telegram transport and long polling
  auth.js             Dedicated native-Chrome login and profile refresh
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
- OpenRouter receives the current task text and attached selling photos. It never receives Telegram tokens, marketplace cookies, or login credentials.
- The model can read inventory through narrow tools. It cannot self-edit code or skill files.
- Kleinanzeigen private endpoints and the Vinted web UI may change. Run the corresponding minimal read-only smoke check after login and after a site change before enabling live mode.

The acceptance scenarios and adjacent-use-case decisions for the current production goal are recorded in [GOAL_SESSION.md](./GOAL_SESSION.md).
