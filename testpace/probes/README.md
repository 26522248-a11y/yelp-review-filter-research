# Probes

All probes are stages in `runner/flow.js`; there are no separate throwaway scripts. Each one maps to a hypothesis
and a cost.

| Stage | Hypothesis | Cost | Result |
|---|---|---|---|
| `api` | mutation names live in JS bundles | 1 page, 4 chunk fetches | no `DeleteReview` hit |
| `probe2` | review card shows an NR badge | 1 page | no badge |
| `fuzz` / `fuzz2` | CreateReview accepts moderation fields | 44 requests, 0 rows | 5-field whitelist |
| `fuzz3` | EditReview accepts injected fields | 14 requests | 5-field whitelist |
| `race` | dedupe is SELECT-then-INSERT | 1 business, 5 POSTs | dedupe enforced |
| `editprobe` | capture EditReview docId from UI | 1 edit | docId captured |
| `formpost` | legacy form allows backdating | 1 POST | 403 CSRF |
| `surfaces` | other public content surfaces | 4 pages | only photos/collections alive |
| `counts` | `/biz_photos` leaks recommended count | 1 page per id | confirmed |
| `resurrect` | an edit forces re-moderation | 2 page reads + 1 edit + 2 min | blocked by burn |
| `delprobe` | review card has a Remove menu | 1 page | no control found |

## Hypotheses that died

- **`DeleteReview` is in the persisted-query bundle.** No. The bundle only hashes; the operation name is not
  embedded.
- **Raw GraphQL is available.** No. 403; persisted only.
- **A review encid can be guessed from the business encid.** No. 22 random chars, needs a share URL or an
  authenticated feed.
- **More reviews per hour is better.** No. ~6/hour flipped both profiles to edge 403 on reads.
- **The filter status is readable on the own-review list.** No. No badge; only the `/biz_photos` count works.

## Next probes to build

1. A menu-dump that captures `DeleteReview` even if the control is in a portal outside the card.
2. A `GetBusinessReviewFeed` harvest that snapshots every `/gql` documentId while `/biz` loads.
3. A mobile-web pass (`m.yelp.com`) for delete and feed.
