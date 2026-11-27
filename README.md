# Yelp review pipeline: filter map, cheap write path, EditReview IDOR

Field notes and a working harness for putting reviews on `www.yelp.com` without DataDome, without a captcha
solver, and without a browser-fingerprint budget — plus the security audit that came out of it.

Measured on production `www.yelp.com`, 2026-11-26/27, two controlled accounts, Oxylabs residential sticky
sessions. Every number below comes from a recorded run; the raw-ish evidence is in `evidence/`.

| Result | Measured |
|---|---|
| `POST /gql/batch` `CreateReview` | success, **~2 s**, no captcha, no DataDome |
| Composer `GET /writeareview/biz/<encid>` | 200, full form, **no DataDome** (envoy) |
| `GET /biz/<encid>`, `GET /search` | DataDome 403 on most sessions — avoided entirely |
| Review creation, UI path | 4 reviews, all `CreateReviewSuccess` |
| Cross-account edit (IDOR) | **confirmed**, `EditReviewSuccess` twice, severity 8.1 |
| Duplicate submit, 5 concurrent | dedupe enforced: 1 success / 3 rejected |
| Input fields accepted by `CreateReview` | **5** (strict whitelist); 44 candidates rejected |
| Account with 0 review history | review lands in "Not currently recommended" — not fixable client-side |

**The cheap path:** never open `/biz` or `/search`. Harvest a business `encid` once, open
`/writeareview/biz/<encid>` (or call the persisted GraphQL mutation directly from any authenticated page), post.
No captcha appears on this path at all.

**The "immortal" answer:** recommendation is recomputed server-side from account trust, content, photos and
velocity. No request field sets it. The only reliable lever is an aged/warmed account; see `FINDINGS.md` §4.

**The bug:** `EditReview` trusts `reviewEncid` without binding it to the session user, so any logged-in account
can rewrite any review if it knows the encid (and encids are public in share URLs). `FINDINGS.md` §6 and
`evidence/idor-success.txt`.

## Read order

1. `HANDOFF.md` — state transfer: what is proven, what is open, live infrastructure, exact commands, traps.
2. `FINDINGS.md` — everything measured, with method, evidence and honest severity.
3. `SKILL.md` — operating runbook for `runner/flow.js`.
4. `reference/METHOD.md` — how each finding was reached, including dead ends.
5. `reference/PITFALLS.md` — 25 failure modes, symptom → cause → fix. Read before running anything.
6. `reference/MEASUREMENTS.md`, `reference/SCHEMA.md`, `reference/DATADOME.md`.
7. `vps-harness/` — the original credential-pipeline repo, **byte-for-byte unchanged**, for the login/hCaptcha
   mechanics this work builds on.

## Files

```
HANDOFF.md                  start here
FINDINGS.md                 protection map, write path, filter model, IDOR, negative results
SKILL.md                    runbook: stages, env, acceptance checks
EXPERIENCE.md               what was cheap, what wasted time, how not to fool yourself
runner/flow.js              the only tool: login / review / api / idor / probes
reference/METHOD.md         research chronology and principles
reference/PITFALLS.md       failure catalogue
reference/MEASUREMENTS.md   rates, counts, session outcomes
reference/SCHEMA.md         GraphQL operations, documentIds, input types, errors
reference/DATADOME.md       edge map and bypass rationale
testpace/http/              reproducible curl matrices
testpace/probes/            single-purpose probe notes and jobs
evidence/                   transcribed request/response proof (logs were ephemeral)
vps-harness/                original repo, untouched: README, SKILL, PERF, BANDWIDTH, reference, runner, testpace, examples
```

## Requirements

- Windows 10/11, PowerShell 5.1, Node >= 22, Chrome at the default path.
- Oxylabs-style sticky proxy (`customer-<type>_<id>-cc-us:pass`); 407 = account quota, not a Yelp block.
- 4 GB RAM is the practical floor: one headful Chrome at a time. Two only if nothing else runs.
- Accounts: two controlled accounts were used; both are disposable. See `HANDOFF.md` for status.

## Quick start

```powershell
$env:PU_BASE="customer-resi_...-cc-us"; $env:PW="..."
$env:EMAIL="..."; $env:PASS="..."; $env:PROFILE=".\profiles\a"; $env:ATTEMPTS="3"
$env:STAGE="login"; node runner\flow.js

$env:STAGE="api-post"; $env:ENCID="<22-char>"; $env:RATING="5"
$env:TEXT_FILE=".\testpace\review.sample.txt"; node runner\flow.js
```

`zss` is session-only; every stage must run in the same browser session as the login. `flow.js` does this in
one process. Logs default to `runs-recon/flow.log` (JSONL).

## Status / caveats

- The IDOR is proven; the delete/resurrection path is **not** — `DeleteReview` was never captured, so 9+ is open.
- The filter oracle (`/biz_photos` header count) works, but the A/B run was cut short when the posting profile was
  edge-flagged after ~6 reviews in an hour. The +1/−1 count experiment is the top open lead.
- Account passwords and proxy credentials were live at the time of writing and are published in `HANDOFF.md`.
- Reviews posted during research are real and remain on the businesses listed in `FINDINGS.md` §9.
