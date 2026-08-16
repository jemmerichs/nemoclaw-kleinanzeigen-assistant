# Kleinanzeigen integration map

These are unofficial interfaces and may change without notice. `tools/kleinanzeigen.js` is the implementation source of truth.

## Authentication

| Scope | Transport | Source |
|---|---|---|
| Public search | none | no session required |
| Private web calls | `Cookie` header | `KA_COOKIES` from the dedicated native Chrome profile or explicit Copy-as-cURL bootstrap |
| Messagebox/bundles | `Authorization: Bearer` | `access_token` cookie; an expired token triggers one OIDC refresh without browser navigation |

Do not scrape credentials from an ordinary browser profile. Prefer `npm run login` on the production Mac. The login/import flow stores the matching Chrome User-Agent alongside the cookies; do not hand-edit one without the other. If that isolated profile is blocked while an ordinary Chrome session works, the user may explicitly export one authenticated request with Copy-as-cURL and import it through `npm run login:clipboard` or `login:import-file`. Keep `.env`, the cURL text, and the dedicated browser profile local; bootstrap a fresh session after moving to another Mac. Codex is not part of the runtime.

## Implemented surface

| Operation | Interface | Auth |
|---|---|---|
| Search public ads | Kleinanzeigen search HTML | none |
| Read own ads | `/m-meine-anzeigen-verwalten.json?sort=DEFAULT` | cookie |
| Read/save/delete drafts | `/users/{uid}/ad-drafts...` | cookie + CSRF for writes |
| Upload images for drafts | `/p-bild-hochladen.html` | cookie + CSRF |
| Publish a listing | Current visible `PostListingForm` in the dedicated native Chrome profile | browser session |
| Delete a listing | `/m-anzeigen-loeschen.json` | cookie + CSRF |
| Read/send conversations | gateway messagebox API | bearer |
| Read ad bundles | gateway private bundles API | bearer |

The model-facing listing contract is deliberately smaller than the browser form. `ka_prepare_listing`
accepts the visible category path, listing content, images, price, and the semantic delivery choice.
It returns an opaque preparation ID after resolving current provider fields. Only
`ka_publish_prepared_listing(preparationId)` can stage that snapshot for `Go`; category IDs,
`attributeMap` keys, location IDs, and the form action stay inside the bridge.

## Verification status

- Public search has a live read-only smoke test: `npm run smoke:ka`.
- The current browser form exposes a 65-character title, 4,000-character description, five-digit German postcode, 30-character contact name, and up to 20 images of at most 12 MB each; the client enforces those bounds.
- Authenticated read paths and every direct write format must be rechecked after `npm run login`. Listing publication deliberately uses the current browser form so its category, shipping, image, and hidden fields stay one coherent contract.
- Never migrate an operation to a guessed gateway endpoint. Capture and verify current behavior first.
