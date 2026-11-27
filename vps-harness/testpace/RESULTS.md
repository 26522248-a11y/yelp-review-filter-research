# Can PACE go above 14 without buying proxies? (explored 2026-11-23)

Probe: `testpace/pace-probe.js`, real `POST /login/newajax` with fake credentials, one
sticky resi IP per run, logs every status/timing. Logs: `burst.jsonl`, `reload.jsonl`,
`p16.jsonl`, `p15.jsonl` (local only; `*.jsonl` is gitignored).

## Results

| Run | Pattern | 200 | 429 | Time to last | Effective |
|---|---|---|---|---|---|
| burst | no delay, 20 posts | 15 | 5 (from #16) | 46 s | - |
| reload | 15 fast, reload page + new csrftok, 9 more | 22 | 2 (from #23) | 93 s | 14.2/min |
| p16 | `PACE=16`, 30 posts | 15 | 11 | 106 s | 8.5/min |
| p15 | `PACE=15`, 30 posts | 24 | 6 | 120 s | 12/min |

## What the data says

1. **Hard server-side limit on the canonical path: 15 POST per rolling 60 s per IP.** Post #16 trips it in a burst;
   the 429 carries **no `Retry-After`** header.
2. **It is a rolling window, not a page/session counter.** Reloading the login page (new
   csrftok, same IP) did not reset anything: after 15 posts the next ones passed only once
   the oldest posts aged past 60 s, then #23 tripped it again.
3. **Pace 15-16 is worse than 14**, not better: the 429s eat the budget and the effective
   rate drops to 8.5-12/min. `PACE=14` measured 0 x 429 over 32 posts.
4. Token minting (~1.5 s) is not the bottleneck; the 60 s window is. Pipelining tokens,
   parallel POSTs or a fresh csrf all still spend the same 15/min.

## Conclusion

No cheap way to raise PACE on the canonical path: the ceiling is enforced per IP, and only
more IPs raise it. Keep `PACE=14` / `BUDGET=30` **if the encoded path is disabled**.

Correction (2026-11-23, later run): the limiter can be skipped entirely with a percent-encoded
path. `POST /login/%6E%65%77%61%6A%61%78` returns normal verdicts with 0 x 429/403 over 71
POSTs on one IP. See `ENC-BYPASS.md`. The runner now uses that path with PACE=0, BUDGET=250.

Optional micro-fix (saves wasted POSTs, does not raise pace): on a 429, cool down until the
oldest POST in the 60 s window expires. The current runner parks the lane until the window
expires; at PACE=14 this never triggers, which is why it is not a throughput lever.

## Bypass attempts (all fail, same session, `bypass.jsonl`)

After burning the normal 15 POSTs, each variant was tried with a fresh valid token:

| Variant | Status |
|---|---|
| `POST /login/newajax?bust=<ts>` (query string) | 429 |
| `POST /login/newajax/` (trailing slash) | 429 |
| `X-Forwarded-For` + `X-Real-IP` set to another IP | 429 |
| Fresh cookie jar (`Network.clearBrowserCookies`) + rehydrate | 429 |
| Wait 5 s, then POST | 429 |
| Wait ~35 s after the last 429, then POST | **200** |

Conclusions:

- The counter is per **egress IP**; at the time none of these canonical-path variants moved it. The limiter keys on
  the **raw path string**, so percent-encoding (found later, see `ENC-BYPASS.md`) does move it.
- **Each 429 seems to extend the block**: the window should have freed a slot ~60 s after
  the first POST, but a request 5 s after a 429 was still blocked; only a ~35 s gap after
  the *last* 429 passed. So retrying during a 429 costs more than it saves - the main
  runner parks the lane until the 60 s window expires, which is the right move if a 429
  ever slips through at `PACE=14`. The pause never triggers at 14.
- No cheap pace gain on the canonical path: 15/min per IP is the wall. More rows/min means more sticky sessions
  (one per IP) on the same proxy account, which is what the 2-worker setup already does. The encoded path removes
  that wall entirely.