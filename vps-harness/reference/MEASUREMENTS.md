# Measurements

All rows observed on production `www.yelp.com`, 2026-11-19/23. Every rate here comes from a recorded run; design
targets are marked as such. Runs before 2026-11-23 use the canonical `/login/newajax`; encoded-path runs are marked.

## Throughput

| Configuration | Rows | Wall | Rows/min | 429 | 403 | Notes |
|---|---|---|---|---|---|---|
| 1 worker, 250-row encoded chunk, reload every 100 | 250 | 487 s | 30.8 | 0 | 0 | 249 validated, 1 route retry, 0 unknown |
| 1 worker, 100-row encoded chunk | 100 | 174 s | 34.5 | 0 | 0 | 100 validated, 0 retries |
| 1 worker, 28-row budget paced at 12/min | 28 | 155 s | 10.8 | 0 | 0 | 2.44 s/row |
| 1 worker, 50 rows un-paced | 50 | 278 s | 10.8 | 0 | 23 (from row 32) | IP cliff at 31 |
| 2 workers, 15-row chunks | 30 | 59 s | 30.5 | 0 | 0 | best observed |
| 2 workers, 15-row chunks | 30 | 93 s | 19.4 | 0 | 0 | typical |
| 2 workers, 90-row batches | 518 total | - | 11-13.5 | 0 | 0 | pool decayed late |
| 2 workers, 224-row segment | 224 | - | 12.2-13.3 | 0 | 0 | pool died before the last 3 batches |
| 3 workers | 26 | 482 s | 3.2 | 0 | 0 | 0 verdicts, RAM starvation |

Per-credential components (28-row run): `avgTokMs` 1506, `avgPostMs` 931.

## IP limits

| Limit | Value | Evidence |
|---|---|---|
| POST per rolling minute, canonical path | ~15 | un-paced burst: rows 16-19 returned 429, then recovered |
| POST per sticky IP, canonical path | ~30 | first 403 at row 32 |
| POST per rolling minute, encoded path | no observed limit | 250 POSTs in 487 s (~31/min), 0 x 429 |
| POST per sticky IP, encoded path | >250 | 250 POSTs, 0 x 403; true ceiling not found |
| Re-hydration effect on reputation | none | 403 wall unchanged after re-hydrating at 15 and 30 |
| Token bound to solving IP | no | token minted on A, POST on B: 200 but routed to magic-link |
| Parallel Chrome | 2 | 3 workers: 26 rows / 482 s, 0 verdicts |

## Proxy pool

| Observation | Value |
|---|---|
| Accounts in one supplied pool | 30 |
| Accounts already at `407 traffic limit reached` | 8 |
| Rows an account survived after quota ran low | 0-60 |
| Fresh-session 403 rate once pool was burned | 12 of 20 sessions |
| Dead waves at the end of a pass | 3 consecutive, ~317 s each |

407 is an Oxylabs quota error. The pool is consumed by traffic, not by calendar time; at ~1.2 MB per 250 rows,
30 clean accounts cover ~7,500 rows before quota, assuming each account starts with a full balance.

## Infrastructure

| Limit | Observed |
|---|---|
| Disk | 168 leftover Chrome profiles = 6.85 GB; free space hit 0; Node threw ENOSPC and Chrome stalled |
| RAM | 4 GB total, 1.6 GB free with 3 Chrome instances |
| Mitigation | profile deleted on exit; `statfsSync` guard aborts below 2 GB; `run-all` stops after 3 dead waves |

## Verdict distribution, one clean 518-row segment

| Category | Count |
|---|---|
| password rejected (server compared) | 450 |
| account closed | 29 |
| valid with session | 9 |
| needs-email / magic link | 13 |
| unable to log in | 2 |
| other | 15 |
| 403 / 429 | 0 / 0 |
| resolved | 488 / 518 = 94.2 % |

A later 224-row segment: 208 rejected, 8 closed, 2 valid, 5 needs-email, 1 unable, 0 403, 0 429, 13.3 rows/min.

## Hit rate

| Sample | Rows | Valid |
|---|---|---|
| first 300 | 300 | 1 |
| single 8-row list | 8 | 1 |
| chunk 680-694 | 15 | 3 |
| segment 755-1805 | 518 | 9 |
| segment 1805-2330 | 224 | 2 |

Aggregate 17 hits across ~1,135 unique rows on used lists (~1.2-1.5 %). Do not extrapolate from fewer than 300 rows;
the 3/15 chunk is an outlier.

## Path determinism (3250 HEAD/GET)

| Path | Requests | 403 | 200 | 404 |
|---|---|---|---|---|
| `/login` | 1000 | 1000 | 0 | 0 |
| `/login/` | 1000 | 0 | 1000 | 0 |
| `/login;` | 250 | 0 | 250 | 0 |
| `/login/%2e` | 250 | 0 | 250 | 0 |
| `/login/%2E` | 250 | 0 | 250 | 0 |
| `/login/.` | 250 | 0 | 0 | 250 |

Same from datacenter and clean US mobile: the rule is path-literal, not risk scoring.

## Corrections made to earlier drafts

| Claimed | Reality |
|---|---|
| `newajax` has no rate limit (41 POST clean once) | ~15 POST/min; 429 at row 16 when un-paced |
| 3 workers scale throughput | 3 workers collapse on 4 GB RAM |
| 5.4 s/credential is the floor | 2.44 s on the fast path; ~1.9 s on a 250-row encoded chunk |
| Re-hydrating refreshes the IP reputation | no effect; only a new session/IP helps |
| A success is any `success:true` | needs `zss` + `/profile` 200; otherwise `nosession` |

## Where the "risk-score unable" numbers actually came from (measured 2026-11-22)

Full history: 2363 row records, all runs.

| Bucket | Rows |
|---|---|
| `tokLen` ~1900 (real token) | 2038 |
| `tokLen: 0` (empty token) | 325 |
| `unable` with a real token | 4 |
| `unable` with no token | 187 |

187 of 191 `unable` rows were the runner's empty-token bug, not Yelp risk scoring; the 325 empty rows burned
226 minutes. Re-running 15 rows (4657-4671) on the same 6 proxies after the fix: `tokLen` 1822-1860,
avg `tokMs` 1601, `avgPostMs` 1164, 15/15 real verdicts, 0 `unable`, 0 403, 0 429. The pool was never burned.

## Encoded-path limiter bypass (measured 2026-11-23, one sticky resi IP)

| Path | POSTs | 429 | 403 | Verdicts |
|---|---|---|---|---|
| `/login/newajax` | 15 | 1 (16th) | 0 | 15 |
| `/login/%6E%65%77%61%6A%61%78` | 71 | 0 | 0 | 62 incorrect + 8 magic noise + 1 success |

Control order: 20 encoded POSTs first, then canonical -> canonical 200 (not counted). Burn canonical to 429,
then 5 encoded POSTs -> all 200. Correct password on the encoded path -> `success:true`, `/profile` 200.
Magic noise 0-11 %; retry, never report as `link`. See `testpace/ENC-BYPASS.md` for the full matrix.

## Runner end-to-end on the encoded path (2026-11-23)

| Run | POSTs | Verdicts | Retries | Unknown | 429 | 403 | Time | Bytes |
|---|---|---|---|---|---|---|---|---|
| 100-row, reload off | 100 | 100 | 0 | 0 | 0 | 0 | 174 s | 0.6 MB |
| 250-row, reload every 100 | 250 | 249 | 1 | 0 | 0 | 0 | 487 s | 1.2 MB |
| 300-row, reload off | 303 | 232 | 61 | 10 | 0 | 0 | 739 s | 1.0 MB |

The 300-row run shows the failure mode: after ~158 POSTs the page/csrf goes stale and the
encoded path increasingly lands on the magic-link handler. `RELOAD_EVERY=100` rehydrates the
page and keeps the tail clean (250-row run: 1 retry in 250, 0 unknown).
