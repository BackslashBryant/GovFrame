# Control Atlas Pulse — Implementation Plan (v1.0)

- **Owner:** Product owner
- **Status:** Active
- **Last reviewed:** 2026-09-06
- **Supersession:** This is the single retained active plan. Update it when the
  source matrix, lane model, or phase boundaries change; never create a second
  Pulse plan beside it, and delete it in the shipping change that completes the
  work it describes.

**This document authorizes no implementation.** It is a plan. Building Pulse is
a separate decision, and §14 lists what the creator must settle first.

> Filed at `docs/Plan.md` rather than `docs/plans/pulse-implementation.md`:
> `tests/alignment-contract.test.mjs` allows `docs/` to hold the canonical
> document set plus exactly one active plan at this path. A `docs/plans/`
> directory fails `npm test`. See §15.6.

> **Guiding principle:** Control Atlas is the authoritative map; Pulse is the weather.
> Pulse never invents. It aggregates, correlates and explains what publishers,
> maintainers and communities have already said, and it links back to them.

---

## 0. Executive summary for the reviewer

Pulse fits this repository better than it might first appear, because the hard
parts already exist:

- A **scheduled network-fetch job** (`refresh` in `.github/workflows/ci.yml`)
  that holds credentials, uses conditional HTTP, and opens a **draft pull
  request** of `data/**` for human review before anything ships.
- A **source registry** (`data/source-registry.json`) whose per-source record
  already carries `provenance_class`, `license_or_use`, `access_status`,
  `lifecycle_status`, `checksum` and — critically — **`graph_eligible`**.
- A **freshness ledger** (`source-registry.json → freshness.sources[]`) with
  `last_checked`, `last_imported` and `hash` per source. Lane 1 is largely a
  *presentation* of data the pipeline already produces.

Three things fight the brief and are called out in full in §3 and §14:

1. **Reddit in the MVP is the one genuinely unresolved item.** Not the
   credentials — those are solvable — but the Reddit Data API terms around
   storing and redisplaying user content. This needs a creator decision, and
   possibly legal review, before it is built.
2. **Pulse timestamps fight the reproducibility gate.**
   `npm run verify:generated-reproducibility` requires byte-identical rebuilds.
   Pulse must derive time from committed snapshots, never from `Date.now()`.
3. **`pulse-search.json` must shard.** `scripts/check-data-size.mjs` enforces
   a 320 KB gzip ceiling per search shard.

---

## 1. Architecture fit

### 1.1 Where Pulse sits in the existing pipeline

The current shape, and where Pulse attaches:

```
                    ┌─────────────────────────────────────────┐
  SCHEDULED ONLY    │ ci.yml  job: refresh  (cron 17 7 * * 3) │
  (has secrets)     │   npm run refresh:data                  │
                    │   → strict conditional HTTP             │
                    │   → writes data/** snapshots            │
                    │   → create-pull-request (DRAFT)         │  ← human review
                    └──────────────────┬──────────────────────┘
                                       │  merged by a person
                    ┌──────────────────▼──────────────────────┐
  EVERY BUILD       │ npm run build:data                      │
  (no secrets,      │   build-framework-data, taxonomy,       │
   no network)      │   discovery-index, …                    │
                    │   ★ build-pulse-events.mjs  (NEW)       │
                    └──────────────────┬──────────────────────┘
                    ┌──────────────────▼──────────────────────┐
                    │ npm run build:site → dist/site          │
                    │   gzip, verify-site-artifact            │
                    └──────────────────┬──────────────────────┘
                    ┌──────────────────▼──────────────────────┐
                    │ Control Atlas Deploy → GitHub Pages     │
                    └─────────────────────────────────────────┘
```

**The one-sentence rule:** *Pulse fetches on a schedule inside CI with secrets
and human review; Pulse builds from committed snapshots with no network at all.*

This mirrors exactly how every existing source already works, and it is the
only shape that satisfies static-only + no-secrets-in-a-public-build.

### 1.2 Files Pulse touches

| Concern | Existing file | Pulse change |
| --- | --- | --- |
| Fetch orchestration | `scripts/refresh-data.mjs` | register new fetch tasks |
| Conditional HTTP | `scripts/lib/strict-conditional-fetch.mjs` | reuse unchanged |
| Refresh contract | `data/source-refresh-contract.json` | add `tasks[]` entries |
| Contract validation | `scripts/lib/source-refresh-contract.mjs` | reuse; it validates tasks against the registry and the workflow text |
| Source registry | `data/source-registry.json` | add Pulse sources with `graph_eligible: false` |
| Deterministic time | `scripts/lib/stable-generated-at.mjs` | reuse for all Pulse timestamps |
| Atomic writes | `scripts/lib/write-json-atomically.mjs` | reuse |
| Data build chain | `package.json → build:data` | append `build-pulse-events.mjs` |
| Size budget | `scripts/check-data-size.mjs` | add a Pulse search-shard budget check |
| Runtime loading | `src/ui/lib/runtimeLoader.ts` | route-gated `add(artifactPath("pulse-*.json"))` |
| Routes | `src/ui/lib/routeIdentity.ts` | new `pulse` AppView + params |
| Record page | `src/ui/pages/ObjectDetailPage.tsx` | new `data-record-section="pulse-activity"` |
| Page contract | `docs/PAGE_CONTRACTS.md` | new section for Pulse |
| Data policy | `docs/DATA_POLICY.md` | Pulse boundary clause |

### 1.3 Boundary enforcement — "informational only"

The requirement that Pulse never influences the graph is enforced structurally,
not by convention:

1. **Registry flag.** Every Pulse source is registered with
   `graph_eligible: false` and `provenance_class: "pulse_aggregated"` (new
   class). The graph builders already filter on `graph_eligible`.
2. **Separate artifacts.** Pulse writes only `pulse-*.json`. It never writes
   `nodes.json`, `edges.json`, `evidence.json`, `atlas-spine.json` or
   `atlas-network.json`.
3. **One-way reference.** Pulse events reference `record_ids`. No record, node
   or edge ever references an `event_id`. The reference direction is the
   guarantee.
4. **A contract test** (`tests/graph/pulseBoundary.test.ts`, new) asserts:
   - no Pulse source has `graph_eligible: true`;
   - the node/edge/evidence artifact hashes are byte-identical with Pulse
     artifacts present and absent;
   - no `event_id` appears anywhere in the graph artifacts;
   - `build-pulse-events.mjs` writes only paths matching `pulse-*`.

Item 4's second assertion is the strong one: it makes "Pulse changed the graph"
a build failure rather than a review question.

---

## 2. The four lanes

| Lane | Name | Badge | Source of truth | Retention |
| --- | --- | --- | --- | --- |
| 1 | Control Atlas Detected Changes | `CONTROL ATLAS DETECTED` | This repo's own pipeline | forever |
| 2 | Official Updates | `OFFICIAL SOURCE` | Publisher feeds/APIs | forever |
| 3 | Community Pulse | `COMMUNITY DISCUSSION` | Reddit, GitHub Discussions, lists | 180 days |
| 4 | Ecosystem Releases | `TOOL ECOSYSTEM` | Tool release feeds | 365 days |

Lanes are **visually and structurally** separated: distinct containers, distinct
badges, never interleaved in one list, and never merged by a sort. A reader must
never have to check a badge to know whether they are looking at NIST or Reddit.

### 2.1 Lane 1 is nearly free

Lane 1 does not need new network access. It is derived from artifacts the
pipeline already writes:

| Event type | Derived from |
| --- | --- |
| `source_version_changed` | `source-registry.json → sources[].version` delta |
| `source_hash_changed` | `freshness.sources[].hash` delta |
| `publication_added` / `_removed` | `publications[]` set delta |
| `stig_updated` | `fetch-disa-stigs.mjs` / `fetch-stig-source-observations.mjs` output delta |
| `relationship_added` / `_removed` | `edges.json` count and id-set delta |
| `parser_improved` / `parser_failed` | ingestion stage ledger (`data/generated/ingestion-stage-ledger.json`) |
| `source_unavailable` | `source-registry.json → quarantine[]` and `access_status` |

Deltas are computed between the **previous committed** artifact and the current
one. `scripts/report-refresh-diff.mjs` already does a version of this for the
refresh PR body and is the natural starting point.

**This makes Lane 1 the correct MVP starting point:** highest trust, zero new
external dependencies, no licensing questions, no credentials.

---

## 3. Feasibility: the honest section

### 3.1 CSP forbids all client-side fetching — this is settled

`src/index.html` ships:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'
```

`connect-src 'self'` means the browser **cannot** call Reddit, GitHub, NIST or
anything else. `tests/browser-contract.test.mjs:275` asserts the CSP is present.
The brief says "CSP unchanged", and that is achievable — but only because every
byte Pulse renders is fetched at build time and served from our own origin.

**Consequence:** there is no "live" Pulse. Freshness is bounded by the refresh
cadence (currently weekly). The UI must state the retrieval time honestly rather
than implying real-time. See §9.4.

### 3.2 Where credentials live

| Option | Verdict |
| --- | --- |
| Client-side (in the bundle) | **Impossible and unsafe.** Blocked by CSP; a public repo would leak the secret. |
| GitHub Actions secrets, used only in the `refresh` job | **Correct.** This is the existing pattern. |
| Committed to the repo | Never. |

The `refresh` job already runs with `GITHUB_TOKEN: ${{ github.token }}`. Reddit
credentials would be added as repository secrets (`PULSE_REDDIT_CLIENT_ID`,
`PULSE_REDDIT_CLIENT_SECRET`) and referenced only in that job. They never enter
`dist/site`, and a build without them must degrade rather than fail (§8.2).

A verification test should assert no `PULSE_*` secret name and no token-shaped
string appears in `dist/site` — cheap insurance against a future mistake.

### 3.3 GitHub API — workable

- **Auth:** `GITHUB_TOKEN` in the `refresh` job. Already present.
- **Rate limits (verify at implementation time):** `GITHUB_TOKEN` in Actions is
  limited per repository per hour — on the order of 1,000 REST requests/hour;
  a PAT is higher. GraphQL (needed for Discussions) uses a separate points
  budget. A weekly job polling a few dozen repositories is far inside any of
  these.
- **Releases:** REST `GET /repos/{owner}/{repo}/releases` — clean, well
  documented, and the natural Lane 4 source.
- **Discussions:** GraphQL only. Heavier to implement than Releases.
  **Recommendation: move GitHub Discussions to Phase 2** and ship Lane 3 in the
  MVP with GitHub *Issues* (REST, much simpler) if a community lane is required
  at MVP at all.

### 3.4 Reddit — the genuine MVP risk

This is the item I cannot resolve without a decision from the creator.

- **Technical access** is solvable: OAuth2 client-credentials against
  `https://oauth.reddit.com`, a declared descriptive `User-Agent`, secrets in
  Actions. Free-tier limits (on the order of 100 queries/minute per OAuth
  client, far above what a weekly job needs) are not the problem.
- **The terms are the problem.** Reddit's Data API terms constrain storing and
  redisplaying user content, and draw a line between non-commercial and
  commercial use. Pulse would store titles, short summaries, URLs, authorship
  metadata and timestamps, and redisplay them on a public site — squarely the
  activity those terms govern.
- **Retention** (180 days) helps but does not by itself resolve the terms
  question.

**Three options, for the creator to choose:**

| Option | Description | Consequence |
| --- | --- | --- |
| **A. Defer Reddit to Phase 2** *(recommended)* | Ship MVP with Lanes 1, 2, 4 and GitHub Issues for Lane 3 | No legal exposure; MVP ships sooner; Lane 3 is thinner |
| **B. Link-only Reddit** | Store title + URL + date + subreddit; **no summary, no body, no author** | Lower exposure; still needs a terms read; weakest lane content |
| **C. Full Reddit in MVP** | As briefed | Requires an explicit accept-the-risk decision, ideally with legal review |

Do not treat this as a technical task with a technical answer. It is a policy
decision that happens to have a technical implementation.

### 3.5 Determinism vs. time-varying data — a real conflict

`npm run verify:generated-reproducibility` rebuilds generated data from a clean
state and compares a SHA-256 over every file. Any wall-clock value in a Pulse
artifact breaks it, and it is a required CI gate.

`scripts/lib/stable-generated-at.mjs` exists for exactly this reason: it derives
`generated_at` from committed source metadata keys (`last_checked`,
`retrieved_at`, `observed_at`, `snapshot_date`, `lastUpdated`).

**Rule for Pulse:** every timestamp written into a `pulse-*.json` artifact must
come from the committed snapshot, never from `Date.now()`:

- `published_at` — from the feed item.
- `retrieved_at` — from the snapshot's recorded fetch time, committed by the
  refresh PR.
- `generated_at` — via `stable-generated-at.mjs`.
- Retention windows (§11) must be computed against the **snapshot's** newest
  `retrieved_at`, not the current date, or two builds of the same commit will
  prune different events.

This is the single most likely way an otherwise correct implementation fails CI.

### 3.6 Size budgets

- `scripts/check-data-size.mjs` rejects any file in `data/generated` over
  **20 MiB**.
- Search shards are capped at **320 KB gzip** (`MAX_COMPLETE_SEARCH_GZIP_BYTES`).

`pulse-events.json` will stay small (thousands of events × ~1 KB). `pulse-search.json`
**must be sharded** using the same `sharded_collection` manifest pattern as
`library-search-index.json` (`scripts/build-framework-data.mjs:4082-4118`), and
`check-data-size.mjs` must gain
`checkSearchShardBudget("pulse-search.json", "Pulse search shard")`.

---

## 4. Data model

### 4.1 Event schema

```jsonc
{
  "event_id": "sha256:…",        // deterministic; see §4.2
  "source_type": "rss | api | github_releases | pipeline_delta",
  "lane": 1 | 2 | 3 | 4,
  "publisher": "NIST",
  "title": "…",                   // verbatim from source, sanitized
  "summary": "…",                 // ≤ 320 chars, truncated at a word boundary
  "url": "https://…",             // canonical source; required
  "published_at": "2026-08-14T00:00:00Z",
  "retrieved_at": "2026-08-20T07:17:00Z",
  "record_ids": ["nist-800-53:AC-2"],
  "frameworks": ["nist-800-53"],
  "technologies": ["windows"],
  "products": ["Windows Server 2022"],
  "severity": "informational | low | moderate | high | critical | null",
  "event_type": "publication_released | draft_opened | comment_period |
                 source_version_changed | tool_release | discussion | …",
  "match_reason": "contains AC-2 identifier; published by NIST; references the Access Control family",
  "confidence": 0.0,              // derived from tier; see §6.4
  "tags": ["access-control"],
  "hash": "sha256:…",             // content hash for dedupe
  "version": 1,                   // schema version
  "review_status": "auto | reviewed | suppressed"
}
```

Field notes:

- **`summary`** is the copyright-sensitive field. §10 governs it.
- **`severity`** is `null` unless the publisher states one. Pulse never infers
  severity — that would be inventing.
- **`match_reason`** is human-readable prose, generated from the tier rules, and
  is **mandatory**. An event that cannot explain why it matched is rejected.
- **`review_status`** maps onto the existing draft-PR review model: events
  arrive `auto`; a human may mark `reviewed` or `suppressed` in a curated
  overlay file (`data/curated/pulse-suppressions.json`) that survives rebuilds.

### 4.2 Deterministic identity and dedupe

- `hash = sha256(canonical_url + "\n" + normalized_title + "\n" + published_at_date)`
- `event_id = "sha256:" + hash` — no random ids, no counters. The same source
  item always produces the same id, which is what makes rebuilds byte-identical
  and dedupe trivial.
- Canonicalization before hashing: lowercase host, strip `utm_*`/`ref`/
  `fbclid` query params, strip fragments, strip trailing slash, resolve known
  shorteners only if the expansion was captured at fetch time.
- Cross-source dedupe: same `hash` → keep the highest-trust lane (1 > 2 > 4 > 3),
  and record the dropped duplicates' publishers in `tags` so nothing silently
  disappears.

### 4.3 Source matrix schema

Every Pulse source is described in `data/curated/pulse-sources.json`, and
**also** registered in `data/source-registry.json` so it inherits the existing
provenance machinery:

```jsonc
{
  "id": "nist-csrc-news",
  "publisher": "NIST",
  "official": true,
  "community": false,
  "lane": 2,
  "transport": "rss",              // rss | atom | json_api | graphql | pipeline
  "endpoint": "https://…",
  "license": "US Government work — public domain (17 U.S.C. §105)",
  "terms_url": "https://…",
  "retention_days": null,           // null = forever
  "rate_limit": "unauthenticated; polite weekly poll",
  "auth": "none | github_token | oauth_client_credentials",
  "poll_interval": "weekly",
  "freshness_sla_days": 14,
  "enabled_phase": 1
}
```

### 4.4 The six generated files

| File | Contents | Consumer | Sharded |
| --- | --- | --- | --- |
| `pulse-events.json` | Full event records, newest first | `/pulse`, record blocks | no |
| `pulse-search.json` | Tokenized index: event_id → terms, record_ids | Pulse search | **yes** |
| `pulse-topics.json` | Topic profile → event_ids (the match index) | record blocks | no |
| `pulse-timeline.json` | Date-bucketed event_ids per framework | Timeline view | no |
| `pulse-trending.json` | Ranked topics with the inputs that produced them | Trending | no |
| `pulse-statistics.json` | Build report (§8.3) + lane/publisher counts | Pulse home, ops | no |

`pulse-topics.json` is the important one for performance: the record page must
not scan every event. It is a precomputed inverted index keyed by `record_id`,
so `ObjectDetailPage` does an O(1) lookup and then fetches at most 10 events.

---

## 5. Retention and pruning

| Lane | Retention | Rationale |
| --- | --- | --- |
| 1 Detected changes | forever | Our own history; small; audit value |
| 2 Official | forever | Public-domain government works; permanent record |
| 3 Community | **180 days** | Terms and relevance both argue for a window |
| 4 Tool releases | **365 days** | Older releases are superseded |

Pruning runs at build time against the snapshot's newest `retrieved_at` (§3.5).
Pruned events are counted in `pulse-statistics.json` so a silent mass-prune is
visible in the build report.

---

## 6. The Topic Profile engine

Build-time, deterministic, no ML at runtime, no network.

### 6.1 Profile construction

For each record, a profile is assembled **only from existing governed data** —
never invented:

| Field | Source |
| --- | --- |
| `identifiers` | record id, publisher-native id (`AC-2`), normalized variants (`AC 2`, `AC-02`) |
| `publication` | `catalog-structure.mjs` / record location |
| `framework` | publication id |
| `control_family` | containment parent (e.g. "Access Control") |
| `aliases` | `data/curated/pulse-topics.json` (authored, reviewed) |
| `technologies` / `products` | STIG benchmark titles, existing taxonomy registry |
| `abbreviations` | authored alias list |
| `excluded_terms` | authored deny list (e.g. `AC2 battery`, `AC/DC`) |

Aliases and exclusions are **authored and reviewed**, like
`data/curated/framework-lenses.json`. Each entry carries a rationale. This is
the one place Pulse makes a judgement, and it is explicit, versioned and
testable rather than buried in a regex.

### 6.2 Identifier normalization

`AC-2` must match `AC-2`, `AC 2`, `AC.2`, `AC-02`, `AC-2(1)` (as the enhancement,
not the base), and must **not** match `AC-20`, `MAC-2`, `AC2 battery`, or `AC-2`
inside a URL slug of an unrelated product. Word-boundary anchored, case
insensitive, with the exclusion list applied **after** matching and before
scoring.

### 6.3 Ranking tiers

| Tier | Rule | Confidence | Example `match_reason` |
| --- | --- | --- | --- |
| 1 | Exact identifier in title or summary | 0.95 | "contains the AC-2 identifier" |
| 2 | Same publication | 0.80 | "published by NIST for SP 800-53" |
| 3 | Same framework | 0.65 | "concerns SP 800-53" |
| 4 | Same topic/alias | 0.50 | "references Account Management" |
| 5 | Same technology/product | 0.40 | "concerns Windows Server 2022" |
| 6 | Semantic (token overlap over a curated vocabulary) | 0.25 | "shares terminology with Access Control" |

- An event may match several tiers; it keeps the **highest** and lists the
  others in `match_reason`.
- **Tier 6 is capped and gated:** it must never be the sole reason for showing
  an event on a record page in MVP. Ship tiers 1–5 on record pages; allow tier 6
  only in `/pulse` browse views where the reader is exploring rather than
  reading a control. This is the main defence against the feature becoming
  noise.
- Minimum confidence to attach to a record: **0.40** (tier 5).

### 6.4 Determinism

Matching is a pure function of (event corpus, record corpus, curated topic file).
Same inputs → same output, always. Enforced by
`tests/graph/pulseTopicMatch.test.ts` running the matcher twice over a fixture
and asserting identical output, plus golden-file assertions for a handful of
known-hard cases (`AC-2` vs `AC-20`, `AC2 battery`, `CM-6` vs `CM6`).

---

## 7. MVP source matrix

Endpoints marked **(verify)** must be confirmed against the publisher's current
documentation during implementation. Do not treat this table as authoritative
for URLs — treat it as authoritative for *shape*.

| Source | Lane | Transport | Endpoint | Auth | License | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| Control Atlas pipeline | 1 | pipeline delta | in-repo artifacts | none | n/a | forever |
| NIST CSRC news/publications | 2 | RSS **(verify)** | `csrc.nist.gov` news + publication feeds | none | US Gov public domain | forever |
| FedRAMP updates | 2 | RSS/JSON **(verify)** | `fedramp.gov` updates; `GSA/fedramp-automation` releases | none / `GITHUB_TOKEN` | US Gov public domain | forever |
| DISA STIGs | 2 | **existing pipeline** | reuse `fetch-disa-stigs.mjs` + `fetch-stig-source-observations.mjs` | none | US Gov | forever |
| CISA advisories / KEV | 2 | RSS + JSON **(verify)** | `cisa.gov` advisories feed; KEV JSON | none | US Gov public domain | forever |
| MITRE ATT&CK | 2 | GitHub Releases | `mitre-attack/attack-stix-data` | `GITHUB_TOKEN` | Apache-2.0 / ATT&CK terms | forever |
| GitHub Releases (tool set) | 4 | REST | `/repos/{o}/{r}/releases` | `GITHUB_TOKEN` | per-repo | 365 d |
| GitHub Issues (community) | 3 | REST | `/repos/{o}/{r}/issues` | `GITHUB_TOKEN` | per-repo | 180 d |
| GitHub Discussions | 3 | GraphQL | `/graphql` | `GITHUB_TOKEN` | per-repo | 180 d |
| Reddit | 3 | OAuth2 | `oauth.reddit.com` | client credentials | **see §3.4** | 180 d |

**Recommended MVP cut:** Lanes 1, 2 and 4 in full, Lane 3 via GitHub Issues
only. Reddit and Discussions move to Phase 2 behind the §3.4 decision. This
delivers the feature's spine without blocking on a policy question.

DISA deserves emphasis: rather than inventing a new feed, Lane 2 STIG events
should be derived from the STIG fetchers this repo already runs. That is
cheaper, already licensed, already tested, and already in the refresh contract.

---

## 8. Pipeline integration

### 8.1 Hook points

1. **Fetch** — new `scripts/fetch-pulse-feeds.mjs`, registered in
   `scripts/refresh-data.mjs` and declared in `data/source-refresh-contract.json`
   under `tasks[]` with `cadence: "weekly"`, `conditional_policy: "strict"`.
   Writes raw snapshots to `data/pulse-snapshots/<source-id>/<iso-date>.json`.
   Runs **only** in the `refresh` job.
2. **Normalize + match + rank** — new `scripts/build-pulse-events.mjs`, appended
   to `build:data`. Pure, offline, deterministic. Reads snapshots and curated
   topic files; writes the six artifacts.
3. **Search index** — Pulse search shards are built in the same script, using
   the `sharded_collection` manifest shape from `build-framework-data.mjs`.
4. **Site build** — no change. `build:site` copies `data/generated` and gzips.
5. **Runtime** — `runtimeLoader.ts` gains route-gated preloads so Atlas and
   Library never pay for Pulse payloads.

### 8.2 Partial-failure tolerance

**Requirement: a source being down must never block a deploy.**

- Each source fetch is independently `try`/`catch`ed; a failure records a
  `source_unavailable` Lane 1 event and continues.
- The fetch job succeeds if **≥1** source succeeded; it fails only if *every*
  source failed (which indicates our own breakage, not theirs).
- `build-pulse-events.mjs` **never** performs network I/O, so a build cannot
  fail because a publisher is down. Worst case it builds from the last committed
  snapshot and the artifacts are simply older.
- If a Pulse artifact is missing entirely, the UI renders its empty state and
  the rest of the site is unaffected (§9.5).
- Missing Reddit/GitHub credentials → those sources are skipped with a recorded
  reason, not an exception. A fork without secrets must still build.

### 8.3 Observability

`pulse-statistics.json` carries the build report, and the fetch job prints it:

```
feeds_checked, feeds_failed[], feeds_skipped[] (with reason)
events_generated, events_matched, events_rejected[] (by gate)
duplicates_removed, events_pruned (by lane)
avg_freshness_days, newest_event_at, oldest_event_at
records_with_activity, records_without_activity
tier_distribution { 1..6 }
```

A `verify:pulse` script fails the build when: any lane has zero events while its
sources reported success; `events_rejected` exceeds 25% of `events_generated`;
or `avg_freshness_days` exceeds a source's `freshness_sla_days`. These are
symptoms of a broken parser, and they should be loud.

### 8.4 Quality gates (reject, with the reason counted)

| Gate | Rejects |
| --- | --- |
| Missing URL, publisher, or `published_at` | the event |
| Malformed feed / unparseable payload | the whole source, recorded as unavailable |
| Unknown or absent license in the source matrix | the whole source, at registration time |
| Duplicate `hash` | the lower-trust duplicate |
| Failed normalization (no title after sanitization) | the event |
| No match reason / confidence < 0.40 | the record attachment, not the event |
| `published_at` in the future relative to snapshot | the event (clock-skew guard) |

---

## 9. UI

### 9.1 Record page — "Recent Activity"

A new section in `src/ui/pages/ObjectDetailPage.tsx`, marked
`data-record-section="pulse-activity"`, placed **after** `related-records`.

- Renders only if `pulse-topics.json` has entries for this record id.
- Grouped by lane, lanes in order 1→2→4→3, newest first within a lane.
- **Maximum 10 events total**, with a link to the record's filtered `/pulse` view.
- Each item: badge, publisher, title (links to canonical source), date,
  and the `match_reason` as visible secondary text — not a tooltip.
- No popups, no interstitials, no auto-refresh, no animation on load.
- External links carry `rel="noopener noreferrer"` and a visible external-link
  affordance, consistent with existing record source links.

Per `docs/PAGE_CONTRACTS.md`, structural parents and children never appear in
`Related records`; Pulse is a separate section and must not be confused with it.
The section is clearly subordinate: it never precedes publisher-native content.

### 9.2 `/pulse` route

- New `AppView: "pulse"` in `src/ui/lib/viewState.ts`.
- `ROUTE_IDENTITIES.pulse = { path: "/pulse", label: "Pulse", title: "Pulse", contextLabel: "Pulse", analyticsName: "pulse" }`.
- `SELECTED_NAV_BY_VIEW.pulse = "pulse"`.
- Param allowlist in `routeIdentity.ts`: `lane`, `framework`, `publisher`,
  `topic`, `q`, `record`, `page` — same discard-unknown-params discipline as
  `COMPARE_PARAMS`.
- Navigation placement: overflow menu initially (the header is already full at
  seven items per the page contract). Promoting it to the primary header is a
  creator decision.

Views: Latest · Trending · By Framework · By Source · By Topic · By Community ·
Timeline · Search. Pulse Home sections as briefed.

### 9.3 Design-system consistency

- Lane badges reuse the existing badge/eyebrow primitives and the area colour
  tokens (`--ca-area-*`); no new colour system.
- Lane 1 uses the Control Atlas structural treatment already used for
  product-authored content, so "we detected this" is visually distinct from
  "a publisher said this".
- Type scale, spacing tokens (`--ca-space-*`) and the 44px target rule apply
  unchanged. Colour is never the only signal — each lane badge carries text.
- Verified at 320/375/390/768/1024/1440 per the page contract.

### 9.4 Honest freshness

Every Pulse surface states when the data was retrieved, e.g.
"Retrieved 20 Aug 2026 · updated weekly". Pulse must never imply live data. If
the newest event is older than the source's `freshness_sla_days`, the UI says so
plainly rather than showing a stale list silently.

### 9.5 Empty and failure states

- No events for a record → the section does not render at all (no empty box).
- Pulse artifacts missing → `/pulse` renders a plain explanatory state; record
  pages are unaffected.
- A lane with zero events → that lane's container states it, so the reader can
  tell "nothing happened" from "this is broken".

---

## 10. Security, copyright, telemetry

- **Store only** title, short summary (≤320 chars), canonical URL, publisher,
  dates, and our own derived metadata. **Never** full article text, never full
  post bodies, never images, never attachments.
- **Always** link to the canonical source. The link is the product; the summary
  is the pointer.
- **Sanitize** all external strings: strip HTML entirely (do not sanitize-and-
  render), decode entities, normalize whitespace, cap length. Feed content is
  rendered as **text**, never as markdown-with-HTML and never as `innerHTML`.
- **Never** execute or embed external HTML, scripts, iframes or remote images.
  The CSP already forbids it; the pipeline must not try.
- **No telemetry.** No click tracking, no analytics, no beacons. Trending is
  computed from publication volume and recency only — never from reader
  behaviour, which we do not and will not collect.
- **CSP unchanged.** Adding a Pulse source must not require a CSP edit; if it
  would, the source is wrong for this architecture.
- **Prompt-injection hygiene:** feed content is untrusted data. It is never
  interpreted as instructions by any build step, and never interpolated into a
  shell command or a template that executes.

---

## 11. Acceptance criteria → verification

| Acceptance criterion | How it is verified |
| --- | --- |
| Static only; no backend | `dist/site` contains only static assets; existing `verify:site-artifact` |
| No login, no telemetry | grep gate: no analytics/beacon calls in bundle; CSP test |
| No graph mutations | `tests/graph/pulseBoundary.test.ts` — graph artifact hashes identical with/without Pulse |
| Official/community separation | DOM contract test: lane containers distinct; no interleaving; badge text present |
| Every event has provenance + match_reason + canonical link | schema validation in `build-pulse-events.mjs`; rejects otherwise; unit test on the validator |
| Build succeeds when sources unavailable | fixture test: all fetches fail → build still produces artifacts and exits 0 |
| Partial failures never block deploy | as above + `verify:pulse` thresholds |
| Search under existing perf targets | `check-data-size.mjs` shard budget; existing search benchmark test extended |
| All data generated at build time | no network imports in `build-pulse-events.mjs` (lint rule / test) |
| Reproducible builds | `verify:generated-reproducibility` passes with Pulse artifacts present |
| No secrets in the bundle | test asserts no `PULSE_*` name or token-shaped string in `dist/site` |
| Copyright limits respected | schema test: `summary` ≤ 320 chars; no `content`/`body` field exists in the schema at all |
| a11y | Pulse routes added to `tests/e2e/accessibility.spec.mjs`; zero serious/critical |
| Responsive | page-contract widths 320–1440 |

---

## 12. Phasing and task breakdown

Sizing: **S** ≤ half a day · **M** 1–3 days · **L** 1–2 weeks.

### Phase 0 — Foundations (no user-visible feature)

| # | Task | Size | Depends on |
| --- | --- | --- | --- |
| 0.1 | `pulse_aggregated` provenance class + `graph_eligible: false` registration path | S | — |
| 0.2 | `tests/graph/pulseBoundary.test.ts` (graph-hash invariance) — **write before any Pulse code** | M | 0.1 |
| 0.3 | Event schema + JSON Schema file + validator | M | — |
| 0.4 | Deterministic id/hash/canonical-URL helper + tests | S | 0.3 |
| 0.5 | `data/curated/pulse-sources.json` + registry wiring + license gate | M | 0.1 |
| 0.6 | Decision: Reddit option A/B/C (§3.4) | — | **creator** |

### Phase 1 — MVP

| # | Task | Size | Depends on |
| --- | --- | --- | --- |
| 1.1 | Lane 1 delta engine from existing artifacts (extend `report-refresh-diff.mjs` logic) | L | 0.3, 0.4 |
| 1.2 | Topic Profile builder from governed record data | L | 0.3 |
| 1.3 | Curated alias/exclusion file + authoring pass for the top ~50 records | M | 1.2 |
| 1.4 | Tier 1–5 matcher + `match_reason` generation + golden tests | L | 1.2, 1.3 |
| 1.5 | `scripts/fetch-pulse-feeds.mjs` — RSS/Atom (NIST, FedRAMP, CISA) | M | 0.5 |
| 1.6 | GitHub Releases + Issues adapters (`GITHUB_TOKEN`) | M | 0.5 |
| 1.7 | DISA STIG events from existing fetchers | S | 1.1 |
| 1.8 | `build-pulse-events.mjs` — normalize, dedupe, rank, prune, emit 6 files | L | 1.1–1.7 |
| 1.9 | Pulse search sharding + `check-data-size.mjs` budget | M | 1.8 |
| 1.10 | Refresh-contract + workflow registration; secrets wiring | M | 1.5, 1.6 |
| 1.11 | Partial-failure + no-credentials fixture tests | M | 1.8 |
| 1.12 | `pulse-statistics.json` + `verify:pulse` gate | M | 1.8 |
| 1.13 | Record page "Recent Activity" section | M | 1.8 |
| 1.14 | `/pulse` route + Latest/By Framework/By Source/Search | L | 1.8, 1.9 |
| 1.15 | Pulse Home sections | M | 1.14 |
| 1.16 | Docs: `PAGE_CONTRACTS.md` §Pulse, `DATA_POLICY.md` boundary, `PRD.md` row | M | 1.13, 1.14 |
| 1.17 | a11y + responsive + reproducibility verification pass | M | 1.13–1.15 |

**MVP critical path:** 0.3 → 1.2 → 1.4 → 1.8 → 1.14. Roughly **6–8 weeks** of
focused work; the matcher (1.4) and the browse UI (1.14) are the long poles.

### Phase 2

Platform One, Iron Bank, NSA, CNSS, DoD CIO, ComplianceAsCode, OpenSCAP,
MITRE SAF · GitHub Discussions (GraphQL) · Reddit if option B/C chosen ·
Trending (`pulse-trending.json`) · Timeline (`pulse-timeline.json`) ·
By Topic / By Community views. **Sizing: L overall.**

### Phase 3

Cross-record trend detection · framework timelines · topic heat maps ·
historical release comparison · change-impact summaries · upcoming draft
expirations. Each is **M–L**; all depend on a populated Phase 2 corpus, and
several edge close to "recommendation engine", which is an explicit non-goal —
they must stay descriptive.

---

## 13. Non-goals (restated, because they will be tested)

Pulse is **not** a SIEM, threat-intel platform, scanner, compliance engine,
applicability engine, recommendation engine, risk calculator, or authorization
tool. It does not tell anyone what to do, what applies to them, or what their
risk is. Any Phase 3 feature that starts to imply "you should…" is out of scope
and should be refused.

---

## 14. Open decisions and risks for the creator

| # | Decision / risk | Why it needs you | Recommendation |
| --- | --- | --- | --- |
| D1 | **Reddit: option A, B or C** (§3.4) | Terms-of-use and possible legal review; not a technical call | **A — defer to Phase 2** |
| D2 | Is a community lane required at MVP at all? | Shapes Lane 3 scope | GitHub Issues only at MVP |
| D3 | Pulse in the primary nav or the overflow menu? | The header is at seven items per the page contract | Overflow at launch |
| D4 | Weekly freshness acceptable, or does Pulse need its own faster cron? | A daily Pulse cron means more CI minutes and more refresh PRs to review | Weekly at MVP; revisit with real usage |
| D5 | Does every Pulse refresh need human review, or can Pulse-only changes auto-merge? | Current model is a draft PR; weekly review is real ongoing work | Keep human review at MVP |
| D6 | Tier 6 semantic matching on record pages? | Main noise risk | Off at MVP (§6.3) |
| D7 | Who authors the alias/exclusion file, and how is it reviewed? | It is the one judgement layer in Pulse | Same review bar as `framework-lenses.json` |
| R1 | **Matcher precision** — a wrong event on a control page damages trust more than a missing one | — | Bias to precision; require ≥0.40; golden tests |
| R2 | Feed churn — publishers change feed shapes without notice | — | Per-source failure isolation; `verify:pulse` catches silent zeroes |
| R3 | Review burden — a weekly PR of community content is ongoing human cost | — | Keep MVP source count small |
| R4 | Reproducibility regressions from any stray `Date.now()` | — | Lint rule banning it in Pulse scripts |
| R5 | Scope creep toward advice | — | §13 as an explicit test |

---

## 15. Conflicts with the brief, stated plainly

1. **"Community Pulse in MVP" vs. Reddit's terms.** The brief lists Reddit in
   the MVP. I recommend deferring it (D1). This is the one place I am
   recommending against the brief, and the reason is policy, not effort.
2. **"Mattermost, mailing lists, public Slack" (Lane 3).** These have no
   general public read API. Mattermost is self-hosted per instance; Slack
   requires per-workspace app installation and its terms restrict redisplay;
   mailing lists vary by archive software. Treat these as **Phase 3
   research**, not committed sources.
3. **"Static JSON → Search Index" as one step.** In this repo, search shards
   have a hard 320 KB gzip budget, so this is two steps with a sharding
   manifest, not one (§3.6).
4. **`severity` in the schema.** Retained, but it must be `null` unless a
   publisher states it. Deriving severity would be inventing.
5. **Freshness expectations.** "Pulse is the weather" suggests immediacy;
   the architecture delivers weekly. The UI must not paper over this (§9.4).
6. **Requested plan path.** The brief asked for
   `docs/plans/pulse-implementation.md`. `tests/alignment-contract.test.mjs`
   enforces that `docs/` contains exactly the canonical document set plus at
   most one active plan at `docs/Plan.md`, so the requested path fails
   `npm test`. The plan is filed at the sanctioned path instead. If a
   `docs/plans/` archive is genuinely wanted, that contract has to be changed
   deliberately — it exists to stop plan sprawl, and quietly widening it to fit
   one file is the wrong way to make that decision.

---

## 16. What this plan deliberately does not do

It does not write code, choose final feed URLs without verification, or commit
to Reddit before D1 is answered. Endpoints marked **(verify)** are shapes, not
facts, and must be confirmed against publisher documentation during
implementation — consistent with the project's rule that unknown upstream facts
are recorded as unknown rather than estimated.
