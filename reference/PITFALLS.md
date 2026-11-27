# Pitfall catalogue — review path

Symptom → cause → fix. Every entry below cost at least one run. Numbers 1–2 and 24 are inherited from the
credential harness because they still apply.

## 1. Hydration judged by HTTP 200 or a 150 k page

Symptom: login form exists, submit does nothing, page length 150–260 k.
Cause: that is the pre-hydration shell; the site widget and the real handlers are not mounted.
Fix: require `#ajax-login` **and** `window.hcaptcha` **and** `outerHTML.length > 400000`; reload up to four times;
if a kept profile is already logged in (`zss` present), reuse the session instead of hydrating.

## 2. Empty or `TIMEOUT` captcha token posted anyway

Symptom: every login is `"We’re unable to log you in right now."`, `tokLen: 0`.
Cause: a `Runtime.evaluate` timeout was treated as a token; Yelp fail-closes on a tokenless POST.
Fix: treat `TIMEOUT`/`SENDERR`/`ERR:*` as empty, re-arm and re-mint up to three times, abort the attempt.
Launch with the anti-throttling flags and `Emulation.setFocusEmulationEnabled`.

## 3. `preventDefault` on the review form

Symptom: text and stars are in the page, click does nothing, no review, no error.
Cause: the composer relies on a native form POST + reload to run its completion mutation.
Fix: do not intercept `submit`. Let the POST navigate. The SPA fires `SaveReviewDraft` → `CreateReview` on the
reloaded document.

## 4. Changing the submit button to `type=button`

Symptom: after the change, `CreateReview` never fires.
Cause: same as above — removing native submit removes the trigger.
Fix: keep `type=submit` and `data-testid=post-button`; click it.

## 5. Trusting `data-activated`

Symptom: button says `data-activated="false"`, so the run waits or tries to "activate" it.
Cause: cosmetic attribute; it stays false even when the form is valid.
Fix: ignore it. Verify readiness by text length and `input.checked`, then click.

## 6. Star click with a page scrolled down

Symptom: text inserted, review posted with no rating (or the wrong one).
Cause: CDP mouse coordinates were computed before/without scrolling; the click lands elsewhere.
Fix: `window.scrollTo(0,0)`, recompute the label rect, click center, then assert `input.checked` and the matching
"Great/Good/OK" text. If the label is missing, JS `.click()` the radio.

## 7. Assuming the browser can be closed between login and posting

Symptom: `zss` gone, composer redirects to login.
Cause: `zss` is a session cookie (no expiry); only the live profile restores it.
Fix: login and post in the same Chrome process/profile. With a persistent `PROFILE`, Chrome restores session
cookies on relaunch; still verify `zss` before posting.

## 8. Opening `/biz/<encid>` to "reach the review button"

Symptom: 1.5 KB DataDome interstitial, hours lost retrying IPs.
Cause: `/biz` is edge-challenged for automated clients even with a real browser and clean IP.
Fix: go straight to `/writeareview/biz/<encid>`; it is envoy-served and contains the full composer. `/biz` is only
needed for reading, and even then it often fails.

## 9. Harvesting encids from search every run

Symptom: run blocks on a DataDome 403 before any review.
Cause: `/search` is challenged on most sessions.
Fix: harvest once when a page happens to load, cache the `encid`s (22-char `[A-Za-z0-9_-]`), reuse forever. The
composer takes the encid directly; no search needed.

## 10. Reusing a burned profile

Symptom: login succeeds but `/biz_photos` and `/search` 403 on every new IP; `/biz` never loads.
Cause: profile-level edge flag after ~6 reviews in one hour.
Fix: keep a clean profile per role; stop posting after ~5–6 reviews/hour on one account; use the other account or
a fresh profile for reads. Burn is per profile, not per IP.

## 11. Reading the filter oracle on a burned profile

Symptom: `/biz_photos/<encid>` returns the 1.5 KB challenge instead of `rating (N reviews)`.
Cause: same edge flag as #10.
Fix: use a logged-in profile that has not posted recently; retry across sessions only if the profile is clean.
Read the header before any post, write the number down, then post.

## 12. Treating `UPSTREAM_SERVICE_ERROR` as an authorization denial

Symptom: a cross-account edit fails, so the IDOR "does not work".
Cause: upstream flake, often on drastic rating changes; it also appeared twice in a row on a 1-star edit that was
later accepted as 5-star.
Fix: retry once with a small delta (same rating, new text). Only a `PERMISSION`/`NOT_FOUND` type error would
indicate a real authorization check.

## 13. Omitting `reviewOrigin`

Symptom: 200 with `Variable 'input' … invalid` / field validation error.
Cause: required non-null field.
Fix: send `reviewOrigin:"biz-details-war-button"` (the value the site uses).

## 14. Posting twice "to be safe"

Symptom: second call returns `CANNOT_CREATE_REVIEW_UPDATE`, or under concurrency one `UPSTREAM_SERVICE_ERROR`.
Cause: dedupe is per user + business.
Fix: one request per business. Dedupe response = success already exists; only transport errors are retryable.

## 15. Expecting the legacy form to accept injected fields

Symptom: 403 `No CSRF token was provided`.
Cause: form endpoint enforces CSRF; the token is minted by `csrfToken({scope:"media_upload"})` in the bundle and
is not in meta/`yConfig`/cookies.
Fix: use the GraphQL mutations. The form path is only useful if you first execute the bundle's token function.

## 16. Posting raw GraphQL

Symptom: 403 Forbidden.
Cause: `/gql/batch` only runs persisted queries.
Fix: always send `operationName` + `documentId`. `{ __typename }` and introspection do not work.

## 17. Using `/review_share/...` as a read or delete surface

Symptom: DataDome interstitial.
Cause: the share permalink is edge-protected like `/biz`.
Fix: harvest encids from the URL when a human opens it; automate through the authenticated profile list instead.

## 18. Three Chrome instances on 4 GB

Symptom: 20–80 s per action, 0 verdicts, processes swap.
Cause: RAM starvation; Chrome pages stop hydrating.
Fix: one headful Chrome per agent; two total only if the machine is otherwise idle. Close orphan `chrome.exe`
before every run.

## 19. Relay port in the Windows reserved range

Symptom: `EACCES` on `listen`, script continues with a dead proxy, all navigations fail.
Cause: Windows reserves random high port blocks (seen at 41000+).
Fix: pick `21000–29000`; retry with a new pair on `EADDRINUSE`/`EACCES`; abort the attempt if listen fails.

## 20. PowerShell dying with "paging file is too small"

Symptom: `cmd`/PowerShell cannot start, every command fails before touching Yelp.
Cause: 4 GB machine plus two agents plus Chrome at 0 free memory.
Fix: check free MB first; kill node/chrome orphans; wait or reboot. Do not debug Yelp while the OS is starving.

## 21. DataDome `debugger` freeze

Symptom: page title stays correct but every `Runtime.evaluate` returns `TIMEOUT`; a direct CDP tap freezes too.
Cause: anti-debug loop on a challenged document.
Fix: count consecutive timeouts; after two, kill Chrome and rotate session. Do not raise the evaluate timeout —
the renderer is stopped, not slow.

## 22. Proxy tunnel dropping mid-run

Symptom: `ERR_TUNNEL_CONNECTION_FAILED`, then every navigation fails.
Cause: sticky session died or Oxylabs quota/edge reset.
Fix: new session id, relaunch. On 407 drop the proxy account (quota), do not retry it.

## 23. Truncating captured `postData`

Symptom: replay returns "field missing" although the captured request looked complete.
Cause: `Network.requestWillBeSent` data was sliced to 3 000 chars; the GraphQL `input` was cut mid-object.
Fix: keep at least 12 000 chars for `/gql` bodies and store the matching response by `requestId`.

## 24. Reading only the last N network items

Symptom: the interesting mutation is missing from the log.
Cause: unrelated analytics POSTs push it out of the tail slice.
Fix: filter by body containing the operation name, or by URL `/gql/batch`, and record a dedicated field.

## 25. Testing IDOR on a stranger's review first

Symptom: an edit succeeds, but you cannot prove what changed and cannot restore it.
Cause: no baseline.
Fix: create two controlled accounts, have A post, B edit, B restore A's original text. Record both responses.

## 26. Believing "created" means "visible"

Symptom: report says success while the review sits in "Not currently recommended".
Cause: creation and recommendation are different systems.
Fix: check the own-review list after ~7 s and report creation and recommendation separately. Use the
`/biz_photos` count oracle when a clean profile is available.

## 27. Leaving profiles and logs behind

Symptom: disk fills, next run picks the wrong session, repo bloats.
Cause: Chrome profiles are 50–100 MB each; JSONL logs grow.
Fix: `KEEP_PROFILE=0` for throwaway runs; keep only the two role profiles; delete `runs-recon/*.log` after
transcribing evidence; `node --check runner/flow.js` before committing.
