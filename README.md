# NemoClaw for Kleinanzeigen

**Retired side project · March–August 2026 · unofficial and unaffiliated**

A personal assistant I built to sell used items on Kleinanzeigen and Vinted. I could send photos through Telegram, review a proposed listing, and approve the exact action before anything was published or sent.

I built this to handle the repetitive parts of selling: selecting photos, checking comparable prices, writing listings, keeping inventory, and following up on buyer messages. It grew into a standalone Node.js agent with an OpenRouter model, browser integrations, and a local SQLite database.

I retired the standalone bot in favor of a Codex skill. Maintaining a separate agent runtime, Telegram transport, browser sessions, and marketplace adapters became more work than the task justified. The useful part was the workflow and its approval rules; those no longer needed a dedicated application.

## The workflow

The assistant turns an item and its photos into a proposal: selected images, title, description, price, category, and delivery option. A standalone `Go` approves one stored action. Buyer replies, drafts, deletions, and relisting use the same approval mechanism.

The project started as a NemoClaw experiment and ended up with its own Node.js runtime. The launcher retains an optional OpenShell network policy hook.

## Design decisions

- **The host authorizes writes.** Tool schemas and deterministic code enforce permissions independently of the prompt.
- **Approval applies to an exact payload.** It expires, is consumed once, and is invalidated by an intervening message. Image hashes bind the approved proposal to the files actually used.
- **An ambiguous write is not retried.** SQLite records operation phases so a restart can reconcile the remote result instead of publishing twice.
- **Inventory belongs to the physical item.** An item survives an expired listing and can have one active listing per marketplace. Sold items cannot be republished.
- **Marketplace content is untrusted input.** Buyer messages and search results cannot authorize tool actions.
- **Photo corrections preserve condition.** Originals remain unchanged; derivatives record their source and edits. No generative retouching hides wear or defects.

## Code map

| Area | Implementation |
| --- | --- |
| Agent loop, tool catalog, and approvals | [`workspace/agent.js`](workspace/agent.js) |
| Durable operation journal | [`tools/marketplace-broker.js`](tools/marketplace-broker.js) |
| Shared item and listing inventory | [`tools/adstore.js`](tools/adstore.js) |
| Image integrity and provenance | [`tools/media-store.js`](tools/media-store.js), [`tools/image.js`](tools/image.js) |
| Marketplace adapters | [`tools/kleinanzeigen.js`](tools/kleinanzeigen.js), [`tools/vinted.js`](tools/vinted.js) |
| Regression tests | [`test/`](test/) |

## What changed during development

- **March:** initial marketplace client, Telegram photo workflow, local memory, and SQLite inventory.
- **April:** draft and image support, authentication fixes, and more reliable Telegram polling.
- **July:** OpenRouter tool calling, exact-action approvals, durable recovery, spend limits, and Vinted support.
- **August:** visible browser-form preparation and publishing, stricter session handling, live-listing edits, and simpler manual startup.

The Git history retains the original development dates and changes. I removed credentials, personal runtime data, and local setup notes and switched my commits to a GitHub noreply address. The cleanup changed the commit hashes.

## Inspecting the code

Requires Node.js 20 or newer. The regression suite uses temporary state and mocked integrations; no marketplace account or API key is needed.

```sh
npm ci
npm test
npm run check
```

Start with [`test/full-journey.test.js`](test/full-journey.test.js) for the photo-to-listing flow, or [`test/agent-security.test.js`](test/agent-security.test.js) for the approval and input boundaries.

## Limitations

The adapters use unofficial web interfaces and browser forms. Live behavior has not been verified since the project was retired. Model identifiers and setup helpers are historical. The default dry-run mode blocks external writes and still allows network reads.

Kleinanzeigen and Vinted are not affiliated with this project. Publishing the code does not grant permission to automate either service. Kleinanzeigen's [terms](https://themen.kleinanzeigen.de/nutzungsbedingungen/) restrict automated access and content collection without written permission. No live demo or deployment is provided.
