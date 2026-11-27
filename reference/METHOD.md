# Method — how the findings were reached

This is the research chronology, not a polished story. It records the order, the cost, the failed hypotheses and
the exact probe that killed each one. The point is that the next person can repeat, extend, or falsify the work
without re-deriving it.

Operating rules used throughout:

1. **Cheapest probe first.** curl before Chrome; one request before a session; a GET before a POST.
2. **One variable per request.** Never batch unrelated hypotheses into the same run.
3. **A validation error is data, not failure.** GraphQL errors enumerated the schema in 46 cheap requests without
   creating a single row.
4. **Separate identity from content.** Two accounts turn "does it work" into "whose object is it".
5. **Do not touch third-party content** unless the step is reversible.
6. **Write down the negative results.** They are the map of what not to retry.

---

## 0. Ground truth from the existing harness

The repo already documented: the login path, the 400 k hydration threshold, the `hcaptcha_response` field name,
the anti-throttling Chrome flags, and the fact that `/login/` is envoy while `/login` is DataDome. That was
reproduced before touching review code (`STAGE=login`): `success:true`, `zss` 30 chars, profile page 200.

Two things in the docs were load-bearing and saved hours: hydration is not judged by HTTP 200, and an empty
token must never be posted.

## 1. Map the edge before automating (curl, ~40 requests)

A matrix of HEAD/GET against login, search, business and write-review paths, one fresh sticky session:

| Probe | Result |
|---|---|
| `GET /login` | 403 DataDome |
| `GET /login/` | 200 |
| `GET /search?find_desc=…` | 403 DataDome |
| `GET /biz/<encid>` | 403 DataDome |
| `GET /writeareview/biz/<encid>` | **200, 337 KB, full composer** |
| `GET /biz_photos/<encid>` | 403 |

The matrix is in `testpace/http/path-matrix.ps1`. The useful result was not "DataDome blocks Yelp" (known) but
that the composer is served by a different tier with no challenge. That single line set the rest of the design:
**stop trying to load `/biz`.**

Also tested and ruled out for reads: RSS (404/403), `r.jina.ai` (gets the captcha on datacenter IPs), mobile UA
(reset), raw GraphQL (403, persisted-query only).

## 2. Confirm the composer in a real browser

`Page.navigate` to the composer, then dump `document.title`, length, forms, inputs, contenteditable, file inputs,
buttons and `window.hcaptcha`. Result: 522 KB, title "Write a Review for …", star radios
`input[name^="rating-"]`, a Lexical `div[role=textbox][contenteditable]`, `input[type=file]`,
`[data-testid=post-button]`, no visible captcha.

Notable: the page carries a site hCaptcha key in markup but never renders a widget on this path. No token is
needed to create a review.

## 3. Submit mechanics — the expensive part (~2 hours, 8 runs)

First attempts filled the form correctly (text length 812) and clicked the button. Nothing was created. The button
stayed `data-activated="false"`, so the first hypothesis was "button disabled / React state not ready".

What was tried, in order:

| Attempt | Result |
|---|---|
| Click the activated-looking button after typing | nothing; page looked unchanged |
| `form.requestSubmit()` | navigation, review not created |
| `preventDefault` on the form submit | no navigation, no `CreateReview` |
| `preventDefault` on window (bubble) | same |
| Change `type=submit` → `type=button` | no native POST, no completion at all |
| Wrap `fetch` to capture `/gql/batch` | revealed `SaveReviewDraft`, then `CreateReview` **after** reload |

The winning model: the button performs a **native form POST** (rating only), the document reloads, and the
reloaded SPA completes the review with the draft. Any JS guard that stops the native POST also stops completion.
`data-activated` is cosmetic.

Second bug in the same area: the star click used CDP mouse coordinates while the page was scrolled, so the click
missed. Fix: scroll to top, compute the label rect, click; verify with `input.checked` and the text
"Great/Good/OK/…". JS `.click()` on the radio also works in most runs; the mouse path was kept because it is
closer to human input.

At this point one review was created (`CreateReviewSuccess`), which proved the model. But the response was read
from the network log after a reload, and the review did not appear on the profile for a while — the first
"filtered?" scare. It appeared later on the own-review page.

## 4. Capture the API contract

The UI is slow (≈30 s including navigation) and fragile. The SPA fires `CreateReview` as a GraphQL POST; capturing
it gives everything needed to skip the UI.

Instrumentation: CDP `Network.requestWillBeSent` for `POST /gql/batch`, keep `postData` (first 3 000 chars, later
12 000 — 3 000 truncated the `input` object), and `Network.getResponseBody` on `loadingFinished` to read the
reply. A first attempt kept only the last three log items, and noise pushed the `CreateReview` body out of the
slice; the fix was a dedicated `cr_req` record filtered on the body containing `CreateReview`.

Recovered contract:

* operation `CreateReview`, persisted `documentId` `e99ac0db…51c63`
* input `businessEncid, rating, comment, reviewOrigin` (`reviewOrigin` required)
* headers `content-type: application/json`, `x-apollo-operation-name: CreateReview`
* response `CreateReviewSuccess` + review encid

Replay from page `fetch` with session cookies: success in ~2 s, no captcha. This is now `STAGE=api-post`.

## 5. Enumerate the input type (44 requests, 0 rows)

Sent `CreateReview` with a fake business encid and one candidate extra field per request. The server validates the
input shape before resolving, so every response is either "field not defined" or a downstream business error.
That distinguishes schema membership without creating anything.

Result: exactly five accepted fields (§5 of `FINDINGS.md`). 44 candidates rejected. Repeated for
`EditReviewInput` after capturing its documentId: also five fields.

Why this matters: it closes mass assignment, backdating, user-id spoofing and every "set status=approved" story in
one pass. It is also the cheapest schema oracle available when introspection is off.

## 6. Capture `EditReview` and try the IDOR

The owner-side edit flow (profile → review → edit) fires `EditReview` with `documentId`
`455125ba…d9609`. Captured the same way as CreateReview.

With two controlled accounts:

1. A owns review `09773a…` on Saved By The Bagel.
2. B logs in with its own profile and sends `EditReview` with A's `reviewEncid`.
3. Result `EditReviewSuccess` — B is not the owner.
4. Restore call from B also succeeds → stable, not a race or a cached success.

The first proof used identical 5-star content, so "success" could have been a no-op. The restore (different text)
and a later 5-star text change both succeeded, which closed that gap. A 1-star change failed twice with
`UPSTREAM_SERVICE_ERROR`; a plausible moderation hook on rating swings, not an authorization signal.

Root cause is the missing owner check; severity is in `FINDINGS.md` §6.

## 7. Escalation to 9+ (all negative)

| Probe | Setup | Result |
|---|---|---|
| Unauthenticated edit | fresh profile, `SKIP_LOGIN=1`, clean cookie jar | `DOWNSTREAM_SERVICE_ERROR`; never success |
| Delete | scan loaded JS chunks for `DeleteReview`/`RemoveReview` | no hit |
| Delete via UI | profile review card, dump buttons adjacent to a known snippet | no overflow/Remove control |
| Delete via share page | `/review_share/...` | DataDome |
| Confidentiality via edit response | inspect full body | only the encid; no private fields |
| Batch multiple edits | array body, same documentId | feasible, but still integrity-only |

Conclusion recorded as 8.1 rather than inflating. The escalation table is the honest boundary of the finding.

## 8. Filter oracle

`/biz_photos/<encid>` was in the surface scan. In a logged-in browser it renders the business header with
`rating (N reviews)`. Cross-checking a known business showed the number is the recommended count, not the total —
a free oracle that avoids `/biz`.

Procedure and failure: read N=67 on Saved By The Bagel, post a review, re-read. All three re-read sessions hit
DataDome. Diagnosis: not IP (fresh sessions), but profile-level edge flag after ~6 reviews/hour. The A/B remains
unanswered; the method is sound and needs a clean profile.

## 9. Surface scan

Enumerated other places that accept public content: tips, check-in, questions, photos, collections. Tips and
check-in are removed (404), questions is 404 in the browser, photos and collections are alive but are not reviews
and do not pass through the review recommender. Useful as a durable side channel, useless as a review bypass.

## 10. Negative results worth keeping

| Hypothesis | Why it died |
|---|---|
| Raw GraphQL lets us query `isRecommended` | 403; persisted queries only |
| Mass assignment sets moderation state | strict input types (44-field enumeration) |
| Concurrent submits create duplicates | dedupe enforced: 1 success / 3 rejected |
| Legacy form allows backdating | 403 CSRF, token unobtainable from page |
| `review_share` is an unauthenticated read surface | DataDome |
| Third-party reader (Jina) bypasses the edge | DataDome on its datacenter IPs |
| Review success is visible automatically | own-review list is async (~7 s) and carries no status badge |
| A better fingerprint/proxy makes reviews stick | recommendation is account-level; proxies do not move it |

## 11. Reusable recipe for the next target

1. Build a path × client matrix with curl first. Find the tier that is not challenged (here: composer, `/gql`).
2. Reproduce login from the existing docs; do not improvise hydration.
3. Capture the real mutation with CDP, never guess the contract.
4. Enumerate the input type with one bad field per request and a fake id.
5. Capture the edit/delete mutations from the owner UI before testing authorization.
6. Use two accounts; mutate, then restore.
7. Try the unauthenticated variant with a clean profile — it changes the severity class.
8. Score honestly; list the exact missing primitive for the next severity band.

## 12. Cost log

| Phase | Wall time | Runs / requests | Result |
|---|---|---|---|
| Edge matrix | ~15 min | ~40 curl | composer found |
| Composer discovery | ~20 min | 3 pages | form fields |
| Submit debugging | ~2 h | 8 runs | native-POST model |
| API capture | ~40 min | 4 runs | contract + docId |
| Schema enumeration | ~15 min | 46 requests | 5-field whitelist |
| IDOR | ~35 min | 3 runs | confirmed |
| 9+ escalation | ~50 min | 6 runs | all negative |
| Oracle | ~25 min | 4 runs | method proven, A/B blocked |

Most of the time went into the submit model. With the contract already known, a repeat of the write path is
minutes, not hours.
