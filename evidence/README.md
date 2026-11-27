# Evidence

Run logs were ephemeral (`runs-recon/flow.log`, overwritten per run and deleted at cleanup). The files here are
transcriptions of the relevant records and HTTP bodies, kept because the repo must stand without the logs.

Provenance: `runs-recon/flow.log` from the runs of 2026-11-26/27, and `runs-recon/report-idor.md`. Formatting is
normalised (pretty-printed JSON, `…` for omitted text); no field values were altered. Encids are real and
resolvable while the reviews exist.

| File | Proves |
|---|---|
| `create-review-success.txt` | `CreateReview` works, no captcha, review encid returned |
| `idor-success.txt` | B edited A's review; `EditReviewSuccess` |
| `idor-restore.txt` | B restored A's review; stable, not a fluke |
| `idor-unauthenticated.txt` | no-cookie attempt fails downstream |
| `race.txt` | dedupe under 5 concurrent posts |
| `schema-whitelist.txt` | 5-field input types |
| `oracle-count.txt` | `/biz_photos` header count (recommended count) |

Accounts: A = `duatravelsuk@gmail.com`, B = `wisejayc@gmail.com`. Both controlled.
