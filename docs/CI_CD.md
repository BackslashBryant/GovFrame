# Control Atlas CI/CD

- **Owner:** Nexus and Pixel
- **Status:** Canonical
- **Last reviewed:** 2026-09-09
- **Supersession:** Update this contract and the corresponding workflows or package scripts in the same approved change.

Control Atlas separates validation, source-refresh merging and deployment while
sharing one immutable site artifact.

## Workflow responsibilities

- `ci.yml` classifies changes once, runs independent quality gates, builds the site once, and publishes `site-build` for the exact commit SHA.
- `security.yml` runs dependency review, CodeQL, secret scanning, and repository hygiene without rebuilding the site.
- `deploy.yml` accepts only a successful `main` push CI run, verifies `release.json`, deploys that exact artifact, then runs production smoke and Lighthouse checks.
- `automerge-refresh.yml` runs after successful refresh PR CI or security
  completion. It loads merge tooling from `main`, requires both workflows to
  succeed for the current PR SHA, and merges only the admitted App-authored
  `automation/source-refresh` PR after path and branch-protection checks.

## Pull request graph

`Change map` determines which gates are required. Lint, types, unit tests, build, contracts, browser shards, accessibility, visual regression, Lighthouse, and workflow lint report independently. `Required CI` fails if any selected gate fails or is cancelled.

The final `checks` job mirrors `Required CI` for compatibility with the repository's existing protected-branch status context. It does not bypass or duplicate validation.

Routine checkout uses depth 1 and fetches only the comparison base SHA. Full history is reserved for the scheduled deep secret scan.

## Change-map policy

- Runtime, style, data, dependency, and browser-test changes produce a site artifact and exercise the relevant browser gates.
- Data and dependency changes force a deterministic full build.
- Automation-only changes run automation lint, CI contracts, and actionlint
  without generated data, a site build, product tests, browser matrices, or
  unrelated security jobs.
- Documentation-only changes run hygiene and prose-style contracts without a
  product build.
- Audit evidence changes run the narrow evidence-integrity gate and do not deploy.
- Unknown paths fail closed as runtime code.

## Generated data ownership

`data/generated/` is derived build output. It is ignored by Git and reconstructed from versioned publisher snapshots, curated corrections, registries, schemas, maps, parsers, and generators.

`npm run generate:data` produces the complete derived data surface. CI caches it by canonical-input hash and publishes it as an immutable intermediate artifact. The site build and data-dependent tests consume that same artifact, while browser, accessibility, Lighthouse, and deployment consume the validated `site-build` artifact.

`npm run verify:generated-reproducibility` performs two clean generations and requires identical file counts, byte counts, and SHA-256 tree digests. Generation uses `CONTROL_ATLAS_GENERATED_AT`, `SOURCE_DATE_EPOCH`, or the latest versioned source-observation date, in that order, so output does not depend on a prior generated directory, an unrelated UI commit, or wall-clock time.

Atomic JSON writers preserve identical files and mtimes. `npm run
build:site:incremental` preserves validated staged data and recompresses only
changed JSON while rebuilding application assets.

Scheduled refreshes persist an ignored HTTP cache between runs and issue strict
conditional requests. A 304 reuses previously cached bytes; network failure may
not return stale cached bytes during a required-fresh run. Every request and
redirect must satisfy the static publisher URL policy. GitHub access is limited
to admitted owner/repository pairs and endpoint paths.

The Wednesday 07:17 UTC refresh isolates each source candidate and restores its
last accepted outputs on retrieval or validation failure. Other sources continue;
independent publisher inventories, baseline limits and final candidate checks
govern admission. Supplemental observations can record an explicit unavailable
state. A source cannot grant itself new authority or revise its acceptance policy.

An always-run alert step reads the source results when a report exists. It
deduplicates quarantine issues by source, reopens recurring failures and closes
only explicit accepted recoveries. After validation, a repository-scoped App
opens a ready data PR so independent CI and security workflows run. Automatic
merge requires the expected App identity, the exact tested SHA, allowed JSON
changes and a clean protected-branch merge state. It does not admit schema,
refresh-policy, refresh-contract, application or workflow changes. A failed gate
prevents publication; routine successful refreshes require no human approval.

## Browser policy

- Pull requests use Chromium with two functional shards, axe accessibility checks, and three deliberate visual snapshots.
- Nightly verification runs the complete functional suite in Chromium, Firefox, and WebKit.
- Every nightly browser shard and the accessibility suite write a unique blob
  report name and retain GitHub-readable failure output before reports merge.
- Browser binaries are installed only for the engine each job needs. They are not cached until timing data justifies that complexity.

## Deployment guarantees

Production deployment never rebuilds routine releases. The deploy workflow downloads `site-build`, verifies that `release.json` matches the successful CI run SHA, publishes through native GitHub Pages permissions, then verifies the same SHA at the public edge.
