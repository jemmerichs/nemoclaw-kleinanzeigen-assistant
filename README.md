# nemoclaw-kleinanzeigen

Autonomous Kleinanzeigen agent controlled via Telegram.

## How it works

**Jannik** sends messages on Telegram → **nemoclaw agent** (Claude) handles all reasoning, routing, and multi-step flows → executes via tool layer → responds.

The agent never acts on Kleinanzeigen without Jannik's explicit "Go".

## Roles

| | nemoclaw agent | Claude Code (engineer) |
|---|---|---|
| **Role** | Autonomous employee | Toolbuilder (setup only) |
| **Runs** | Always | Never (only when new code is needed) |
| **Soft skills** | Reads + executes skill docs | Writes the skill docs |
| **Hard skills** | Calls tools via bridge | Writes the API method + registers it |

Rule of thumb: if it requires judgment or natural language → agent. If it requires a new API call → engineer.

## Structure

```
tools/
  kleinanzeigen.js   — Kleinanzeigen API client
  telegram.js        — Telegram gateway
workspace/
  agent.js           — thin bridge: Telegram → Claude+tools → respond
  agent.md           — agent identity + rules (system prompt)
  skills/            — skill docs (agent reads these)
    inbox.md
    my-ads.md
    create-post.md
    price-research.md
```

## Adding a skill

- **Soft skill** (reasoning only): add a `.md` to `workspace/skills/` — agent picks it up automatically
- **Hard skill** (needs an API call): add method to `tools/kleinanzeigen.js` + register in `TOOLS` in `agent.js` + add/update skill doc
