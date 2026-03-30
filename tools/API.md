# Kleinanzeigen API Map

Reference for building hard skills. Auth is handled transparently by `kleinanzeigen.js`.

## Auth
| Type | Transport | Source |
|---|---|---|
| Cookie | `Cookie` header | `KA_COOKIES` (Playwright login) |
| Bearer | `Authorization: Bearer` | `access_token` cookie, auto-extracted |
| Token refresh | POST body | `refresh_token` cookie → `login.kleinanzeigen.de/oauth/token` |

---

## Implemented

| Method | Endpoint | Auth | Tool |
|---|---|---|---|
| GET | `api.kleinanzeigen.de/api/users/{uid}/conversations` | cookie | `getConversations` |
| GET | `api.kleinanzeigen.de/api/users/{uid}/conversations/{id}/messages` | cookie | `getMessages` |
| POST | `api.kleinanzeigen.de/api/users/{uid}/conversations/{id}/messages` | cookie | `sendKAMessage` |
| GET | `api.kleinanzeigen.de/api/users/{uid}/ads` | cookie | `getMyAds` |
| GET | `www.kleinanzeigen.de/users/{uid}/ad-drafts.json` | cookie | `getDrafts` ✓ response mapped |
| GET | `www.kleinanzeigen.de/s-{slug}/seite:{n}/{kw}/k0c{catId}` | cookie (optional) | `searchAds` ✓ |
| GET | `gateway.kleinanzeigen.de/private-bundles/me/ads/bundles` | bearer | `getAdBundles` ✓ (empty until live ad exists) |
| GET | `gateway.kleinanzeigen.de/messagebox/api/users/{uid}/conversations/{id}?contentWarnings=true` | bearer | — needs `x-ecg-user-agent: messagebox-1` header |

## Needed (skills blocked)

| Skill | Endpoint (guessed / TBD) | Notes |
|---|---|---|
| ~~price-research~~ | ~~guessed~~ | ✓ solved — see implemented above |
| create-post | `POST gateway.kleinanzeigen.de/postad/api/v1/drafts` | create draft — needs curl |
| create-post | publish draft endpoint | TBD — likely PUT/POST on draft ID |
| create-post | photo upload endpoint | TBD |
| my-ads | `DELETE api.kleinanzeigen.de/api/users/{uid}/ads/{adId}` | delete ad — needs curl |
| my-ads | `PUT/PATCH api.kleinanzeigen.de/api/users/{uid}/ads/{adId}` | pause/activate — needs curl |
