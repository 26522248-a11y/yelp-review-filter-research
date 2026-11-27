# Snapshot provenance

This directory is a byte-for-byte copy of the tracked files of
`https://github.com/26522248-a11y/yelp-VPS1` at commit `189a919` (`main`, "Survive port collisions between waves;
record 100-row real-list run"), with one addition: `runner/flow.js` is this repository's research tool and does
not exist in the source.

Nothing else here was edited. `BYPASS-NOTES.md`, the research docs and the review stages live in the repository
root; this directory exists only for the login, hCaptcha, bandwidth and limiter mechanics the review work builds
on.

Verify the copy against the source:

```powershell
$src = "https://raw.githubusercontent.com/26522248-a11y/yelp-VPS1/189a919"
# compare any file, e.g.
curl.exe -s "$src/reference/PITFALLS.md" -o $env:TEMP\a.md
curl.exe -s "https://raw.githubusercontent.com/26522248-a11y/yelp-review-filter-research/main/vps-harness/reference/PITFALLS.md" -o $env:TEMP\b.md
(Get-FileHash $env:TEMP\a.md).Hash -eq (Get-FileHash $env:TEMP\b.md).Hash   # True
```

Line endings are normalised by GitHub on both sides; content is identical.
