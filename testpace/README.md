# testpace

Reproduction material. Nothing here is required to read the findings.

- `http/path-matrix.ps1` — the edge matrix that found the open composer. Bare curl, one session, read-only.
- `http/count-oracle.ps1` — read `rating (N reviews)` on `/biz_photos` (requires a logged-in browser; the curl
  version is blocked, so this shells out to `flow.js STAGE=counts`).
- `http/api-post.ps1` — one `CreateReview` through `flow.js`.
- `http/idor.ps1` — cross-account `EditReview` through `flow.js`.
- `probes/README.md` — stage ↔ hypothesis table, including the ones that failed.
- `review.sample.txt` — 150-word review with concrete detail and one mild negative; matches the content rules.
- `jobs.sample.json` — `api-batch` job format.
- `photo.jpg` — not included; supply any unique image for the photo-lift test.

Common env for the wrappers:

```powershell
$env:PU_BASE="customer-resi_…-cc-us"; $env:PW="…"
$env:PROFILE=".\profiles\b"; $env:EMAIL="…"; $env:PASS="…"
```

Every wrapper assumes a profile that is already logged in. Run `STAGE=login` first.
