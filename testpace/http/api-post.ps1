# One CreateReview through the running tool. Profile must already be logged in.
#   .\api-post.ps1 -Encid "..." -Rating 5 -TextFile "..\review.sample.txt"
param(
  [Parameter(Mandatory=$true)][string]$Encid,
  [int]$Rating = 5,
  [string]$TextFile = (Join-Path $PSScriptRoot "..\review.sample.txt")
)
$env:ENCID = $Encid
$env:RATING = "$Rating"
$env:TEXT_FILE = (Resolve-Path $TextFile).Path
$env:STAGE = "api-post"
node (Join-Path $PSScriptRoot "..\..\runner\flow.js")
