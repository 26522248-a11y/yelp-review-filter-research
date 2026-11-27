# Experience notes

Hard-won, in the order they were learned. Most of the cost was not the target; it was wrong models and a 4 GB
machine.

## The cheap answer is usually at the edge, not in the UI

The first hour went into `/biz` and `/search`, both DataDome. One curl matrix later: the composer is envoy-served
and takes an encid directly. That removed 100 % of the challenge surface from the write path. Rule: before
automating a flow, enumerate the **tiers** (envoy, app, edge) and find the shortest tier that reaches the write.
The "realistic" human path is often the most protected one.

## A successful submit can be a navigation, not an API call

Hours were spent thinking the button was disabled. It was not: the click submits a native form, the page reloads,
and the SPA completes the mutation afterwards. Every clever guard (`preventDefault`, `requestSubmit`, changing the
button type) made it worse because it removed the navigation.

Signal that changed the model: wrapping `fetch` and seeing `SaveReviewDraft` and `CreateReview` fire **after** the
reload. Rule: instrument the network before theorising about React state. The network is the source of truth, not
`data-activated`.

## Validation errors are a free schema oracle

Introspection was 403. Sending one extra field per request and reading `is not defined by type` enumerated a
five-field input type in 46 requests without creating a row. This also closed every mass-assignment fantasy early
instead of after a day of payload crafting. Rule: send an invalid shape on purpose and let the server document the
schema.

## Two accounts turn "it works" into "whose object is it"

The IDOR was invisible with one account: every edit succeeds on your own review. Account B, a separate `zss`, and
A's public review encid made it a finding in one request. The restore request was equally important: it proved the
change was real and left the victim clean.

## Creation is not visibility

Six `CreateReviewSuccess` responses said nothing about whether the reviews were recommended. The own-review list
carried no badge, `/biz` was blocked, and the `/biz_photos` count oracle arrived late. Assume a 0-history account's
review is filtered until the count proves otherwise. Rule: define success at the layer the goal cares about, not at
HTTP 200.

## Burn economics

~6–7 reviews in an hour edge-flagged both profiles. Login and writes kept working, but `/biz_photos` and `/search`
403'd on every new IP. The scarce resource is profile trust at the edge, not proxy IPs. Keep one clean read
profile; post on another; stop at 5–6/hour.

## The OS fails before the target does

4 GB RAM, two agents, Chrome: free memory hit 0, PowerShell died with "paging file is too small", relay ports hit
a Windows reserved range and `listen` returned EACCES while the script continued. These look like target blocks if
you only read the log. Rule: check free MB and port errors before rotating sessions. One Chrome per agent, ports
21000–29000, abort on listen failure.

## Negative results are the map

Raw GraphQL (403), RSS (404), Jina (captcha), `/review_share` (DataDome), mass assignment (whitelist), race
(dedupe), CSRF form (403), unauth edit (downstream error), delete (no control, no docId). Each one was cheap and
removed a branch. Write them down so the next person does not re-spend the time.

## Don't inflate severity

The edit IDOR is integrity-only, authenticated, no confidentiality, no availability. That is 8.1, not 9+. A 9+
requires PR:N, delete, or a read primitive; none was reachable. Saying "9+" would have died at the first triager
question. The escalation table (`FINDINGS.md` §6) is the deliverable as much as the bug.

## What I would do differently

1. Run the path matrix before any browser run.
2. Capture the network from the first successful submit instead of guessing at UI state.
3. Keep a clean profile exclusively for reads and the count oracle.
4. Do the count A/B **before** posting six reviews and burning the account.
5. Capture the delete mutation on day one, from a throwaway review, while the profile is still clean.
6. Keep 12 000 chars of `postData` and filter by operation name; tail slices lose the interesting request.

## Transferable heuristics

- Prefer a tier that validates input but does not resolve it (fake ids) for schema work.
- Prefer a native form POST when a SPA double-fires after reload; do not guard it.
- Prefer public permalinks as an encid source when the listing page is protected.
- Prefer two identities for every object-level test; restore after mutating.
- Prefer a measured count over a badge that does not exist.
- Prefer stopping at the honest severity ceiling and documenting the next primitive.

## Scope discipline

Only two controlled accounts were used. No third-party review was edited. The one victim review was restored to
its original text and rating. Reviews posted during research are real and listed in `reference/MEASUREMENTS.md`;
they are disposable test content, not a campaign.
