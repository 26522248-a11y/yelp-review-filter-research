# BRIEF — Yelp review permanence hunt

Read ONLY this file first. If you need more, read `BYPASS-NOTES.md` sections 3, 4, 7, 8.
Do not read the rest of the repo.

Repo: `C:\Users\Administrator\yelp-bypassFilter`
Goal: find/verify a path that makes a Yelp review permanently recommended/visible.
Evidence first; every claim needs a request/response.

## Env
- Node 24, Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Proxy: `pr.oxylabs.io:7777`, user prefix `customer-resi_899ad974-cc-us`, pass `0RfGsc47G=Sv`
- Account A `duatravelsuk@gmail.com:Pak@aSiA&ISI%786` — profile `profiles\dua`.
  BURNED at the edge: DataDome often blocks /biz_photos. Has review
  `09773aYTIbSk12Zt2sHnnQ` on business `cQdLIIzsExv9LF3s4s7Hzw` (Saved By The Bagel).
- Account B `wisejayc@gmail.com:carrot91` — profile `profiles\wise`.
  Fresh, logged in (zss live).
- 4 GB RAM: max ONE Chrome per agent. Never share a profile between agents.

## Measured facts (do not re-derive)
- `/login/` and `/writeareview/biz/<encid>` are envoy-served: NO DataDome.
- `/biz`, `/search`, `/biz_photos`, `/review_share`: DataDome; `/biz_photos` often works
  in a logged-in browser and shows `rating (N reviews)` — N = RECOMMENDED count (oracle).
- `/gql/batch` is persisted-query only (raw query -> 403).
- CreateReview docId `e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63`
  input: `businessEncid, rating, comment, reviewOrigin` (required), `reviewSessionId`.
- EditReview docId `455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609`
  input: `reviewEncid, rating, comment, reviewOrigin, reviewSessionId`.
- Input types are strict: `status`, `isRecommended`, `createdAt`, `photos` are rejected.
- Dedupe enforced under concurrency (1 success, rest CANNOT_CREATE_REVIEW_UPDATE).
- Legacy form POST -> 403 "No CSRF token was provided".

## Tool
`runner/flow.js` stages: `login | review | verify | api-post | api-batch | idor | counts |
surfaces | fuzz2 | fuzz3 | race | editprobe | formpost | probe2 | fuzz | api`.
Standard env:

```powershell
$env:PU_BASE="customer-resi_899ad974-cc-us"; $env:PW="0RfGsc47G=Sv"
$env:EMAIL="..."; $env:PASS="..."; $env:PROFILE="...\profiles\wise"; $env:ATTEMPTS="3"
$env:STAGE="..."; $env:LOG="...\runs-recon\<agent>.log"
node runner\flow.js
```

## Rules
- Only accounts A and B. NEVER edit/delete third-party reviews.
- Max 1 review per business per account. No mass posting.
- Use your own LOG file to avoid clashing with other agents.
- Cleanup before finishing: close Chrome, delete `profiles\<yours>`, delete your log.
- Write `runs-recon/report-<agent>.md`: attempts, exact request/response, conclusion,
  next step.
