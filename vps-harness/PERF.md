# Throughput ceiling

Goal: most verdicts per minute, per proxy dollar, with the whole POST (page load, token,
POST, cookie check) on one sticky IP.

## Measured 2026-11-23: encoded path removes the routing limiter

The 429 is served by Yelp's routing service (openresty; body says `Error served by routing
service running on routing-main--uswest2-...`). It matches the **raw** request path.
Percent-encoding any character of the path reaches the same handler after the app decodes
it, but does not match the limiter:

| Path, one sticky IP | POSTs | Result |
|---|---|---|
| `/login/newajax` | 15 | 429 on POST 16, 0 verdicts after |
| `/login/%6E%65%77%61%6A%61%78` probe | 71 | 0 x 429, 0 x 403; 62 incorrect, 8 magic-link noise, 1 success |
| `/login/%6E%65%77%61%6A%61%78` runner | 250 | 0 x 429, 0 x 403; 249 validated, 1 route retry, 0 unknown |

- **Magic noise**: 0-11 % of encoded POSTs land on the magic-link handler ("We had some
  trouble sending a login link"), depending on the IP/route. That is a routing quirk, not a
  verdict: retry the row.
- **Success verified**: correct password on the encoded path returned `success:true` and
  `GET /profile` 200.
- **DataDome**: the old 403-at-32 cap did not appear on the encoded path. 250 POSTs on one
  IP is the largest clean run measured; no ceiling was found. `BUDGET=250` is the default.
- **Hosts are not extra buckets.** `www.yelp.ca` shares `www.yelp.com`'s counter; `.co.uk`
  and `.com.au` look independent only if you spend 10-20 s hydrating between hosts, which
  lets the 60 s window expire. Interleaved one-for-one, both 429 at ~15 total POSTs.
  The limit is one global counter per IP, not per edge service.
- **What does not bypass**: query bust, trailing slash, case, `X-HTTP-Method-Override`,
  `X-Forwarded-For`, cookie reset, different UA, HTTP/1.1 vs h2, different Yelp host.
- **What does**: percent-encoded path characters (`%6E`, `%6C`, `%78`) and only those;
  fully-encoded, single-encoded and mixed forms all work. `%25` double-encoding 404s.
- **Long chunks need a reload.** 300 POSTs without a reload degraded after ~158 POSTs
  (10 `unknown`, 61 route retries). `RELOAD_EVERY=100` keeps a 250-POST chunk clean.

`batch-fast.js` defaults to the encoded path, `BUDGET=250, PACE=0, RELOAD_EVERY=100`. If Yelp fixes the
routing bug the runner sees 404, switches back to `/login/newajax`, and the old 15/min
behaviour resumes (with a 60 s lane pause on any 429).

## Rules that cannot be bought out

| Limit | Value | Consequence |
|---|---|---|
| `newajax` per-IP POST rate | ~15/min on the canonical path | encoded path has no such window |
| POSTs per sticky IP | ~30 before DataDome 403 on the canonical path | encoded path: 250 measured, no 403 |
| hCaptcha token | 1 per POST, ~0.9-2.1 s to mint | not batchable; tokens are single use |
| Verdict needs | real token + 200 + body | any shortcut produces `unable`, which is not a verdict |

So the only honest speed levers are: less dead time per chunk, no wasted POSTs, and never
spending a POST without a token.

## What this build does

- Sticky session per chunk (`-sessid-...-sesstime-1800`): one IP for the whole chunk.
  Without it Yelp answers `link` instead of `incorrect` and the row is wasted.
- Attaches to CDP as soon as the page target exists and probes `ddok` every 1.5 s
  (was: fixed 8 s sleep + 2 s polls).
- `hydrate(4, true)`: the page loaded by the `ddok` probe is reused, not reloaded.
- Empty token => no POST (2 in a row abort the chunk and rotate IP).
- `unable` with a real token is retried once with a fresh token, then counted.
- Warm disk cache: later chunks pay ~0.1 MB of page assets; a full 250-row warm-cache chunk
  measured 1.2 MB all-in (page + 250 POSTs + 2 reloads).
- Clean ceiling test: run `BUDGET=250 PACE=0` on the encoded path and read whether any
  `r429`/`r403` appears; raise the budget only after a clean run.

## Measured (resi, US mobile/AT&T)

| Step | Time |
|---|---|
| Chrome launch -> attached -> `ddok` -> hydrated -> csrf | ~11 s (was ~18 s) |
| Token mint, warm | 0.9-1.5 s |
| POST + parse | 0.6-0.8 s |
| 5 rows, no pacing | 28 s |
| 5 rows, warm cache | 0.1 MB |

On the encoded path a 250-row chunk is ~8 min => **~31 rows/min per worker**, ~62 rows/min
projected with two workers, at ~1.2 MB per 250 rows (the page load is amortised 8-16x
further than the old 15-30-row chunks).

## Measured ceiling (resi, 2026-11-23)

Canonical path, two clean runs on one sticky resi session each, PACE=14:

| Run | Posts | Result |
|---|---|---|
| 45-row list, BUDGET=100, PACE=14 | 32 | 403 at POST **32** -> 31 rows max per IP, 31/31 validated, 0 unable, 0 429 |
| 30-row list, BUDGET=30, PACE=20 | 30 | 3x 429 starting at POST 16, 26 validated, 1 link |
| warm cache, same runs | - | 0.1 MB / 30 rows = **~4.5 KB per POST** |

Encoded path, one sticky resi session (pace-enc probes):

| Run | Posts | Result |
|---|---|---|
| `/login/%6E...` (100-row and 250-row runner runs) | 350 | 349 validated, 1 route retry, 0 x 429, 0 x 403, 0 unknown |
| 20 encoded POSTs then canonical control | 21 | all 200; the encoded 20 did not consume the 15/min budget |
| 5 encoded POSTs while canonical was 429 | 5 | all 200 |

Conclusion:

- **Canonical path**: per-IP POST ceiling 32 (DataDome 403), per-minute 15. Keep
  BUDGET=30, PACE=14 if you disable the encoded path.
- **Encoded path**: no 429/403 at 250 POSTs on one IP; 249 verdicts, 1 route retry, 0
  unknown. Reload the page every 100 POSTs or the tail degrades (300 POSTs without a
  reload produced 10 unknown rows after row ~158).
- 250 rows on one IP: ~8 min => **~31 rows/min per worker**, ~62/min projected with two
  workers, at ~1.2 MB per 250 rows.
- 250 is the largest clean run measured; the true per-IP ceiling is still unknown.

## Dirty IPs

Roughly one in three random resi sessions is already flagged: `ddok:false`, or 403 on the
first POST. The chunk aborts in ~10-20 s and `run-all` requeues the row, so the loss is
one row, not the chunk. There is no cheaper preflight: a POST probe costs a POST, and a
GET probe does not reveal the POST-side flag.

## Real-list run: 100 rows (2026-11-23)

First 100 rows of a 3,061-row list, encoded path, `BUDGET=250`, one worker, 6 sticky
accounts rotated by the health gate: **30 hits / 68 wrong / 1 closed**, 0 x 429, 0 x 403,
0 x 407, 0 unknown. Two runner bugs surfaced and were fixed during the run (PITFALLS #29,
#30). A clean 60-row wave inside that run held ~11 rows/min at 1.4 MB total with no IP
rotation.