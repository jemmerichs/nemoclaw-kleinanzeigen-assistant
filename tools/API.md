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
| GET | `gateway.kleinanzeigen.de/messagebox/api/users/{uid}/conversations` | bearer | `getConversations` |
| GET | `gateway.kleinanzeigen.de/messagebox/api/users/{uid}/conversations/{id}/messages` | bearer | `getMessages` |
| POST | `gateway.kleinanzeigen.de/messagebox/api/users/{uid}/conversations/{id}/messages` | bearer | `sendMessage` |
| GET | `www.kleinanzeigen.de/m-meine-anzeigen-verwalten.json` | cookie | `getMyAds` |
| GET | `www.kleinanzeigen.de/users/{uid}/ad-drafts.json` | cookie | `getDrafts` |
| POST | `www.kleinanzeigen.de/users/{uid}/ad-drafts.json` | cookie + CSRF | `saveDraft` |
| DELETE | `www.kleinanzeigen.de/users/{uid}/ad-drafts/{id}.json` | cookie + CSRF | `deleteDraft` |
| GET | `www.kleinanzeigen.de/s-{slug}/seite:{n}/{kw}/k0c{catId}` | cookie | `searchAds` |
| POST | `www.kleinanzeigen.de/p-bild-hochladen.html` | cookie + CSRF | `uploadImage` |
| POST | `www.kleinanzeigen.de/_actions/postListingWeb.submitListing/` | cookie + CSRF | `createAd` |
| POST | `www.kleinanzeigen.de/m-anzeigen-loeschen.json?ids={id}` | cookie + CSRF | `deleteAd` |
| GET | `gateway.kleinanzeigen.de/private-bundles/me/ads/bundles` | bearer | `getAdBundles` |

## Gateway migration

`gateway.kleinanzeigen.de` is the newer microservice and appears to be a superset of the legacy `api.kleinanzeigen.de` surface. Currently only `getAdBundles` uses it. Worth auditing whether messaging, search, and drafts are also available there — if so, we can consolidate to gateway-only and drop the legacy cookie calls.

Messaging and bundle reads use the gateway. Posting, images, drafts, public search, and ad management still use the current web endpoints because their working request formats are browser/CSRF based. Do not guess new endpoints: capture and verify real browser traffic before migrating another operation.
