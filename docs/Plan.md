# Control Atlas Pulse — Implementation Plan (v1.1)

- **Owner:** Product owner
- **Status:** Active
- **Last reviewed:** 2026-09-07
- **Supersession:** This is the single retained active plan. Update it when the
  source matrix, lane model, or phase boundaries change; never create a second
  Pulse plan beside it, and delete it in the shipping change that completes the
  work it describes.

**This document authorizes no implementation.** It is a plan. Building Pulse is
a separate decision. Every claim about this repository below carries a
`file:line` citation, and every one was verified against the code on 2026-09-07.

> Filed at `docs/Plan.md` rather than `docs/plans/pulse-implementation.md`:
> `tests/alignment-contract.test.mjs:31-39` compares the full sorted `docs/`
> file list with `assert.deepEqual` against a 15-path allowlist plus one
> optional `docs/Plan.md`. A `docs/plans/` directory fails `npm test`. See §15.6.

> **Guiding principle:** Control Atlas is the authoritative map; Pulse is the weather.
> Pulse never invents. It aggregates, correlates and explains what publishers and
> maintainers have already said, and it links back to them.

---

## 0. Executive summary for the reviewer

Pulse fits this repository better than it might first appear, because the hard
parts already exist:

- A **scheduled network-fetch job** (`refresh` in `.github/workflows/ci.yml:708-758`)
  that holds a token, uses conditional HTTP, and opens a **draft pull request**
  of `data/**` for human review before anything ships.
- A **source registry** (`data/source-registry.json`) whose per-source record
  already carries `provenance_class`, `license_or_use`, `access_status`,
  `lifecycle_status`, `checksum` and — critically — `graph_eligible`, present on
  all 50 sources.
- A **freshness ledger** (`source-registry.json` → `freshness.sources[]`) with
  `last_checked`, `last_imported` and `hash` per source. Lane 1 is largely a
  *presentation* of data the pipeline already produces.

### What changed in v1.1

**Scope decided (2026-09-07).** The MVP is **Lanes 1, 2 and 4. There is no
community lane.** Reddit, GitHub Issues and GitHub Discussions all move to
Phase 2. The consequence worth stating plainly: **the MVP needs no new
repository secret at all.** `.github/workflows/ci.yml` contains no
`secrets.*` reference anywhere today, and the refresh job authenticates with the
built-in `github.token` alone (`ci.yml:731-734`). What v1.0 framed as a
credentials-and-terms problem is now simply absent from the MVP.

**Fourteen corrections.** v1.0 named the right files but got several load-bearing
mechanics wrong. Each is fixed in place below and flagged **[v1.1]**. The four
that would have cost the most time:

1. Fetch tasks register in `scripts/lib/ingestion-pipeline.mjs`, **not** in
   `scripts/refresh-data.mjs` (§8.1).
2. `build-framework-data.mjs` **deletes every `*.json` sitting directly in
   `data/generated`** on each run. A Pulse artifact written before it is silently
   erased (§8.1).
3. `npm run verify:affected` **exits 2** on any unmapped changed path. Three
   separate mappings are required before the first Pulse commit lands (§8.5).
4. `strictConditionalFetch` **throws on HTTP 304**, which is the happy path for a
   weekly conditional poll (§8.3).

Two constraints from v1.0 survive unchanged and remain the sharpest edges: the
CSP forbids all client-side fetching, so there is no live Pulse (§3.1); and
`verify:generated-reproducibility` requires byte-identical rebuilds, so a stray
`Date.now()` is still the most likely way a correct implementation fails CI (§3.5).

---

## 1. Architecture fit

### 1.1 Where Pulse sits in the existing pipeline

```
                    +-----------------------------------------+
  SCHEDULED ONLY    | ci.yml  job: refresh  (cron 17 7 * * 3) |
  (has github.token)|   npm run refresh:data                  |
                    |   -> strict conditional HTTP            |
                    |   -> writes data/** snapshots           |
                    |   -> create-pull-request (DRAFT)        |  <- human review
                    +------------------+----------------------+
                                       |  merged by a person
                    +------------------v----------------------+
  EVERY BUILD       | npm run build:data                      |
  (no secrets,      |   1..6  build-framework-data  <- WIPES  |
   no network)      |         data/generated/*.json           |
                    |   7..13 inventory, manifests, discovery |
                    |   * 14  build-pulse-events.mjs  (NEW)   |
                    +------------------+----------------------+
                    +------------------v----------------------+
                    | npm run build:site -> dist/site         |
                    +------------------+----------------------+
                    +------------------v----------------------+
                    | Control Atlas Deploy -> GitHub Pages    |
                    +-----------------------------------------+
```

**The one-sentence rule:** *Pulse fetches on a schedule inside CI with a token
and human review; Pulse builds from committed snapshots with no network at all.*

This mirrors how every existing source already works, and it is the only shape
that satisfies static-only plus no-secrets-in-a-public-build.

### 1.2 Files Pulse touches

| Concern | Existing file | Pulse change |
| --- | --- | --- |
| Task registration **[v1.1]** | `scripts/lib/ingestion-pipeline.mjs:17-63` | append to `INGESTION_TASKS`; array order is execution order |
| Fetch orchestration | `scripts/refresh-data.mjs:97` | no edit; it iterates `INGESTION_TASKS` |
| Conditional HTTP | `scripts/lib/strict-conditional-fetch.mjs:29` | reuse `strictConditionalFetch`; **catch 304** |
| Refresh contract | `data/source-refresh-contract.json` | add `tasks[]` entries |
| Contract validation | `scripts/lib/source-refresh-contract.mjs:12` | reuse; it cross-checks `ci.yml` text |
| Provenance enum **[v1.1]** | `tools/validators/source-registry.mjs:92-101` | add `pulse_aggregated` to the closed set |
| Source registry | `data/source-registry.json` | add Pulse sources with `graph_eligible: false` **and a matching `freshness.sources[]` entry each** |
| Deterministic time | `scripts/lib/stable-generated-at.mjs:52` | reuse `generatedAt()` for every Pulse timestamp |
| Atomic writes | `scripts/lib/write-json-atomically.mjs:8` | reuse; a `false` return means unchanged, not failed |
| Data build chain **[v1.1]** | `package.json` → `build:data` | append as step **14**, after `build-framework-data` |
| Size budget | `scripts/check-data-size.mjs:51-52` | add one `checkSearchShardBudget(...)` line |
| Affected-change map **[v1.1]** | `tools/verify-affected.mjs:22-115` | three new mappings, or every Pulse commit is blocked |
| Runtime loading | `src/ui/lib/runtimeLoader.ts:312-459`, `:1109-1169` | route-gated plan flag, preload, and staged load |
| Routes **[v1.1]** | 7 files, 15 edit sites | see §9.2 |
| Record page | `src/ui/pages/ObjectDetailPage.tsx:556` | new section after `related-records` |
| Navigation | `src/ui/lib/navigation.ts:111-114` | overflow item; **two tests hardcode the nav set** |
| Page contract | `docs/PAGE_CONTRACTS.md` | new `## G. Pulse` section |
| Data policy | `docs/DATA_POLICY.md` | Pulse boundary clause |

### 1.3 Boundary enforcement — "informational only"

The requirement that Pulse never influences the graph is enforced structurally,
not by convention:

1. **Registry flag.** Every Pulse source registers with `graph_eligible: false`
   and `provenance_class: "pulse_aggregated"`. The graph builders already filter
   on `graph_eligible`. **[v1.1]** `PROVENANCE_CLASSES` is a closed set of eight
   values at `tools/validators/source-registry.mjs:92-101`; without a one-line
   addition there, every Pulse source fails registry validation.
2. **Separate artifacts.** Pulse writes only `pulse-*`. It never writes
   `nodes.json`, `edges.json`, `evidence.json`, `atlas-spine.json` or
   `atlas-network.json`.
3. **One-way reference.** Pulse events reference `record_ids`. No record, node or
   edge ever references an `event_id`. The reference direction is the guarantee.
4. **A contract test** (`tests/graph/pulseBoundary.test.ts`, new) asserts:
   - no Pulse source has `graph_eligible: true`;
   - the node, edge and evidence artifact hashes are byte-identical with Pulse
     artifacts present and absent;
   - no `event_id` appears anywhere in the graph artifacts;
   - `build-pulse-events.mjs` writes only paths matching `pulse-*`.

Item 4's second assertion is the strong one: it makes "Pulse changed the graph"
a build failure rather than a review question.

**[v1.1] A free corroborating check.** `tests/display-names.test.mjs:24` derives
its `provenance_class` domain from `distinct(edges, 'provenance_class')`. If
`pulse_aggregated` ever appears in that list, Pulse has leaked into the graph.
Add `pulse_aggregated` to `src/app/display-names.mjs` anyway, so a Pulse source
rendered on a sources surface reads as prose rather than a slug.

---

## 2. The lanes

| Lane | Name | Badge | Source of truth | Retention | MVP |
| --- | --- | --- | --- | --- | --- |
| 1 | Control Atlas Detected Changes | `CONTROL ATLAS DETECTED` | This repo's own pipeline | forever | **yes** |
| 2 | Official Updates | `OFFICIAL SOURCE` | Publisher feeds | forever | **yes** |
| 3 | Community Pulse | `COMMUNITY DISCUSSION` | Reddit, GitHub Issues and Discussions | 180 days | **no — Phase 2** |
| 4 | Ecosystem Releases | `TOOL ECOSYSTEM` | GitHub Releases | 365 days | **yes** |

Lanes are **visually and structurally** separated: distinct containers, distinct
badges, never interleaved in one list, never merged by a sort. A reader must
never have to check a badge to know whether they are looking at NIST or a
third-party tool release.

The lane model keeps four lanes even though the MVP ships three. Lane 3 keeps its
number, badge and container so that adding it in Phase 2 is an addition rather
than a re-layout.

### 2.1 Lane 1 is nearly free

Lane 1 needs no new network access. It is derived from artifacts the pipeline
already writes:

| Event type | Derived from |
| --- | --- |
| `source_version_changed` | `source-registry.json` → `sources[].version` delta |
| `source_hash_changed` | `freshness.sources[].hash` delta |
| `publication_added` / `_removed` | `publications[]` set delta |
| `stig_updated` | `fetch-disa-stigs.mjs` and `fetch-stig-source-observations.mjs` output delta |
| `relationship_added` / `_removed` | `edges.json` count and id-set delta |
| `parser_improved` / `parser_failed` | `data/generated/ingestion-stage-ledger.json` — `artifacts[]` stage outcomes and `findings[]` |
| `source_unavailable` | `source-registry.json` → `quarantine[]` and `access_status` |

Deltas are computed between the **previous committed** artifact and the current
one. `scripts/report-refresh-diff.mjs:17-31` already does a version of this for
the refresh PR body and is the natural starting point: it joins
`freshness.sources[]` by `source_id` against `git show HEAD:data/source-registry.json`
and emits a row when `last_checked`, `last_imported`, `hash` or `version` moved.

**This makes Lane 1 the correct MVP starting point:** highest trust, zero new
external dependencies, no licensing questions, no credentials.

---

## 3. Feasibility: the honest section

### 3.1 CSP forbids all client-side fetching — this is settled

`src/index.html:8` ships a Content-Security-Policy whose fetch directive is
`connect-src 'self'`, alongside `default-src 'self'`, `script-src 'self'`,
`object-src 'none'` and `base-uri 'self'`.

`connect-src 'self'` means the browser **cannot** call GitHub, NIST or anything
else. `tests/browser-contract.test.mjs` asserts the CSP is present. The brief
says "CSP unchanged", and that is achievable — but only because every byte Pulse
renders is fetched at build time and served from our own origin.

**Consequence:** there is no live Pulse. Freshness is bounded by the refresh
cadence, currently weekly. The UI must state the retrieval time honestly rather
than implying real-time. See §9.4.

### 3.2 Credentials: the MVP needs none **[v1.1]**

| Option | Verdict |
| --- | --- |
| Client-side, in the bundle | **Impossible and unsafe.** Blocked by CSP; a public repo would leak the secret. |
| GitHub Actions secret, used only in the `refresh` job | The correct pattern **if one were needed**. |
| Committed to the repo | Never. |

With Lanes 1, 2 and 4, no new secret is needed. Lane 1 uses no network. Lane 2's
sources are unauthenticated public feeds. Lane 4 uses the GitHub REST releases
endpoint with the `GITHUB_TOKEN` the refresh job already sets from the built-in
`github.token` at `.github/workflows/ci.yml:734`.

**[v1.1]** For the record, and because a later phase will need it:
`.github/workflows/ci.yml` contains **no `secrets.*` reference anywhere**. The
only two in the whole `.github/workflows` tree are in `deploy.yml`. A future
Pulse secret would be added to the existing `env:` map of the "Refresh validated
build-time data" step at `ci.yml:733-734`, which is the established pattern.

Keep the verification test regardless: assert that no `PULSE_*` name and no
token-shaped string appears in `dist/site`. It costs nothing, and it is the kind
of insurance that only has to pay once.

### 3.3 GitHub API — Releases only at MVP

- **Auth:** the built-in `github.token` in the `refresh` job. Already present.
- **Rate limits (verify at implementation time):** the Actions token is limited
  per repository per hour, on the order of 1,000 REST requests. A weekly job
  polling a few dozen repositories is far inside that.
- **Releases:** REST `GET /repos/{owner}/{repo}/releases` — clean, well
  documented, and the Lane 4 source.
- **Issues and Discussions:** Phase 2, with the rest of Lane 3. Discussions are
  GraphQL-only and materially heavier than Releases.

**[v1.1] The 304 trap.** `createStrictConditionalFetch` forces
`{ cache: 'no-cache', retry: false }` onto every request and then **throws** if
the response is `304`, and separately throws if the local cache entry is stale
(`scripts/lib/strict-conditional-fetch.mjs:20,23`). A weekly conditional poll of
an unchanged feed returns 304 on the happy path. A Pulse fetcher that treats a
thrown error as a failed source will report every quiet week as an outage. 304
must be caught by message and recorded as `unchanged`. See §8.3.

### 3.4 Community sources are Phase 2 — decided **[v1.1]**

v1.0 presented Reddit as an open question with three options. It is now decided:
**no community lane in the MVP.** The analysis that produced that decision is
retained here because Phase 2 will need it.

- **Technical access to Reddit** is solvable: OAuth2 client-credentials against
  `https://oauth.reddit.com`, a declared descriptive `User-Agent`, secrets in
  Actions. Free-tier limits are far above what a weekly job needs.
- **The terms are the problem.** Reddit's Data API terms constrain storing and
  redisplaying user content, and distinguish non-commercial from commercial use.
  Pulse would store titles, short summaries, URLs, authorship metadata and
  timestamps, and redisplay them on a public site — squarely the activity those
  terms govern. This is a policy decision with a technical implementation, not a
  technical task with a technical answer.
- **GitHub Issues are also user-generated content.** They carry no Reddit-style
  terms problem, but `docs/DATA_POLICY.md` does not currently contemplate
  third-party user content at all. Phase 2 must add that clause deliberately
  rather than letting the first Issues adapter set the precedent by accident.
- **Review burden is the quiet cost.** The refresh model is a weekly draft PR a
  person reads. Community text is the most expensive kind to review, and the
  least likely to be read carefully by week twelve.

Phase 2 opens with a written answer to: what third-party user content may Control
Atlas store, for how long, and who reads it before it ships.

### 3.5 Determinism vs. time-varying data — a real conflict

`npm run verify:generated-reproducibility` runs `npm run generate:data` twice
from a clean state and compares a SHA-256 over every file in `data/generated`
(`tools/verify-generated-data-reproducibility.mjs:17,40,95`). There is no
allowlist: new `data/generated/pulse-*` files are included automatically. Any
wall-clock value in a Pulse artifact breaks it, and it is a required CI gate.

`scripts/lib/stable-generated-at.mjs` exists for exactly this reason.

**[v1.1] The mechanism is narrower than "from the committed snapshot".**
`generatedAt()` reads five keys — `last_checked`, `lastUpdated`, `observed_at`,
`retrieved_at`, `snapshot_date` — recursively at any depth, but from **only two
files**: `data/source-registry.json` and `data/commons-resource-dataset.json`
(`stable-generated-at.mjs:6-16`). It returns the maximum as an ISO string, and
throws if it finds none.

A Pulse retrieval time recorded anywhere else does not move `generated_at`. It
must land in `freshness.sources[].last_checked` for the corresponding Pulse
source. That is not optional bookkeeping; it is the only channel by which a Pulse
fetch can advance the build's notion of now.

**Rule for Pulse:** every timestamp written into a `pulse-*` artifact comes from
a committed snapshot, never from `Date.now()`:

- `published_at` — from the feed item.
- `retrieved_at` — from the snapshot's recorded fetch time, committed by the
  refresh PR.
- `generated_at` — via `generatedAt()`, called **once** per build and threaded
  through, as `scripts/build-framework-data.mjs:3816` does.
- Retention windows (§5) computed against the **snapshot's** newest
  `retrieved_at`, not the current date, or two builds of the same commit prune
  different events.

This is the single most likely way an otherwise correct implementation fails CI.

### 3.6 Size budgets

- `scripts/check-data-size.mjs:6` rejects any file in `data/generated` over
  **20 MiB**. The walk is recursive, so a Pulse shard directory is covered
  automatically.
- Search shards are capped at **320,000 gzip bytes** at level 9
  (`check-data-size.mjs:7`).

`pulse-events.json` will stay small: thousands of events at roughly 1 KB each.
`pulse-search.json` **must shard**, and `check-data-size.mjs:51-52` must gain
`checkSearchShardBudget("pulse-search.json", "Pulse search shard")`.

**[v1.1] There is no reusable shard helper.** v1.0 referred to "the
`sharded_collection` manifest pattern" as though one existed. Sharding is inlined
three times in `build-framework-data.mjs` (`:3959-3990`, `:4050-4081`,
`:4082-4121`). Pulse either extracts `scripts/lib/write-sharded-collection.mjs`
or writes a fourth copy. Prefer extracting it, and leave the three existing call
sites alone — converting them risks changing their byte output for no gain. The
exact contract either way:

```jsonc
// data/generated/pulse-search.json — the manifest, minified, no indent
{
  "schema_version": "1.0",
  "generated_at": "...",
  "pulse_search": [],              // empty; the payload lives in the shards
  "sharded_collection": {
    "collection": "pulse_search",
    "record_count": 4821,
    "content_sha256": "...",       // sha256 over JSON.stringify(values)
    "shards": [{ "path": "pulse-search/000.json", "record_count": 483 }]
  }
}
```

Shard files are minified with a trailing newline and named `<NNN>.json`,
zero-padded to three digits. `checkSearchShardBudget` reads only
`sharded_collection.shards[].path` (`check-data-size.mjs:23`), so any manifest
with this shape works.

---

## 4. Data model

### 4.1 Event schema

```jsonc
{
  "event_id": "sha256:...",       // deterministic; see §4.2
  "source_type": "rss | api | github_releases | pipeline_delta",
  "lane": 1,                       // 1 | 2 | 4 at MVP; 3 reserved for Phase 2
  "publisher": "NIST",
  "title": "...",                  // verbatim from source, sanitized
  "summary": "...",                // <= 320 chars, truncated at a word boundary
  "url": "https://...",            // canonical source; required
  "published_at": "2026-08-14T00:00:00Z",
  "retrieved_at": "2026-08-20T07:17:00Z",
  "record_ids": ["nist-800-53:AC-2"],
  "frameworks": ["nist-800-53"],
  "technologies": ["windows"],
  "products": ["Windows Server 2022"],
  "severity": null,                // or informational|low|moderate|high|critical
  "event_type": "publication_released | draft_opened | comment_period |
                 source_version_changed | tool_release | ...",
  "match_reason": "contains the AC-2 identifier; published by NIST",
  "confidence": 0.95,              // derived from tier; see §6.3
  "tags": ["access-control"],
  "hash": "sha256:...",            // content hash for dedupe
  "version": 1,                    // schema version
  "review_status": "auto"          // auto | reviewed | suppressed
}
```

Field notes:

- **`record_ids`** use the repository's native record id shape,
  `<publication-id>:<NATIVE-ID>` — for example `cmmc-2:LEVEL-1` or
  `csf-2:CATEGORY-DE.AE`. Confirmed against `data/generated/graph-data/nodes/`.
- **`summary`** is the copyright-sensitive field. §10 governs it.
- **`severity`** is `null` unless the publisher states one. Pulse never infers
  severity — that would be inventing, which `AGENTS.md:93` forbids outright.
- **`match_reason`** is human-readable prose generated from the tier rules, and
  is **mandatory**. An event that cannot explain why it matched is rejected.
- **`review_status`** maps onto the existing draft-PR review model: events arrive
  `auto`; a human may mark `reviewed` or `suppressed` in a curated overlay file
  (`data/curated/pulse-suppressions.json`) that survives rebuilds.
- There is deliberately **no `content` or `body` field at any nesting depth**.
  §11 tests for its absence, not merely for a length cap.

### 4.2 Deterministic identity and dedupe

- `hash = sha256(canonical_url + "\n" + normalized_title + "\n" + published_at_date)`
- `event_id = "sha256:" + hash` — no random ids, no counters. The same source
  item always produces the same id, which is what makes rebuilds byte-identical
  and dedupe trivial.
- Canonicalization before hashing: lowercase the host, strip `utm_*`, `ref` and
  `fbclid` query params, strip the fragment, strip a trailing slash, and expand
  a known shortener only if the expansion was captured at fetch time.
- Cross-source dedupe: same `hash` keeps the highest-trust lane (1 > 2 > 4), and
  records the dropped duplicates' publishers in `tags` so nothing silently
  disappears.

### 4.3 Source matrix schema

Every Pulse source is described in `data/curated/pulse-sources.json` — the same
authored-and-reviewed pattern as `data/curated/framework-lenses.json` — and
**also** registered in `data/source-registry.json` so it inherits the existing
provenance machinery:

```jsonc
{
  "id": "nist-csrc-news",
  "publisher": "NIST",
  "official": true,
  "lane": 2,
  "transport": "rss",              // rss | atom | json_api | github_releases | pipeline
  "endpoint": "https://...",
  "license": "US Government work — public domain (17 U.S.C. 105)",
  "terms_url": "https://...",
  "retention_days": null,          // null = forever
  "rate_limit": "unauthenticated; polite weekly poll",
  "auth": "none",                  // none | github_token
  "poll_interval": "weekly",
  "freshness_sla_days": 14,
  "enabled_phase": 1
}
```

**[v1.1] The registry side has two hard requirements**, both enforced by
`tools/validators/source-registry.mjs`:

1. `provenance_class: "pulse_aggregated"` must first be added to the closed
   `PROVENANCE_CLASSES` set at `:92-101`.
2. Every `sources[].id` **must** have a matching `freshness.sources[]` entry, or
   validation fails with `missing freshness entry for source <id>` (`:212-216`).

`license_or_use` is required and truthy on every source (`:185`). `checksum` must
be `null` or a real `sha256:<64 hex>`; `isRealSha256` (`:106-111`) rejects any
string containing `placeholder`, `fabricated` or `estimated`.

**[v1.1]** `docs/DATA_POLICY.md:14` binds Pulse the same as every other source:
every included source records owner, version, canonical URL, access status,
lifecycle, use or license notes, retrieval method, provenance, **checksum, byte
length, and actual record count** where available. Unknown upstream facts are
`null` **with a stated reason**, never estimates. Pulse snapshots must carry all
three of checksum, byte length and record count.

### 4.4 The six generated files

| File | Contents | Consumer | Sharded |
| --- | --- | --- | --- |
| `pulse-events.json` | Full event records, newest first | `/pulse`, record blocks | no |
| `pulse-search.json` | Tokenized index: event_id to terms and record_ids | Pulse search | **yes** |
| `pulse-topics.json` | Topic profile to event_ids — the match index | record blocks | no |
| `pulse-timeline.json` | Date-bucketed event_ids per framework | Timeline view (Phase 2) | no |
| `pulse-trending.json` | Ranked topics with the inputs that produced them | Trending (Phase 2) | no |
| `pulse-statistics.json` | Build report (§8.4) plus lane and publisher counts | Pulse home, ops | no |

`pulse-topics.json` is the important one for performance: the record page must
not scan every event. It is a precomputed inverted index keyed by `record_id`, so
`ObjectDetailPage` does an O(1) lookup and then reads at most 10 events.

MVP writes all six. `pulse-timeline.json` and `pulse-trending.json` are written
but not yet consumed by a route; that settles their shape before the Phase 2
views are built on top of them.

---

## 5. Retention and pruning

| Lane | Retention | Rationale |
| --- | --- | --- |
| 1 Detected changes | forever | Our own history; small; audit value |
| 2 Official | forever | Public-domain government works; permanent record |
| 3 Community | 180 days | Phase 2 |
| 4 Tool releases | **365 days** | Older releases are superseded |

Pruning runs at build time against the snapshot's newest `retrieved_at` (§3.5),
never against the current date. Pruned events are counted in
`pulse-statistics.json` so a silent mass-prune is visible in the build report.

---

## 6. The Topic Profile engine

Build-time, deterministic, no ML at runtime, no network.

### 6.1 Profile construction

For each record, a profile is assembled **only from existing governed data**,
never invented:

| Field | Source |
| --- | --- |
| `identifiers` | record id, publisher-native id (`AC-2`), normalized variants (`AC 2`, `AC-02`) |
| `publication` | `src/shared/catalog-structure.mjs` profile and record location |
| `framework` | publication id |
| `control_family` | containment parent, for example "Access Control" |
| `aliases` | `data/curated/pulse-topics.json` — authored and reviewed |
| `technologies` / `products` | STIG benchmark titles, existing taxonomy registry |
| `abbreviations` | authored alias list |
| `excluded_terms` | authored deny list, for example `AC2 battery`, `AC/DC` |

Aliases and exclusions are **authored and reviewed**, like
`data/curated/framework-lenses.json`. Each entry carries a rationale. This is the
one place Pulse makes a judgement, and it is explicit, versioned and testable
rather than buried in a regex.

### 6.2 Identifier normalization

`AC-2` must match `AC-2`, `AC 2`, `AC.2`, `AC-02` and `AC-2(1)` — the last as the
enhancement, not the base — and must **not** match `AC-20`, `MAC-2`, `AC2 battery`,
or `AC-2` inside the URL slug of an unrelated product. Word-boundary anchored,
case insensitive, with the exclusion list applied **after** matching and before
scoring.

### 6.3 Ranking tiers

| Tier | Rule | Confidence | Example `match_reason` |
| --- | --- | --- | --- |
| 1 | Exact identifier in title or summary | 0.95 | "contains the AC-2 identifier" |
| 2 | Same publication | 0.80 | "published by NIST for SP 800-53" |
| 3 | Same framework | 0.65 | "concerns SP 800-53" |
| 4 | Same topic or alias | 0.50 | "references Account Management" |
| 5 | Same technology or product | 0.40 | "concerns Windows Server 2022" |
| 6 | Semantic — token overlap over a curated vocabulary | 0.25 | "shares terminology with Access Control" |

- An event may match several tiers; it keeps the **highest** and lists the others
  in `match_reason`.
- **Tier 6 is capped and gated:** it must never be the sole reason for showing an
  event on a record page in MVP. Ship tiers 1 to 5 on record pages; allow tier 6
  only in `/pulse` browse views where the reader is exploring rather than reading
  a control. This is the main defence against the feature becoming noise.
- Minimum confidence to attach to a record: **0.40**, tier 5.

### 6.4 Determinism and complexity **[v1.1]**

Matching is a pure function of (event corpus, record corpus, curated topic file).
Same inputs, same output, always. Enforced by `tests/graph/pulseTopicMatch.test.ts`
running the matcher twice over a fixture and asserting identical output, plus
golden-file assertions for the known-hard cases (`AC-2` vs `AC-20`, `AC2 battery`,
`CM-6` vs `CM6`).

**[v1.1] The corpus is large enough that the algorithm is a constraint, not an
implementation detail.** `data/generated/nodes.json` reports 31,414 records and
`edges.json` reports 77,677 edges. A record-by-event nested loop does not hold at
that size: five thousand events against thirty-one thousand records is 155 million
comparisons per build, inside a gate that already runs the whole data build twice.

The matcher must therefore:

1. Build an **inverted index once** — normalized identifier and alias to
   `record_id` — from the record corpus.
2. Tokenize each event **once**, then look its tokens up in that index.
3. Never iterate the record corpus per event.

Cost is then O(records + events x tokens-per-event), which is linear in the
inputs. Record the measured build time of `build-pulse-events.mjs` in
`pulse-statistics.json` so a regression here is visible rather than inferred.

---

## 7. MVP source matrix

Endpoints marked **(verify)** must be confirmed against the publisher's current
documentation during implementation. Do not treat this table as authoritative for
URLs — treat it as authoritative for *shape*. `AGENTS.md:89` forbids fabricating
official source URLs, and §16 restates why these are still unverified.

| Source | Lane | Transport | Endpoint | Auth | License | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| Control Atlas pipeline | 1 | pipeline delta | in-repo artifacts | none | n/a | forever |
| NIST CSRC news and publications | 2 | RSS **(verify)** | `csrc.nist.gov` news and publication feeds | none | US Gov public domain | forever |
| FedRAMP updates | 2 | RSS or JSON **(verify)** | `fedramp.gov` updates; `GSA/fedramp-automation` releases | none or `github.token` | US Gov public domain | forever |
| DISA STIGs | 2 | **existing pipeline** | reuse `fetch-disa-stigs.mjs` and `fetch-stig-source-observations.mjs` | none | US Gov | forever |
| CISA advisories and KEV | 2 | RSS plus JSON **(verify)** | `cisa.gov` advisories feed; KEV JSON | none | US Gov public domain | forever |
| MITRE ATT&CK | 2 | GitHub Releases **(verify)** | `mitre-attack/attack-stix-data` | `github.token` | Apache-2.0 and ATT&CK terms | forever |
| GitHub Releases, tool set | 4 | REST | `/repos/{owner}/{repo}/releases` | `github.token` | per repo | 365 d |

**Moved to Phase 2 by the 2026-09-07 scope decision:** Reddit, GitHub Issues,
GitHub Discussions. See §3.4.

DISA deserves emphasis: rather than inventing a new feed, Lane 2 STIG events
should be derived from the STIG fetchers this repo already runs. That is cheaper,
already licensed, already tested, and already in the refresh contract.

---

## 8. Pipeline integration

### 8.1 Hook points **[v1.1 — substantially corrected]**

**1. Register the tasks in `INGESTION_TASKS`, not in `refresh-data.mjs`.**
`scripts/refresh-data.mjs` exports nothing and takes no registration; it imports
the frozen `INGESTION_TASKS` array from `scripts/lib/ingestion-pipeline.mjs:17-63`
and executes it in array order (`refresh-data.mjs:97`). A new task is an entry in
that array:

```js
{
  id: 'fetch-pulse-feeds',
  script: 'fetch-pulse-feeds.mjs',
  stages: ['acquire', 'parse'],   // must be members of INGESTION_STAGES
  scope: ['pulse'],
  remote_fetch: true,             // only `=== true` pulls it into contract validation
  retries: 2,                     // must be >= 1 or the task never runs
}
```

`INGESTION_STAGES` is the ten-stage lifecycle at `ingestion-pipeline.mjs:1-12`,
and `validateIngestionPipelineDefinition` requires every stage to stay covered by
at least one task (`:78-80`). Position matters: `build-pulse-events` must sit
**after** `build-framework-data` (`:41-44`) and **before** `check-data-size`
(`:56`) so its output is both preserved and size-checked.

**2. `build-pulse-events.mjs` must be step 14 of `build:data`.** This is the
correction most likely to cost a day. `scripts/build-framework-data.mjs:3935-3957`
deletes, on every run, every `*.json` sitting directly in `data/generated`, plus
the five named subdirectories `library-search`, `library-search-index`,
`atlas-neighborhood`, `catalog-records` and `graph-data`. The only survivors are
`GOVERNANCE_FILES` (`:127-139`) and four named siblings (`:3942`).
`build-framework-data` is step 6 of the current 13-step `build:data` chain, so a
Pulse artifact written before it is silently erased and the failure presents as
"the build produced no Pulse data" with no error anywhere.

Append `build-pulse-events.mjs` to the end of `build:data`. It must also
`rmSync` its own shard directory at the start of each run, or shards orphaned by
a shorter rebuild survive into `dist/site` and into the size walk.

**3. Fetch.** New `scripts/fetch-pulse-feeds.mjs`, declared in
`data/source-refresh-contract.json` under `tasks[]`. Writes raw snapshots to
`data/pulse-snapshots/<source-id>/<iso-date>.json`. Runs **only** in the
`refresh` job. A contract `tasks[]` entry has exactly these keys:

```json
{
  "task_id": "fetch-pulse-feeds",
  "script": "fetch-pulse-feeds.mjs",
  "source_ids": ["nist-csrc-news"],
  "catalog_ids": [],
  "cadence": "weekly",
  "conditional_policy": "strict"
}
```

`task_id` and `script` must match the `INGESTION_TASKS` entry exactly, `cadence`
must equal `schedule.cadence` (`weekly`), and `conditional_policy` must be
`strict` or `range_download_exception` with an `exception_reason`
(`scripts/lib/source-refresh-contract.mjs:28-52`). The validator also cross-checks
that `ci.yml` contains the literal single-quoted cron string and the text
`npm run refresh:data` (`:72-76`), so changing the Pulse cadence means changing
both files together.

**4. Normalize, match, rank.** `scripts/build-pulse-events.mjs`. Pure, offline,
deterministic. Reads snapshots and curated topic files; writes the six artifacts.
No network import, asserted by test.

**5. Search index.** Pulse search shards are built in the same script, using the
manifest shape in §3.6.

**6. Site build.** No change. `build:site` copies `data/generated` and gzips.

**7. Runtime.** `runtimeLoader.ts` gains a route-gated plan flag so Atlas and
Library never pay for Pulse payloads. See §9.2.

### 8.2 Partial-failure tolerance

**Requirement: a source being down must never block a deploy.**

- Each source fetch is independently wrapped; a failure records a
  `source_unavailable` Lane 1 event and continues.
- The fetch job succeeds if **at least one** source succeeded; it fails only if
  *every* source failed, which indicates our own breakage rather than theirs.
- `build-pulse-events.mjs` **never** performs network I/O, so a build cannot fail
  because a publisher is down. Worst case it builds from the last committed
  snapshot and the artifacts are simply older.
- If a Pulse artifact is missing entirely, the UI renders its empty state and the
  rest of the site is unaffected (§9.5).
- A fork without the token skips the token-dependent sources with a recorded
  reason, not an exception. A fork must still build.

### 8.3 The 304 contract **[v1.1]**

`strictConditionalFetch` throws on `304 Not Modified` and on a stale local cache
hit (`scripts/lib/strict-conditional-fetch.mjs:20,23`). Both are thrown errors,
not return values, and 304 is the **expected** result of a weekly conditional
poll against an unchanged feed.

The fetcher must therefore distinguish three outcomes, not two:

| Outcome | Detection | Recorded as |
| --- | --- | --- |
| Changed | 200 with a body | `updated`, snapshot written |
| Unchanged | thrown 304 | `unchanged`, previous snapshot retained, **not** a failure |
| Failed | any other throw | `failed`, `source_unavailable` Lane 1 event |

Getting this wrong reports every quiet week as an outage and trips the
`verify:pulse` zero-events gate in §8.4 on a perfectly healthy run.

Relatedly: `writeJsonAtomically` returns `false` when the serialized bytes are
identical to what is already on disk (`scripts/lib/write-json-atomically.mjs:8`).
That is a no-op, not a failure, and the build report must not count it as one.

### 8.4 Observability

`pulse-statistics.json` carries the build report, and the fetch job prints it:

```
feeds_checked, feeds_unchanged[], feeds_failed[], feeds_skipped[] (with reason)
events_generated, events_matched, events_rejected[] (by gate)
duplicates_removed, events_pruned (by lane)
avg_freshness_days, newest_event_at, oldest_event_at
records_with_activity, records_without_activity
tier_distribution { 1..6 }
match_build_ms                      // see §6.4
```

A `verify:pulse` script fails the build when: any lane has zero events while its
sources reported `updated`; `events_rejected` exceeds 25% of `events_generated`;
or `avg_freshness_days` exceeds a source's `freshness_sla_days`. These are
symptoms of a broken parser, and they should be loud. **[v1.1]** Note the gate
keys off `updated`, not `checked` — a lane whose every source returned 304 has
legitimately produced no new events.

### 8.5 The affected-change map **[v1.1 — new, and blocking]**

`npm run verify:affected` maps changed files to the smallest faithful check set,
and **exits 2** when it cannot map a path (`tools/verify-affected.mjs:342-353`).
Its matching is entirely exact-path: a literal `Set` at `:22-47` plus inline
`paths.some(path => path === '...')` predicates at `:65-113`. There are no globs.

Three Pulse path families are unmapped today, and each fails differently:

| Path | Failure without a mapping | Fix |
| --- | --- | --- |
| `data/curated/pulse-*.json` | `data changes require a source-specific refresh plan` (`:345`) | add a `pulseDataChanged` predicate modelled on `phase4DataChanged` (`:113`), OR it into `mappedData` (`:114`) |
| `scripts/fetch-pulse-feeds.mjs`, `scripts/build-pulse-events.mjs` | same — `scripts/` is a data prefix | add both literals to `SOURCE_REFRESH_PATHS` (`:22-47`), or add a `pulsePipelineChanged` predicate modelled on `stigObservationChanged` (`:99-101`) |
| `src/ui/pages/PulsePage.tsx` | `runtime browser surface is not mapped to a bounded route-family check` (`:347`) | add a `pulseSurfacesChanged` predicate modelled on `phase4SurfacesChanged` (`:89-98`), OR it into `mappedRuntime` (`:115`), add a bounded browser step, and add `!pulseSurfacesChanged` to the fallback guard at `:334` so it does not double-fire |

Every step added this way is subject to two hard ceilings, checked at `:350-353`:
**`expectedTests` at most 50** and **`budgetSeconds` at most 120**. A Pulse
browser step that exceeds either blocks the whole plan.

**The trap:** `tests/verify-affected.test.mjs` asserts **ordered, exact step-id
lists** with `deepEqual` for several fixture path sets (`:17`, `:29`, `:71`,
`:112`), and asserts at `:131` that a change to `data/source-registry.json` stays
*blocked*. A new predicate that happens to fire on one of those fixtures breaks
them. Write the predicates as exact-path matches on Pulse paths only, and never
add `data/source-registry.json` to a Pulse mapping.

This work is Phase 0, not Phase 1. It blocks every later commit that touches
`data/curated/` or `src/ui/pages/`.

### 8.6 Quality gates — reject, with the reason counted

| Gate | Rejects |
| --- | --- |
| Missing URL, publisher, or `published_at` | the event |
| Malformed feed or unparseable payload | the whole source, recorded as unavailable |
| Unknown or absent license in the source matrix | the whole source, at registration time |
| Duplicate `hash` | the lower-trust duplicate |
| Failed normalization — no title after sanitization | the event |
| No match reason, or confidence below 0.40 | the record attachment, not the event |
| `published_at` in the future relative to the snapshot | the event, as a clock-skew guard |

---

## 9. UI

### 9.1 Record page — "Recent Activity"

A new section in `src/ui/pages/ObjectDetailPage.tsx`, marked
`data-record-section="pulse-activity"`, placed **after** `related-records`
(which renders at `:556`, last in the `<aside>`).

Section order is plain JSX source order — there is no registry and no sort — so
placement is literally where the block is written. Match the established shape:
a `<section>` with a `className`, a `data-record-section` attribute, a
`.section-header` containing an `<h2>` and a `<p>`, and a `<Badge tone="info">`
count, as `child-inventory` does at `:433-440`.

- Renders only if `pulse-topics.json` has entries for this record id.
- Grouped by lane, lanes in order 1, 2, 4, newest first within a lane.
- **Maximum 10 events total**, with a link to the record's filtered `/pulse` view.
- Each item: badge, publisher, title linking to the canonical source, date, and
  the `match_reason` as visible secondary text — not a tooltip.
- No popups, no interstitials, no auto-refresh, no animation on load.
- External links carry `rel="noopener noreferrer"` and a visible external-link
  affordance, consistent with existing record source links.

Per `docs/PAGE_CONTRACTS.md`, structural parents and children never appear in
`Related records`; Pulse is a separate section and must not be confused with it.
The section is clearly subordinate: it never precedes publisher-native content.

### 9.2 The `/pulse` route — 15 edit sites **[v1.1 — substantially expanded]**

v1.0 named four edit sites. There are fifteen. Seven are caught by
`npm run typecheck`; **eight fail silently**, and those are the expensive ones.

**Compile-enforced — `tsc` fails until all seven are done:**

| # | File | Edit |
| --- | --- | --- |
| 1 | `src/ui/lib/viewState.ts:1-16` | add `"pulse"` to the `AppView` union |
| 2 | `src/ui/lib/viewState.ts:48-229` | add a `ViewState` member; paramless form matches `about` at `:221` |
| 3 | `src/ui/lib/routeIdentity.ts:22-38` | `ROUTE_IDENTITIES.pulse = { path: "/pulse", label: "Pulse", title: "Pulse", contextLabel: "Pulse", analyticsName: "pulse" }` |
| 4 | `src/ui/lib/routeIdentity.ts:40-61` | `SELECTED_NAV_BY_VIEW.pulse` |
| 5 | `src/ui/lib/routeIdentity.ts:63-79` | `RECOVERY_VIEW_BY_VIEW.pulse` — non-nullable |
| 6 | `src/ui/lib/hashRoutes.ts:19-35` | `VIEW_TO_PATH.pulse` |
| 7 | `src/ui/components/OrbitalContextBar.tsx:19-148` | `case "pulse":` — the switch is exhaustive with no `default` |

**Silent failures — no compile error, no test failure, wrong product:**

| # | File | Omitting it causes |
| --- | --- | --- |
| 8 | `src/ui/App.tsx:902-1075` | **`/pulse` renders `<ExplorePage>`.** The tail at `:1065` falls through to the Library page with no error at all. |
| 9 | `src/ui/lib/hashRoutes.ts:37-53` | `PATH_TO_VIEW` miss, so `/pulse` resolves to `not-found` |
| 10 | `src/ui/lib/routeIdentity.ts:359-372` | no param allowlist, so `:377-380` strips **every** query param and shows a spurious "settings were removed" recovery message |
| 11 | `src/ui/lib/viewState.ts:338-556` | `parseViewState` falls through to `search` at `:538` |
| 12 | `src/ui/lib/viewState.ts:559-745` | `normalizeViewState` falls through to `searchState()` at `:732` |
| 13 | `src/ui/lib/viewState.ts:753-912` | `serializeViewState` emits no `view` param |
| 14 | `src/ui/lib/navigationState.ts:8-17` | `isStaticViewWithoutBundle` miss, so `App.tsx:867-876` shows `DataPendingNotice` forever |
| 15 | `src/ui/lib/runtimeLoader.ts:312-409` | `runtimeArtifactPlan` never requests Pulse data, so the route loads nothing |

The param allowlist follows the `COMPARE_PARAMS` pattern at
`routeIdentity.ts:132-134`, registered against the path at `:368`:

```ts
const PULSE_PARAMS = new Set(["lane", "framework", "publisher", "topic", "q", "record", "page"]);
// then, in the permitted-params chain:
if (path === "/pulse") permitted = PULSE_PARAMS;
```

Unknown params are discarded at `:158-161` and set the recovery message at `:422`.

**Runtime loading** is expressed in three places, all keyed off `state.view`: the
plan flag (`runtimeLoader.ts:359-360`), the preload (`:434-436`), and the staged
load (`:1134-1136`). `runtimeArtifactPlan` and `requiresFullGraph`
(`navigationState.ts:26-41`) are cross-checked against each other by
`tests/graph/runtimeLoader.test.ts:189,202`, so they must be edited together.

**Navigation.** Pulse goes in the overflow menu, not the primary header
(decision D3). Add a `PULSE_NAV_ITEM` to `OVERFLOW_NAV_ITEMS`
(`src/ui/lib/navigation.ts:111-114`) and to the matching `MOBILE_NAV_SECTIONS`
group (`:116-123`). `TopNav.tsx` needs no edit — it maps the arrays.

**[v1.1] Two tests hardcode the nav set and must be edited in the same commit:**

- `tests/graph/informationArchitecture.test.ts:29-41` — a `deepEqual` on the
  exact 6 primary and 3 overflow `[label, path]` pairs, plus
  `assert.equal(size, 9)` on the union.
- `tests/content-review.test.mjs:180-215` — regex-parses `navigation.ts` source
  and `deepEqual`s the primary view list.

Neither auto-discovers. Both fail the moment a tenth nav path exists.

**Views at MVP:** Latest, By Framework, By Source, Search, plus the Pulse Home
sections. Trending, Timeline, By Topic and By Community are Phase 2.

### 9.3 Design-system consistency

- Lane badges reuse the existing badge and eyebrow primitives and the area colour
  tokens (`--ca-area-*`). No new colour system.
- Lane 1 uses the Control Atlas structural treatment already used for
  product-authored content, so "we detected this" is visually distinct from "a
  publisher said this".
- Type scale, spacing tokens (`--ca-space-*`) and the 44px target rule apply
  unchanged. Colour is never the only signal — each lane badge carries text.
- Verified at 320, 375, 390, 768, 1024 and 1440 per the page contract.

### 9.4 Honest freshness

Every Pulse surface states when the data was retrieved, for example
"Retrieved 20 Aug 2026 · updated weekly". Pulse must never imply live data. If
the newest event is older than the source's `freshness_sla_days`, the UI says so
plainly rather than showing a stale list silently.

### 9.5 Empty and failure states

- No events for a record: the section does not render at all. No empty box.
- Pulse artifacts missing: `/pulse` renders a plain explanatory state; record
  pages are unaffected.
- A lane with zero events: that lane's container states it, so the reader can
  tell "nothing happened" from "this is broken".

---

## 10. Security, copyright, telemetry

- **Store only** title, short summary (320 characters or fewer), canonical URL,
  publisher, dates, and our own derived metadata. **Never** full article text,
  never full post bodies, never images, never attachments.
- **Always** link to the canonical source. The link is the product; the summary
  is the pointer.
- **Sanitize** all external strings: strip HTML entirely rather than
  sanitize-and-render, decode entities, normalize whitespace, cap length. Feed
  content is rendered as **text**, never as markdown-with-HTML and never via
  `innerHTML`.
- **Never** execute or embed external HTML, scripts, iframes or remote images.
  The CSP already forbids it; the pipeline must not try.
- **No telemetry.** No click tracking, no analytics, no beacons. Trending is
  computed from publication volume and recency only, never from reader
  behaviour, which we do not and will not collect.
- **CSP unchanged.** Adding a Pulse source must not require a CSP edit; if it
  would, the source is wrong for this architecture.
- **Prompt-injection hygiene:** feed content is untrusted data. It is never
  interpreted as instructions by any build step, and never interpolated into a
  shell command or into a template that executes.

---

## 11. Acceptance criteria and verification

| Acceptance criterion | How it is verified |
| --- | --- |
| Static only, no backend | `dist/site` contains only static assets; existing `verify:site-artifact` |
| No login, no telemetry | grep gate: no analytics or beacon calls in the bundle; CSP test |
| No graph mutations | `tests/graph/pulseBoundary.test.ts` — graph artifact hashes identical with and without Pulse |
| Official and detected separation | DOM contract test: lane containers distinct, no interleaving, badge text present |
| Every event has provenance, `match_reason` and a canonical link | schema validation in `build-pulse-events.mjs`; rejects otherwise; unit test on the validator |
| Build succeeds when sources are unavailable | fixture test: all fetches fail, build still produces artifacts and exits 0 |
| A 304 is not an outage **[v1.1]** | fixture test: all fetches return 304, build exits 0 and `verify:pulse` does not fire the zero-events gate |
| Partial failures never block deploy | as above, plus `verify:pulse` thresholds |
| Search under existing perf targets | `check-data-size.mjs` shard budget; existing search benchmark test extended |
| All data generated at build time | no network import in `build-pulse-events.mjs`, by lint rule or test |
| Reproducible builds | `verify:generated-reproducibility` passes with Pulse artifacts present |
| No secrets in the bundle | test asserts no `PULSE_*` name and no token-shaped string in `dist/site` |
| Copyright limits respected | schema test: `summary` at most 320 chars, and **no `content` or `body` field exists in the schema at any depth** |
| Matcher stays linear **[v1.1]** | `match_build_ms` recorded in `pulse-statistics.json`; contract test asserts a wall-time ceiling on a fixture corpus |
| Affected-change path is mapped **[v1.1]** | `node tools/verify-affected.mjs` exits 0 for each of the three Pulse path families |
| Accessibility | Pulse routes added to `tests/e2e/accessibility.spec.mjs`; zero serious or critical |
| Responsive | page-contract widths 320 to 1440 |

---

## 12. Work orders

Each task below is a self-contained work order. Read the work order and the files
it names; you should not need to read another work order to execute yours.

Sizing: **S** at most half a day, **M** 1 to 3 days, **L** 1 to 2 weeks.

Standing rules for every work order, from `AGENTS.md`: work on a branch named
`agent/<persona>/<issue>-<slug>` or `chore/<slug>`; never fabricate a checksum,
size, date, count or URL — unknowns are `null` with a stated reason; run
`npm run precommit` once at final integration, not per task; if a gate fails,
stop and report rather than widening the fix.

### Phase 0 — Foundations, no user-visible feature

---

**0.1 — Register the `pulse_aggregated` provenance class** · S · depends on nothing

- **Touches:** `tools/validators/source-registry.mjs:92-101`;
  `src/app/display-names.mjs`.
- **Do:** add `'pulse_aggregated'` to the `PROVENANCE_CLASSES` set. Add a display
  name for it so it renders as prose, not a slug.
- **Done when:** `node --test tests/source-registry.test.mjs` and
  `node --test tests/display-names.test.mjs` both pass.
- **Do not:** reuse `third_party_published`. Pulse needs a class no graph builder
  will ever accept, and a distinct name is what makes the boundary auditable.

---

**0.2 — Graph-boundary test, written before any Pulse code** · M · depends on 0.1

- **Touches:** `tests/graph/pulseBoundary.test.ts` (new);
  `package.json` → `test:graph`.
- **Do:** write the four assertions in §1.3. The load-bearing one is that the
  node, edge and evidence artifact hashes are byte-identical with Pulse artifacts
  present and absent. Add the file to the `test:graph` list.
- **Done when:** `npm run test:graph` passes and the test is proven to fail if you
  temporarily register a Pulse source with `graph_eligible: true`.
- **Do not:** write this after the Pulse builders. It exists to catch them, and a
  test written to match code that already works catches nothing.

---

**0.3 — Event schema, JSON Schema file, and validator** · M · depends on nothing

- **Touches:** `data/schemas/pulse-event.schema.json` (new);
  `scripts/lib/pulse-event-schema.mjs` (new); a new test file.
- **Do:** encode §4.1 as JSON Schema 2020-12, validated with the repository's
  existing AJV runtime — `docs/DATA_POLICY.md:58` and `AGENTS.md:112` both
  require AJV here, not an OSCAL-shaped document. `additionalProperties: false`
  at every level so a `content` or `body` field cannot be added by accident.
- **Done when:** the validator rejects each row of the §8.6 gate table, with the
  gate name in the error, and the new test is registered in an aggregate.
- **Do not:** allow `severity` to be inferred. It is `null` unless the publisher
  states one.

---

**0.4 — Deterministic identity helper** · S · depends on 0.3

- **Touches:** `scripts/lib/pulse-identity.mjs` (new); a new test file.
- **Do:** implement `canonicalizeUrl(url)` and `eventIdentity({ url, title, publishedAt })`
  per §4.2, returning `{ hash, event_id }`.
- **Done when:** unit tests prove the same input gives the same id across
  processes, and that `utm_*`, `ref`, `fbclid`, fragments and trailing slashes do
  not change the id.
- **Do not:** use `Date.now()`, a counter, or `crypto.randomUUID()` anywhere in
  this file. Deterministic ids are what make the reproducibility gate passable.

---

**0.5 — Pulse source registration** · M · depends on 0.1

- **Touches:** `data/curated/pulse-sources.json` (new); `data/source-registry.json`.
- **Do:** author the source matrix per §4.3. For **each** source add both a
  `sources[]` entry with `graph_eligible: false` and
  `provenance_class: "pulse_aggregated"`, **and** a matching `freshness.sources[]`
  entry. Record `license_or_use` on every one.
- **Done when:** `node --test tests/source-registry.test.mjs` passes.
- **Do not:** add a source without a freshness entry — validation fails with
  `missing freshness entry for source <id>` (`tools/validators/source-registry.mjs:212-216`).
  Do not write a placeholder checksum; `isRealSha256` (`:106-111`) rejects any
  string containing `placeholder`, `fabricated` or `estimated`.

---

**0.6 — Affected-change mappings** · M · depends on nothing · **[v1.1 — new]**

- **Touches:** `tools/verify-affected.mjs:22-47`, `:89-115`, `:334`;
  `tests/verify-affected.test.mjs`.
- **Do:** add the three mappings in §8.5 — one for `data/curated/pulse-*.json`,
  one for the Pulse scripts, one for `src/ui/pages/Pulse*`. Keep every new step
  under `expectedTests` 50 and `budgetSeconds` 120.
- **Done when:** `node tools/verify-affected.mjs` exits 0 for a changed-path set
  from each of the three families, and `node --test tests/verify-affected.test.mjs`
  still passes unchanged.
- **Do not:** write prefix or glob predicates. The file matches exact paths only,
  and a loose predicate breaks the ordered `deepEqual` step-id lists at
  `tests/verify-affected.test.mjs:17,29,71,112`. Never add
  `data/source-registry.json` to a Pulse mapping — `:131` requires it to stay
  blocked.

---

### Phase 1 — MVP: Lanes 1, 2 and 4

---

**1.1 — Lane 1 delta engine** · L · depends on 0.3, 0.4

- **Touches:** `scripts/lib/pulse-lane1.mjs` (new); read
  `scripts/report-refresh-diff.mjs:17-31` for the join pattern.
- **Do:** compute the seven §2.1 event types by diffing the current committed
  artifacts against `git show HEAD:<path>`. Read the ingestion stage ledger from
  `data/generated/ingestion-stage-ledger.json` — `artifacts[]` for per-artifact
  stage outcomes and `findings[]` for parser regressions.
- **Done when:** a fixture pair of before and after registries produces exactly
  the expected event set, twice, byte-identically.
- **Do not:** perform any network I/O. Lane 1 is derived entirely from artifacts
  already in the repository, which is what makes it the trustworthy lane.

---

**1.2 — Topic Profile builder** · L · depends on 0.3

- **Touches:** `scripts/lib/pulse-topic-profiles.mjs` (new); reads
  `data/generated/graph-data/nodes/`, `src/shared/catalog-structure.mjs`.
- **Do:** build one profile per record from the governed fields in §6.1. Emit the
  **inverted index** described in §6.4 — normalized identifier and alias to
  `record_id` — not a per-record list to be scanned later.
- **Done when:** the index covers all 31,414 records, and building it twice
  produces identical output.
- **Do not:** invent an alias. Anything not derivable from governed data belongs
  in the authored file from 1.3, with a rationale.

---

**1.3 — Curated alias and exclusion file** · M · depends on 1.2

- **Touches:** `data/curated/pulse-topics.json` (new).
- **Do:** author aliases and exclusions for roughly the top 50 records, each with
  a rationale field, at the same review bar as `data/curated/framework-lenses.json`.
  The exclusion list must cover the known-hard cases: `AC2 battery`, `AC/DC`,
  `MAC-2`.
- **Done when:** the file validates against its schema and 1.4's golden tests pass
  using it.
- **Do not:** encode judgement in a regex inside a script. This file is the one
  place Pulse makes a judgement, and it is deliberately explicit, versioned and
  reviewable.

---

**1.4 — Tier 1 to 5 matcher and `match_reason`** · L · depends on 1.2, 1.3

- **Touches:** `scripts/lib/pulse-matcher.mjs` (new);
  `tests/graph/pulseTopicMatch.test.ts` (new).
- **Do:** implement §6.2 normalization and §6.3 tiers 1 to 5, looking tokens up
  in 1.2's inverted index. Generate `match_reason` prose from the tier rules.
  Enforce the 0.40 floor.
- **Done when:** golden tests pass for `AC-2` vs `AC-20`, `AC2 battery`, `CM-6`
  vs `CM6`; running the matcher twice over the fixture gives identical output;
  and `match_build_ms` on the full corpus is recorded and under the ceiling.
- **Do not:** iterate the record corpus per event. See §6.4 — that is 155 million
  comparisons inside a gate that runs the build twice. Do not ship tier 6 to
  record pages; it is `/pulse` browse only.

---

**1.5 — RSS and Atom fetcher** · M · depends on 0.5

- **Touches:** `scripts/fetch-pulse-feeds.mjs` (new);
  `data/source-refresh-contract.json`; `package.json` → `lint:source-refresh`.
- **Do:** **first, verify the endpoints.** Every Lane 2 URL in §7 is marked
  `(verify)` and is a shape, not a fact; confirming them against publisher
  documentation was explicitly out of scope when this plan was written.
  `AGENTS.md:89` forbids fabricating official source URLs. Then implement the
  fetch using `strictConditionalFetch` (`scripts/lib/strict-conditional-fetch.mjs:29`),
  writing snapshots to `data/pulse-snapshots/<source-id>/<iso-date>.json` with
  checksum, byte length and record count per §4.3.
- **Done when:** `npm run test:source-refresh` passes and a live run against one
  verified feed writes a well-formed snapshot.
- **Do not:** treat a thrown 304 as a failure. See §8.3 — it is the happy path
  for an unchanged weekly poll. Do not forget to add the new file to
  `lint:source-refresh`, or it is silently unlinted.

---

**1.6 — GitHub Releases adapter, Lane 4** · M · depends on 0.5

- **Touches:** `scripts/fetch-pulse-feeds.mjs`; `data/curated/pulse-sources.json`.
- **Do:** add a `github_releases` transport using REST
  `GET /repos/{owner}/{repo}/releases` with the `GITHUB_TOKEN` the refresh job
  already provides (`.github/workflows/ci.yml:734`). Keep the tool repository
  list in the curated source file, not in the script.
- **Done when:** a run without a token skips these sources with a recorded reason
  and exits 0, proving a fork still builds.
- **Do not:** add GitHub Issues or Discussions. They are Lane 3, deferred to
  Phase 2 by the 2026-09-07 decision (§3.4).

---

**1.7 — DISA STIG events** · S · depends on 1.1

- **Touches:** `scripts/lib/pulse-lane1.mjs`.
- **Do:** derive `stig_updated` events from the existing
  `fetch-disa-stigs.mjs` and `fetch-stig-source-observations.mjs` output deltas.
- **Done when:** a fixture STIG delta produces the expected events.
- **Do not:** add a new DISA feed. These fetchers are already licensed, already
  tested, and already in the refresh contract.

---

**1.8 — `build-pulse-events.mjs`** · L · depends on 1.1 to 1.7

- **Touches:** `scripts/build-pulse-events.mjs` (new); `package.json` →
  `build:data`, `lint:ingestion`; `scripts/lib/ingestion-pipeline.mjs:17-63`.
- **Do:** normalize, dedupe, rank, prune and emit the six §4.4 artifacts. Call
  `generatedAt()` **once** and thread it through. Append the script to the end of
  `build:data` and add an `INGESTION_TASKS` entry positioned after
  `build-framework-data` and before `check-data-size`.
- **Done when:** `npm run build:data` produces all six artifacts and
  `npm run verify:generated-reproducibility` passes.
- **Do not:** run this script before `build-framework-data`. It deletes every
  `*.json` directly in `data/generated` on each run (`:3935-3957`), so earlier
  Pulse output is erased silently. Do not use `Date.now()` anywhere. Do not skip
  clearing your own shard directory at the start of the run, or orphaned shards
  from a shorter rebuild survive.

---

**1.9 — Pulse search sharding and budget** · M · depends on 1.8

- **Touches:** `scripts/lib/write-sharded-collection.mjs` (new);
  `scripts/build-pulse-events.mjs`; `scripts/check-data-size.mjs:51-52`.
- **Do:** extract the shard writer per §3.6 and use it for `pulse-search.json`.
  Add `checkSearchShardBudget("pulse-search.json", "Pulse search shard")`.
- **Done when:** `npm run check:data-size` passes with the Pulse artifacts present
  and the largest shard is under 320,000 gzip bytes at level 9.
- **Do not:** refactor the three existing inline shard writers in
  `build-framework-data.mjs` to use the new helper. Changing their byte output
  for no functional gain risks the reproducibility gate; leave them.

---

**1.10 — Refresh contract and workflow registration** · M · depends on 1.5, 1.6

- **Touches:** `data/source-refresh-contract.json`;
  `scripts/lib/ingestion-pipeline.mjs`.
- **Do:** add the `tasks[]` entries per §8.1 step 3, with `task_id` and `script`
  matching the `INGESTION_TASKS` entries exactly and `cadence: "weekly"`.
- **Done when:** `npm run refresh:data` passes its pre-flight validation, and
  `node --test tests/workflow-refresh.test.mjs tests/source-refresh-contract.test.mjs`
  passes.
- **Do not:** change the cron. The contract validator cross-checks the literal
  single-quoted cron string in `ci.yml` (`source-refresh-contract.mjs:72-75`), so
  a cadence change means editing both files together. Never add `git push`,
  `[skip ci]`, `auto-merge` or `npm run audit:deps` to `ci.yml` — all four are
  asserted absent (`tests/workflow-refresh.test.mjs:37,46`).

---

**1.11 — Partial-failure and no-credentials fixtures** · M · depends on 1.8

- **Touches:** a new test file; register it in `test:source-refresh`.
- **Do:** cover the three §8.3 outcomes plus the §8.2 rules — all sources fail,
  all sources return 304, no token present. Each must exit 0 and produce
  artifacts.
- **Done when:** all three fixtures pass and the all-304 case does **not** trip
  the `verify:pulse` zero-events gate.
- **Do not:** hit the network in a test. `AGENTS.md:100` requires committed
  fixtures.

---

**1.12 — `pulse-statistics.json` and the `verify:pulse` gate** · M · depends on 1.8

- **Touches:** `scripts/verify-pulse.mjs` (new); `package.json` →
  `verify:pulse`, `verify:contracts`, `lint:ingestion`.
- **Do:** emit the §8.4 report and implement the three failure conditions.
- **Done when:** `npm run verify:pulse` fails on a fixture with a silently broken
  parser and passes on a healthy one.
- **Do not:** key the zero-events gate off `feeds_checked`. Use `updated` — a
  lane whose sources all returned 304 has legitimately produced nothing new.

---

**1.13 — Record page "Recent Activity" section** · M · depends on 1.8

- **Touches:** `src/ui/pages/ObjectDetailPage.tsx` (after `:556`);
  `styles/` as needed.
- **Do:** implement §9.1, matching the `child-inventory` block shape at
  `:433-440`.
- **Done when:** the section renders for a record with events, does not render at
  all for one without, and the new selector is covered by an e2e assertion.
- **Do not:** place it inside or adjacent to `Related records` in a way that
  reads as part of it. `docs/PAGE_CONTRACTS.md` keeps those distinct.

---

**1.14 — The `/pulse` route** · L · depends on 1.8, 1.9

- **Touches:** the 15 sites in §9.2, plus `src/ui/pages/PulsePage.tsx` (new),
  `src/ui/lib/navigation.ts:111-114`,
  `tests/graph/informationArchitecture.test.ts:29-41`,
  `tests/content-review.test.mjs:180-215`.
- **Do:** work the §9.2 table top to bottom. Ship Latest, By Framework, By Source
  and Search.
- **Done when:** `npm run typecheck` passes, `/pulse` renders `PulsePage` and not
  `ExplorePage`, `#/pulse?lane=2` preserves its param with no recovery message,
  and `npm run test:graph` passes.
- **Do not:** stop at the seven compile-enforced sites. The eight silent ones in
  §9.2 produce a route that looks wired up and is not — most visibly `App.tsx`,
  where a missing branch renders the Library page under `/pulse` with no error.

---

**1.15 — Pulse Home sections** · M · depends on 1.14

- **Touches:** `src/ui/pages/PulsePage.tsx`.
- **Do:** implement the lane-separated home composition per §2 and the freshness
  statement per §9.4.
- **Done when:** each lane container is present and distinct at every page-contract
  width, and a zero-event lane says so rather than rendering empty.
- **Do not:** merge lanes under one sort. The separation is the product promise.

---

**1.16 — Documentation** · M · depends on 1.13, 1.14

- **Touches:** `docs/PAGE_CONTRACTS.md`; `docs/DATA_POLICY.md`; `docs/PRD.md`.
- **Do:** add `## G. Pulse` to the page contracts, after `## F. Focused workbench`
  and before `## Responsive verification widths`, so the lettering stays
  contiguous; update the `## Shared shell` nav sentence at `:12`. Add the Pulse
  boundary clause to the data policy. Add a `### Pulse` block to `docs/PRD.md`
  under `## Feature Requirements`, and a row to the Information Architecture
  table.
- **Done when:** `node --test tests/alignment-contract.test.mjs` and
  `npm run style:check` pass.
- **Do not:** rename an existing `PAGE_CONTRACTS.md` section —
  `tests/graph/informationArchitecture.test.ts:84-93` asserts the six existing
  page-job names remain. **[v1.1]** Do not add a Learn article; the article id
  list is an exact ordered `deepEqual` at `tests/prd-alignment.test.mjs:26-38`
  and a seventh entry fails it. Note also that despite its name,
  `prd-alignment.test.mjs` does not read `docs/PRD.md` at all — the PRD is
  enforced only by `alignment-contract.test.mjs:41-49` and Vale.

---

**1.17 — Verification pass** · M · depends on 1.13 to 1.15

- **Touches:** `tests/e2e/accessibility.spec.mjs`; visual and responsive checks.
- **Do:** add the Pulse routes to the accessibility spec. Verify the page-contract
  widths. Run `npm run precommit` once.
- **Done when:** zero serious or critical accessibility findings, all widths
  clean, and `npm run precommit` passes.
- **Do not:** run `npm run precommit` per task. It is the final integration gate,
  once (`AGENTS.md:87`).

---

### Phase 2

The community lane in full — the §3.4 policy answer first, then Reddit if it
survives that answer, GitHub Issues, GitHub Discussions via GraphQL. Then
Trending and Timeline views over the artifacts MVP already writes, By Topic, By
Community, and the additional publishers: Platform One, Iron Bank, NSA, CNSS,
DoD CIO, ComplianceAsCode, OpenSCAP, MITRE SAF. **Sizing: L overall.**

### Phase 3

Cross-record trend detection, framework timelines, topic heat maps, historical
release comparison, change-impact summaries, upcoming draft expirations. Each is
**M to L**; all depend on a populated Phase 2 corpus, and several edge close to
"recommendation engine", which is an explicit non-goal — they must stay
descriptive.

**MVP critical path:** 0.3 → 1.2 → 1.4 → 1.8 → 1.14. Roughly **6 to 8 weeks** of
focused work; the matcher (1.4) and the browse UI (1.14) are the long poles.
0.6 is short but blocks every commit that follows it, so do it early.

---

## 13. Non-goals, restated because they will be tested

Pulse is **not** a SIEM, threat-intel platform, scanner, compliance engine,
applicability engine, recommendation engine, risk calculator, or authorization
tool. It does not tell anyone what to do, what applies to them, or what their
risk is. Any Phase 3 feature that starts to imply "you should..." is out of scope
and should be refused.

---

## 14. Decisions and risks

### Decided 2026-09-07

| # | Decision | Resolution |
| --- | --- | --- |
| D1 | Reddit in the MVP | **No.** Deferred to Phase 2 behind a written user-content policy (§3.4). |
| D2 | A community lane at MVP at all | **No.** Lane 3 in full moves to Phase 2. MVP is Lanes 1, 2 and 4. Consequence: **the MVP needs no new repository secret** (§3.2). |

### Still open, with recommendations

| # | Decision or risk | Why it needs you | Recommendation |
| --- | --- | --- | --- |
| D3 | Pulse in the primary nav or the overflow menu | The header is at 6 primary plus 3 overflow, and two tests hardcode that set (§9.2) | Overflow at launch |
| D4 | Weekly freshness, or a faster Pulse-only cron | A daily cron means more CI minutes and more refresh PRs to review; the cron string is cross-checked against `ci.yml` (§8.1) | Weekly at MVP; revisit with real usage |
| D5 | Human review of every Pulse refresh, or auto-merge for Pulse-only changes | Current model is a draft PR; weekly review is real ongoing work | Keep human review at MVP |
| D6 | Tier 6 semantic matching on record pages | The main noise risk | Off at MVP (§6.3) |
| D7 | Who authors the alias and exclusion file, and how it is reviewed | It is the one judgement layer in Pulse | Same review bar as `framework-lenses.json` |
| R1 | **Matcher precision** — a wrong event on a control page damages trust more than a missing one | — | Bias to precision; require 0.40; golden tests |
| R2 | Feed churn — publishers change feed shapes without notice | — | Per-source failure isolation; `verify:pulse` catches silent zeroes |
| R3 | Review burden — a weekly PR is ongoing human cost | — | Reduced by D2; keep the MVP source count small |
| R4 | Reproducibility regressions from any stray `Date.now()` | — | Lint rule banning it in Pulse scripts |
| R5 | Scope creep toward advice | — | §13 as an explicit test |
| R6 | **[v1.1]** Unverified Lane 2 endpoints | Six URLs in §7 are shapes, not facts | Verification is step 1 of work order 1.5, before any parsing code |

---

## 15. Conflicts with the brief, stated plainly

1. **"Community Pulse in MVP".** Decided against (§3.4). The reason is policy,
   not effort: Reddit's terms govern exactly what Pulse would do, and this
   repository has no written position on third-party user content. Phase 2 opens
   with that position.
2. **"Mattermost, mailing lists, public Slack" for Lane 3.** These have no
   general public read API. Mattermost is self-hosted per instance; Slack
   requires per-workspace app installation and its terms restrict redisplay;
   mailing lists vary by archive software. Treat these as **Phase 3 research**,
   not committed sources.
3. **"Static JSON to Search Index" as one step.** In this repo, search shards
   have a hard 320,000 gzip-byte budget, so this is two steps with a sharding
   manifest, not one (§3.6).
4. **`severity` in the schema.** Retained, but `null` unless a publisher states
   it. Deriving severity would be inventing.
5. **Freshness expectations.** "Pulse is the weather" suggests immediacy; the
   architecture delivers weekly. The UI must not paper over this (§9.4).
6. **Requested plan path.** The brief asked for
   `docs/plans/pulse-implementation.md`. `tests/alignment-contract.test.mjs:31-39`
   enforces that `docs/` contains exactly a 15-path canonical set plus at most
   one active plan at `docs/Plan.md`, using `assert.deepEqual` on the full sorted
   file list, so the requested path fails `npm test`. The plan is filed at the
   sanctioned path. If a `docs/plans/` archive is genuinely wanted, that contract
   has to be changed deliberately — it exists to stop plan sprawl, and quietly
   widening it to fit one file is the wrong way to make that decision.

---

## 16. What this plan deliberately does not do

It does not write code, and it does not choose final feed URLs. The six endpoints
marked **(verify)** in §7 are shapes, not facts. Verifying them against publisher
documentation was explicitly out of scope for the session that produced v1.1, and
`AGENTS.md:89` forbids fabricating official source URLs — so verification is the
first step of work order 1.5 rather than a value quietly filled in here. This is
the same rule the rest of the repository follows: unknown upstream facts are
recorded as unknown rather than estimated.
