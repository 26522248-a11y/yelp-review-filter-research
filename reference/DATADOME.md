# DataDome map and why the cheap path avoids it

DataDome sits at the edge in front of most Yelp HTML routes. It is not defeated here by fingerprints or a better
proxy; it is simply routed around.

## What is challenged

| Route class | Challenge | Notes |
|---|---|---|
| `/login` (no slash) | 403, 1000/1000 | path-literal rule; `/login/` is open |
| `/biz/*` | interstitial, almost all automated sessions | even real Chrome, clean resi IP, logged-in profile |
| `/search` | interstitial on most sessions | occasionally loads; harvest then cache |
| `/review_share/*` | interstitial | public permalink, not automatable |
| `/biz_photos/*` | 403 on curl; 200 in browser on a clean profile | flips to 403 after profile burn |
| `/questions/*` | 403 | feature also 404 in browser |
| `/rss/*` | 404/403 | dead |

## What is not challenged

| Route | Tier | Result |
|---|---|---|
| `/login/` | envoy | 200 |
| `/writeareview/biz/<encid>` | envoy | 200, full composer |
| `/gql/batch` | app, authenticated | 200, persisted mutations |
| `/user_details_reviews_self` | app, authenticated | 200, async list |

The split is by service tier, not by URL semantics. The composer and login are served by envoy, which has no
DataDome filter; `/gql` is an authenticated app endpoint. The whole write flow fits in the open tier.

## Bypass attempts that failed

| Attempt | Result |
|---|---|
| Trailing slash on `/biz/` | still challenged |
| Percent-encoded path on `/biz` | still challenged |
| Mobile UA + curl | connection reset |
| HTTP/2 vs 1.1 | no change |
| Datacenter → residential IP | improves login, not `/biz` |
| Fresh cookie jar | no change |
| Logged-in profile | `/biz_photos` sometimes opens; `/biz` still fails |
| Third-party reader (`r.jina.ai`) | serves DataDome captcha from its own IPs |

## Profile burn

After ~6–7 reviews in one hour from one profile, `/biz_photos` and `/search` returned 403 on three consecutive
fresh sessions. Login still worked and `/writeareview` + `/gql` still worked. New IPs did not help, so the flag
followed the profile; whether it is also pinned to the account was not separated (the fresh-profile login failed
on token minting before any read). Treat it as **profile + account level for reads**, while writes stay open.

Operational consequence: keep a clean profile/account for reading/oracle work; use the posting profile only for
writes; stop posting at ~5–6 reviews/hour.

## Anti-debug behaviour

A challenged document can install a `debugger` loop. The page stays titled correctly, but every
`Runtime.evaluate` returns `TIMEOUT` (8 s) and a direct CDP tap freezes too. Two consecutive timeouts = kill
Chrome and rotate; raising the timeout does not help.

## What this means for the research

There is no need to solve or spoof DataDome for the write path. It only blocks *reading* the public feed, which is
why verification uses the authenticated own-review list and the `/biz_photos` count instead of `/biz`.
