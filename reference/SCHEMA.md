# GraphQL surface (persisted queries)

`/gql/batch` accepts a JSON array of operations. Each operation must carry a persisted `documentId`; raw queries
and introspection return **403**.

Common headers:

```
content-type: application/json
x-apollo-operation-name: <operationName>
```

Cookies are same-origin and sent automatically.

## CreateReview

DocumentId: `e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63`

```json
[{"operationName":"CreateReview",
  "variables":{"input":{
    "businessEncid":"<22-char>",
    "rating":5,
    "comment":"<text>",
    "reviewOrigin":"biz-details-war-button",
    "reviewSessionId":"<optional>"}},
  "extensions":{"operationType":"mutation","documentId":"e99ac0db…"}}]
```

Input type `CreateReviewInput` — **exactly**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `businessEncid` | ID | yes | 22 chars, public |
| `rating` | Int | yes | 1–5 |
| `comment` | String | yes | UI enforces ~85 chars minimum |
| `reviewOrigin` | String | yes | `biz-details-war-button` is accepted |
| `reviewSessionId` | String | no | client-supplied, no observed moderation effect |

Response: `CreateReviewSuccess` with `review.encid`.

Errors seen: `CANNOT_CREATE_REVIEW_UPDATE` (already reviewed), `UPSTREAM_SERVICE_ERROR` (flake, retry).

## EditReview

DocumentId: `455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609`

```json
[{"operationName":"EditReview",
  "variables":{"input":{
    "reviewEncid":"<22-char>",
    "rating":5,
    "comment":"<text>",
    "reviewOrigin":"biz-details-war-button"}},
  "extensions":{"operationType":"mutation","documentId":"455125ba…"}}]
```

Input type `EditReviewInput` — **exactly**:

| Field | Type | Required |
|---|---|---|
| `reviewEncid` | ID | yes |
| `rating` | Int | yes |
| `comment` | String | yes |
| `reviewOrigin` | String | yes |
| `reviewSessionId` | String | no |

Response: `EditReviewSuccess` with `review.encid`. **No owner check** — see `FINDINGS.md` §6.

## Operations not captured

| Operation | Status |
|---|---|
| `DeleteReview` | not found in loaded JS; no UI control on profile |
| `AddPhoto` | UI present on `/biz_photos`, mutation not captured |
| `CheckIn` | web surface removed (404) |
| `CreateCollection` | UI present, mutation not captured |
| `GetBusinessReviewFeed` | only fires when `/biz` loads; not captured |

Persisted-query bundles do not contain an operation → documentId map; the hash must be captured from a live
request.

## Input-type enumeration recipe

1. Pick the target mutation and its documentId.
2. Send the minimal valid input with a fake object id.
3. Add one candidate field per request.
4. Read `Field 'X' is not defined by type 'CreateReviewInput'` — membership without creating a row.
5. Never use a real business with a real account for this; validation happens before resolution.

46 requests enumerated both types; full candidate list is in `runner/flow.js` (`fuzz2`, `fuzz3`).

## Legacy form endpoint

`POST /writeareview/biz/<encid>` requires a CSRF token and returns 403 `No CSRF token was provided` without one.
Token is minted by `csrfToken({scope:"media_upload"})` in the bundle, not exposed in page markup. Not worth
reviving; GraphQL is strictly better.
