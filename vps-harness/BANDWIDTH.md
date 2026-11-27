# Bandwidth

Goal: spend as few proxy bytes as possible per verdict. Every request Chrome makes goes
through the metered proxy, so the runner removes everything the login/captcha flow does
not need and caches the rest on disk.

## What is cut

| Knob | Effect | Off switch |
|---|---|---|
| `--blink-settings=imagesEnabled=false` | no image downloads at all | `NO_MEDIA=0` |
| `--disable-remote-fonts` | no webfont downloads | `NO_MEDIA=0` |
| CDP `Fetch.failRequest` for `Image`/`Media`/`Font` | JS-inserted images/media/fonts are failed before a byte leaves Chrome | `NO_MEDIA=0` |
| `Network.setBlockedURLs` (41 hosts) | analytics, ads, tag managers, OneTrust, Google GSI | `BLOCK_URLS=0` |
| `--disk-cache-dir` per worker, 64 MB, kept between chunks | page assets are paid once per worker, not once per chunk | `CACHE_MB=0` (Chrome default cache, still per-profile) |
| first navigation after the filters are live | the very first load is already lean | when filters are enabled |
| `hydrate(4, true)` | reuses the page the `ddok` probe already loaded instead of reloading it | always on |
| `--disable-features=Prerender2,SpeculationRulesPrefetch` | no speculative page loads | always on |

## Measured (2026-11-23, direct connection, 30 s after `Page.navigate` to `/login/`)

`node runner/measure-bytes.js` with `MODE=baseline` / `MODE=lean`; delete
`%TEMP%\meas-cache-<MODE>` before the cold rows.

| Profile | Requests | Bytes | Notes |
|---|---|---|---|
| baseline (old flags) | 74 | 2.70 MB | images, fonts, GTM, Facebook, OneTrust all proxied |
| lean, cold cache | 27 | 1.52 MB | -44%; left: Yelp JS 1.16 MB + hCaptcha 0.21 MB |
| lean, warm cache (2nd chunk, same worker) | 27 | 0.08 MB | only the HTML document is re-fetched |

Per page load that is 2.70 MB with the old flags, 1.52 MB cold with the filters, and
0.08 MB warm. A full 250-row warm-cache chunk measured 1.2 MB all-in (page, 250 POSTs, 2 reloads).
Normalised to 2,500 rows, page traffic falls from ~450 MB (167 old 15-row loads) to
~2.2 MB (one cold + nine warm 250-row chunks); POST traffic adds ~1 MB per chunk.

`node runner/check-mint.js` confirms the filters do not break captcha minting: page
hydrated, widget rendered, token 1871 chars in 4.5 s.

## Reading the numbers

Each chunk writes two records worth watching:

- `{"event":"bw",...}` – which filters are active.
- `{"event":"summary",..., "bytes":..., "mb":..., "bytesPerPost":...}` – bytes actually
  pulled over the proxy for that chunk (`Network.loadingFinished.encodedDataLength`).

## Tuning

- `CACHE_DIR` – where the per-worker disk caches live (default
  `%TEMP%\yelp-cache\f<BID>`). Point it at a persistent volume to keep the cache across
  reboots; delete it to force a clean cold start.
- `CACHE_MB` – cap per worker (default 64). 32 MB is enough for this page.
- `NO_MEDIA=0` / `BLOCK_URLS=0` – only for debugging a page that fails to hydrate.

## Caveat

Blocking images means an hCaptcha *image challenge* cannot be solved. That was already
true: the runner only ever uses the passive/invisible flow, and a challenge means an empty
token, which `batch-fast.js` now refuses to POST (PITFALLS 27).
