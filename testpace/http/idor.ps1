# Cross-account EditReview. Account in PROFILE must differ from the review owner.
#   .\idor.ps1 -ReviewEncid "..." -BizEncid "..." -TextFile "..\review.sample.txt"
param(
  [Parameter(Mandatory=$true)][string]$ReviewEncid,
  [Parameter(Mandatory=$true)][string]$BizEncid,
  [string]$TextFile = (Join-Path $PSScriptRoot "..\review.sample.txt"),
  [int]$Rating = 5
)
$env:REVIEW_ENCID = $ReviewEncid
$env:BIZ_ENCID = $BizEncid
$env:RATING = "$Rating"
$env:TEXT_FILE = (Resolve-Path $TextFile).Path
$env:STAGE = "idor"
node (Join-Path $PSScriptRoot "..\..\runner\flow.js")
