# Edge matrix. Read-only. One sticky session, one request per path.
#   .\path-matrix.ps1 -ProxyUser "customer-resi_...-cc-us" -ProxyPass "..."
param(
  [Parameter(Mandatory=$true)][string]$ProxyUser,
  [Parameter(Mandatory=$true)][string]$ProxyPass,
  [string]$Encid = "cQdLIIzsExv9LF3s4s7Hzw",
  [string]$Sess = "pm$(Get-Random -Maximum 99999)"
)
$u = "$ProxyUser-sessid-$Sess-sesstime-1800"
$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
$paths = @(
  "/login",
  "/login/",
  "/search?find_desc=Coffee&find_loc=Dallas%2C+TX",
  "/biz/$Encid",
  "/writeareview/biz/$Encid",
  "/biz_photos/$Encid",
  "/rss/biz/$Encid",
  "/review_share/$Encid/review/AAAAAAAAAAAAAAAAAAAAAA"
)
foreach ($p in $paths) {
  $r = curl.exe -s -o NUL -m 40 -x "pr.oxylabs.io:7777" -U "${u}:${ProxyPass}" `
       -H "User-Agent: $ua" -w "%{http_code} %{size_download}" "https://www.yelp.com$p" 2>&1
  "{0,-48} {1}" -f $p, $r
}
