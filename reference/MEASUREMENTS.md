# Measurements

All rows observed on production `www.yelp.com`, 2026-11-26/27. Sessions are Oxylabs residential sticky US, one
session per run unless marked. "Review run" = login + composer or API.

## Edge matrix (bare curl, no cookies)

| Path | HTTP | Body | Verdict |
|---|---|---|---|
| `GET /login` | 403 | 1.5 KB DataDome | blocked |
| `GET /login/` | 200 | login page | open |
| `GET /search` | 403 | DataDome | blocked |
| `GET /biz/cQdLIIzsExv9LF3s4s7Hzw` | 403 | DataDome | blocked |
| `GET /writeareview/biz/cQdLIIzsExv9LF3s4s7Hzw` | **200** | **337 KB**, composer + sitekey | open |
| `GET /biz_photos/cQdLIIzsExv9LF3s4s7Hzw` | 403 | DataDome | open only in clean browser |
| `GET /rss/biz/cQdLIIzsExv9LF3s4s7Hzw` | 404 | — | dead |
| `GET /biz/cQdLIIzsExv9LF3s4s7Hzw.rss` | 403 | — | dead |

Browser results differ only for `/biz_photos`, which returned a 200 gallery on a logged-in clean profile, and for
`/biz`, which stayed challenged. `/writeareview` was 200 in every client.

## Login (reproduction, not exploration)

| Metric | Value |
|---|---|
| Cold login wall | ~15 s |
| Hydration threshold | `#ajax-login` + widget + `outerHTML > 400000` |
| Token | 1 866 chars, single use |
| Verdict | `{"success":true}`, `zss` 30 chars |
| Profile after login | 200 |
| Empty-token POSTs | 0 in the successful runs |

## Composer

| Observation | Value |
|---|---|
| Page length | 337 000–522 000 chars across runs |
| Title | "Write a Review for <business>" |
| Captcha widget | none rendered; sitekey present in markup |
| Star control | `input[name^="rating-"][value=1..5]` |
| Editor | `div[role=textbox][contenteditable]`, Lexical |
| Submit | `[data-testid=post-button]`, `type=submit`, native POST |
| Minimum text enforced | ~85 chars |
| File upload | `input[type=file]` present, not exercised |

## CreateReview API (authenticated)

| Metric | Value |
|---|---|
| Endpoint | `POST /gql/batch` |
| Operation / documentId | `CreateReview` / `e99ac0db…51c63` |
| Wall per call | ~2 s |
| Captcha | none |
| DataDome | none |
| Success response | `CreateReviewSuccess` + review encid |
| Duplicate response | `CANNOT_CREATE_REVIEW_UPDATE` |

Timing excludes page load: the call runs from an already-authenticated page.

## Concurrency (5 identical requests, one browser, one business)

| Outcome | Count |
|---|---|
| `CreateReviewSuccess` | 1 |
| `CANNOT_CREATE_REVIEW_UPDATE` | 3 |
| `UPSTREAM_SERVICE_ERROR` | 1 |
| Duplicate rows | 0 |

## Schema enumeration

| Input type | Accepted | Rejected | Method |
|---|---|---|---|
| `CreateReviewInput` | 5 | 44 | one candidate field per request, fake encid, validation-only |
| `EditReviewInput` | 5 | — | same on captured documentId |

Accepted: `businessEncid`, `rating`, `comment`, `reviewOrigin`, `reviewSessionId` (Create) and `reviewEncid`
instead of `businessEncid` (Edit). Rejected samples: `photos`, `checkIn`, `createdAt`, `isRecommended`,
`status`, `userId`, `reviewId`, `latitude`, `longitude`, `csrfToken`.

## IDOR

| Attempt | Caller | Subject | Response |
|---|---|---|---|
| 1 — edit to 5★ + new text | B | A's `09773a…` | `EditReviewSuccess` |
| 2 — restore original | B | A's `09773a…` | `EditReviewSuccess` |
| 3 — 1★ + marker | B | same | `UPSTREAM_SERVICE_ERROR` ×2 |
| 4 — 5★ + marker | B | same | `EditReviewSuccess` |
| 5 — no cookies | none | same | `DOWNSTREAM_SERVICE_ERROR` |
| 6 — same input type with extra fields | B | same | `not defined by type` |

Stable across sessions. Victim review left at original text, 5 stars.

## Filter oracle

| Step | Value |
|---|---|
| `/biz_photos` header, Saved By The Bagel | `4.5 (67 reviews)` |
| Review posted | `09773a…` via UI |
| Re-read sessions after 90 s | 3/3 DataDome 403 |
| Profile posts before re-read | ~6–7 in ~1 h |

N is the recommended count (cross-checked against a business with a known split). The A/B result (N vs N+1) was
not captured before the profiles were flagged.

## Other surfaces

| Path | curl | Browser (logged in) |
|---|---|---|
| `/add_tip/biz/<encid>` | 404 | 404 |
| `/tips/biz/<encid>` | 404 | 404 |
| `/check_in/biz/<encid>` | 404 | 404 |
| `/questions/biz/<encid>` | 403 | 404 |
| `/biz_photos/<encid>` | 403 | 200, gallery + Add photos |
| `/collections` | 303 → `/collections/city/<city>` | same, Create a Collection present |

## Resources

| Limit | Observed |
|---|---|
| RAM | 4 GB total; headful Chrome ~500 MB; free hit 0 MB; PowerShell failed to start once |
| Chrome per agent | 1; 2 total only when idle |
| Relay ports | 41000+ hit Windows reserved blocks (EACCES); 21000–29000 stable |
| Profile size | 50–100 MB each |
| Disk guard | abort below ~1 GB free in practice; repo kept < 1 MB |

## Review inventory

| Business | Review encid | Account | Created | State at handoff |
|---|---|---|---|---|
| Sixty Vines | `NcQCfVbQt3TZxskE7Cuo6A` | A | UI | live, account burned |
| Z9YD1 | `CcPwJQwNYa5HJdlsUVtqOw` | A | UI | live |
| Culinary Dropout | `H5y-zJtKJs0QkQxA5wgOgQ` | A | UI | live |
| Saved By The Bagel | `09773aYTIbSk12Zt2sHnnQ` | A | UI, IDOR victim | restored, live |
| The Henry Plano | `eFor9UmXkPj3R4gQD-omhw` | B | API | live |
| Dallas business | `1XPmzJZ6Seaf2vwRq40cRA` | A | API | live |

Filter status of all six is unmeasured (oracle blocked). Assume "Not currently recommended" for the 0-history
account until proven otherwise.
