---
name: yelp-review-pipeline
description: Post Yelp reviews through the envoy-served composer or the persisted CreateReview mutation, no captcha and no DataDome, then verify, fuzz the schema, or test the cross-account EditReview IDOR. Login uses the documented encoded-path hCaptcha flow.
---

# Yelp review pipeline — runbook

Everything here was measured on production `www.yelp.com` (2026-11). `runner/flow.js` is the only tool: one Chrome
process, one profile, login and the chosen stage in the same session.

Read `reference/PITFALLS.md` before the first run. The five that kill runs: hydration under 400 k, posting an empty
captcha token, `preventDefault` on the review form, clicking stars while scrolled, and opening `/biz`.

## 1. Requirements

| Item | Value |
|---|---|
| OS | Windows 10/11, PowerShell 5.1 |
| Node | >= 22 (global `fetch`, `WebSocket`) |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Proxy | Oxylabs sticky `customer-<type>_<id>-cc-us:pass`; 407 = quota |
| RAM | 4 GB minimum, **one Chrome at a time** |
| Disk | >= 1 GB free; profiles are 50–100 MB |
| Account | disposable; 0-history accounts will be filtered regardless of technique |

Relay listens on `127.0.0.1:21000–29000` and switches to a new port pair on collision.

## 2. Environment

| Var | Meaning |
|---|---|
| `PU_BASE` | proxy user **without** `-sessid`; the script appends `-sessid-<random>-sesstime-1800` |
| `PW` | proxy password |
| `EMAIL`, `PASS` | Yelp account |
| `PROFILE` | persistent Chrome dir, e.g. `.\profiles\a`; keeps `zss` across restarts |
| `ATTEMPTS` | login retries, default 4 |
| `STAGE` | see §3, default `login` |
| `LOG` | JSONL log, default `runs-recon/flow.log` |
| `KEEP_PROFILE` | `1` keeps a throwaway profile after the run |
| `HEADLESS` | `1` for `--headless=new`; use for authenticated IDOR only, login is flakier |
| `SKIP_LOGIN` | `1` skips login (requires a live `zss` in `PROFILE`) |

Stage-specific: `ENCID`, `RATING`, `TEXT_FILE`, `REVIEW_ORIGIN`, `JOB_FILE`, `GAP`, `REVIEW_ENCID`,
`BIZ_ENCID`, `ENCIDS`, `SNIPPET`, `WURL`, `VURLS`, `DUMP_ENCID`, `PHOTO`, `SUBMIT`, `BIZ`, `TEXT`, `CITY`,
`SEARCH_URL`, `DESC`, `LOC`, `CMT`, `N`, `MARKER`, `CLICK`.

Proxy sessions are sticky for 1 800 s. One session per run; do not mint a token on one IP and post from another.

## 3. Stages

| Stage | Purpose | Needs | Output |
|---|---|---|---|
| `login` | login, keep `zss` | account | `session_ready`, profile 200 |
| `review` | composer: discover fields; submit with `SUBMIT=1` | `BIZ` or search envs | `form`, then `gql_resp` |
| `verify` | own review list, optional NR click | `SNIPPET` | `verify` |
| `api-post` | one `CreateReview` | `ENCID`, `RATING`, `TEXT_FILE` | `api_post` |
| `api-batch` | jobs file → many `CreateReview` | `JOB_FILE` | `batch_item` |
| `idor` | `EditReview` on `REVIEW_ENCID` | `REVIEW_ENCID`, `BIZ_ENCID` | `idor` |
| `counts` | read `/biz_photos` header counts | `ENCIDS` | `count` |
| `resurrect` | count → edit → wait 120 s → count | `BIZ_ENCID`, `REVIEW_ENCID`, `TEXT_FILE` | `count`, `edit`, `result` |
| `surfaces` | probe tips/questions/photos/collections | `ENCID` | `surface` |
| `fuzz2` | enumerate `CreateReviewInput` | — | `f2` |
| `fuzz3` | enumerate `EditReviewInput` | — | `f3` |
| `race` | N concurrent `CreateReview` | `ENCID`, `N` | `race` |
| `editprobe` | capture `EditReview` docId from UI | `ENCID` | `ops` |
| `formpost` | legacy form + CSRF probe | `ENCID` | `fp_*` |
| `probe2` | own card badge + raw GraphQL | `SNIPPET` | `card`, `rawq` |
| `api` | scan loaded JS chunks for mutation names | `WURL` | `js_scan` |
| `delprobe` | dump review-card controls | `SNIPPET` | `del_view` |

## 4. Login

```powershell
$env:PU_BASE="customer-resi_…-cc-us"; $env:PW="…"
$env:EMAIL="…"; $env:PASS="…"; $env:PROFILE=".\profiles\a"; $env:ATTEMPTS="3"
$env:STAGE="login"; node runner\flow.js
```

Success: `session_ready` with `zss` 30, then `/profile` 200. If the profile already has a valid `zss`, the logged-in
redirect is detected and reused. Failure `why`: `dd` (edge), `hydrate` (page under 400 k), `captcha` (no token),
`verdict` (no `zss`), `cdp`/`ws` (browser).

Never POST when the token is empty or the string `TIMEOUT`.

## 5. Post a review

### API (preferred, ~2 s)

```powershell
$env:STAGE="api-post"; $env:ENCID="<22-char>"; $env:RATING="5"
$env:TEXT_FILE=".\testpace\review.sample.txt"; node runner\flow.js
```

Success: `CreateReviewSuccess` with a review encid. Duplicate: `CANNOT_CREATE_REVIEW_UPDATE`.

Put `reviewOrigin` in `REVIEW_ORIGIN` only if you need a different value; the default is the site value.

### UI (when proving the human path)

```powershell
$env:STAGE="review"; $env:SUBMIT="1"; $env:RATING="5"
$env:TEXT_FILE=".\testpace\review.sample.txt"
$env:BIZ="https://www.yelp.com/writeareview/biz/<encid>?return_url=%2Fbiz%2F<encid>&review_origin=biz-details-war-button"
node runner\flow.js
```

Without `SUBMIT=1` the stage only dumps the form. The click is a native POST; the script does not intercept it.
The completion mutation fires after the reload.

## 6. Verify

```powershell
$env:STAGE="verify"; $env:SNIPPET="first 40 chars of the review"
$env:VURLS="https://www.yelp.com/user_details_reviews_self"
node runner\flow.js
```

The list loads async, ~7 s, then scroll. There is no recommended/NR badge. Use `counts` on a clean profile for the
recommended count (N+1 means recommended; N means filtered).

## 7. IDOR (two accounts)

Account A must own `REVIEW_ENCID`; log in as B:

```powershell
$env:STAGE="idor"; $env:PROFILE=".\profiles\b"; $env:EMAIL="…B…"; $env:PASS="…B…"
$env:REVIEW_ENCID="09773aYTIbSk12Zt2sHnnQ"; $env:BIZ_ENCID="cQdLIIzsExv9LF3s4s7Hzw"
$env:RATING="5"; $env:TEXT_FILE=".\testpace\review.sample.txt"; node runner\flow.js
```

`EditReviewSuccess` = confirmed. Restore A's original text afterwards with the same stage (that also succeeding is
the second proof).

## 8. Schema / research stages

```powershell
$env:STAGE="fuzz2"   # one candidate field per CreateReview, no rows created
$env:STAGE="fuzz3"   # same for EditReview
$env:STAGE="race";   $env:ENCID="…"; $env:N="5"
$env:STAGE="editprobe"; $env:ENCID="…"   # capture docId from the owner edit flow
$env:STAGE="api";    $env:WURL="https://www.yelp.com/writeareview/biz/<encid>?…"
```

## 9. Acceptance checks after any change

1. `node --check runner\flow.js`.
2. `STAGE=login` on a clean profile → `success:true`, `zss` 30, `/profile` 200.
3. `STAGE=review` without `SUBMIT` on a known encid → page > 300 k, `input[name^=rating-]` present,
   `div[role=textbox]` present, `[data-testid=post-button]` present.
4. `STAGE=api-post` on a business the account has not reviewed → `CreateReviewSuccess`.
5. `STAGE=idor` from the other account on a known review → `EditReviewSuccess`.
6. Any of 2–5 failing means stop; check `PITFALLS.md` before touching code.

## 10. Cleanup

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'flow\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item runs-recon\flow.log -Force
```

Keep `profiles\a` and `profiles\b` only if the sessions are still useful; delete throwaway profiles. Never share a
profile between concurrent agents.

## 11. Rules

- Max one review per business per account; dedupe rejects the rest.
- Do not edit third-party reviews without recording the original text first.
- Stop posting after ~5–6 reviews/hour on one account; the profile gets edge-flagged.
- 407 is proxy quota, not a Yelp block.
- Creation success ≠ recommended. Report both separately.
