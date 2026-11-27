# Yelp credential pipeline

Fast and stable credential validation against `www.yelp.com`: encoded-endpoint bypass of the routing limiter, invisible
hCaptcha inside a real browser, no solver, 250 rows per IP, 2 workers, per-chunk proxy health gate.

| Metric | Measured |
|---|---|
| Per credential | ~1.9 s (250-row run) |
| Rows per minute | ~31 per worker |
| 429 / 403 on 250 encoded POSTs, one IP | 0 / 0 |
| Hit rate on used combo lists | ~1.2 % |

## Why it is stable

Five failure modes are designed out:

1. **Wrong captcha field** - `hcaptcha_response`, not `h-captcha-response`. The wrong name looks exactly like a
   rejected token.
2. **Wrong IP budget** - 250 POST per IP. The canonical path 429s at 15/min and 403s near 30 rows; the encoded path
   skips both (250 POSTs measured on one IP, 249 verdicts, 0 unknown).
3. **Too many browsers** - 2 workers. A third starves on 4 GB RAM and yields 0 verdicts.
4. **Full temp disk** - profile deleted on exit, hard stop below 2 GB free. A full disk looked like DataDome for hours.
5. **Dead accounts reused** - every chunk health-gates a fresh session first; non-200 accounts are skipped and the
   run stops instead of burning the rest of the list.

## Bandwidth

All page traffic is paid for by the metered proxy, so the runner drops what the login/captcha flow does not need:
images, media, fonts and 41 analytics/ad hosts are failed locally, and a persistent per-worker disk cache means
only a worker's first chunk pays the full page cost.

| Run | Proxy bytes |
|---|---|
| Old flags, per 15-row page load | ~2.7 MB page assets |
| This build, cold page load | ~1.5 MB page assets |
| This build, warm page load | ~0.08 MB page assets |
| This build, full 250-row chunk, warm cache | ~1.2 MB all-in (incl. 250 POSTs) |

The first chunk on a worker pays the cold page on top of POST traffic; later chunks reuse the cache.
Normalised to 2,500 rows, page traffic drops from ~450 MB to ~2.2 MB. Details and knobs (`NO_MEDIA`,
`BLOCK_URLS`, `CACHE_MB`, `CACHE_DIR`): [BANDWIDTH.md](BANDWIDTH.md).
Each chunk's `summary` record now carries `bytes`, `mb`, `bytesPerPost`; `runner/measure-bytes.js` reproduces the
numbers without touching a proxy.

## Requirements

- Windows 10/11, PowerShell 5.1.
- **Node >= 22** (global `fetch`, `WebSocket`, `statfsSync`).
- Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` or `$env:CHROME`.
- Oxylabs-style sticky proxy accounts, `customer-<type>_<id>-cc-us:<password>` (`mobile` and `resi` both work), one
  per line.
- 4 GB RAM, >= 2 GB free disk.

`407 traffic limit reached` is the Oxylabs account quota, not a Yelp block. Expect to rotate accounts.

## Run

```powershell
# proxies.txt = user:pass per line; combo.txt = email:password per line
.\runner\check-proxy.ps1 -Accounts (Get-Content .\proxies.txt)
.\runner\smoke.ps1 -PoolFile .\proxies.txt
.\runner\run-all.ps1 -Source .\combo.txt -PoolFile .\proxies.txt -Take 500 -Chunk 250 -Workers 2
.\runner\report.ps1  -RunDir .\runs -HitsFile .\hits.txt -OutCsv .\classified.csv
```

Results: `runs/<batch>/w*.jsonl` (evidence), `runs/progress.jsonl`, `runs/state.txt` (resume), `runs/missed.txt`
(rows from an out-of-order dead chunk, deduplicated). Re-run the queue as a normal source:

```powershell
.\runner\run-all.ps1 -Source .\runs\missed.txt -PoolFile .\proxies.txt -Root .\runs\retry
```

Three consecutive 0-row waves stop the run without moving `state.txt`.

## Validity

`valid` = `success: true` + `zss` cookie (>=20 chars) + `GET /profile` 200. `"incorrect"` with `error_fields` is a
server-compared rejection. `closed` means the email exists but the account is closed. Link/unable/403/407/429 are
unresolved, never "invalid".

## Files

```
SKILL.md                    full method, constants, prerequisites, verification, failure playbook
PERF.md                     throughput ceiling: encoded-path measurements, canonical comparison
BANDWIDTH.md                proxy-byte reductions and the knobs that control them
runner/batch-fast.js        worker (Chrome + relay + CDP + token factory + fetch)
runner/pool.ps1             2-worker orchestrator, 250-row chunks, account health gate
runner/run-all.ps1          resumable full-list runner, missed queue, dead-pool stop
runner/check-proxy.ps1      session health gate
runner/smoke.ps1            6-row post-change acceptance test
runner/report.ps1           verdict aggregation, CSV + hits export
runner/measure-bytes.js     page-byte measurement, direct connection
runner/check-mint.js        confirms the bandwidth filters do not break token minting
runner/bw-blocklist.js      analytics/ad hosts failed locally before any proxy byte
reference/MEASUREMENTS.md   measured rates and limits
reference/PITFALLS.md       failure catalogue, 28 modes, symptom -> fix
testpace/                   encoded-path probes and the full measurement write-up
examples/                   sample list, proxy file, redacted evidence record
```

Sample files use fake credentials; real lists are gitignored.
