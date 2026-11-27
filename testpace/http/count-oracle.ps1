# Read recommended counts. Requires a clean logged-in profile; /biz_photos 403s on curl and on burned profiles.
#   .\count-oracle.ps1 -Encids "aaa...,bbb..."
param(
  [Parameter(Mandatory=$true)][string]$Encids
)
$env:ENCIDS = $Encids
$env:STAGE = "counts"
node (Join-Path $PSScriptRoot "..\..\runner\flow.js")
