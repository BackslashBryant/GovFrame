# Control Atlas Operations, Verification, and Release

- **Owner:** Nexus and Pixel
- **Status:** Canonical
- **Last reviewed:** 2026-08-27
- **Supersession:** Update this contract and the corresponding package scripts or workflows in the same approved change.

## Local gates

### Recover a validated refresh PR

If a refresh passes ingestion, repository verification and SBOM generation but
cannot create its PR, retain `automation/source-refresh`. Dispatch **Control Atlas
CI** on `main` with task `recover-refresh-pr`, the original `refresh_run_id`, and
the full `refresh_head_sha` recorded in the failed PR action. Recovery verifies
the run, snapshot parent, recorded SHA and data-only changes before creating a
draft using the Actions token. It never refetches data or merges the draft.

Use `npm run refresh:recover-pr -- --verify-only` with `GITHUB_REPOSITORY`,
`REFRESH_RUN_ID` and `REFRESH_HEAD_SHA` to inspect the proof without creating a PR.

### Build and verification commands

- `npm run build:data` rebuilds and reconciles generated source truth.
- `npm run build:site` produces `dist/site`.
- `npm run verify:quality` runs discovery, manifest, hygiene, OSCAL, lint, type, unit, browser-contract, DOM, and public-artifact gates.
- `npm run resources:enrich` refreshes README facts and presentation evidence for supported repositories; `npm run resources:validate-media` verifies attributable image responses.
- `npm run verify:ingestion` checks the shared ten-stage lifecycle for all catalog artifacts, all publisher catalogs, and all Resources entries.
- `npm run test:a11y:smoke` checks representative accessibility paths.
- `npm run test:e2e:smoke` checks representative product workflows.
- `npm run precommit` is the complete local ship gate.
- `npm run verify:affected` prints changed paths, selected checks, approximate
  test count, workers, and runtime budget without executing them.
- `npm run verify:affected -- --run` executes that bounded plan. Unknown data or
  UI paths fail closed until a source-specific or route-family mapping exists.

Use the cheapest faithful contract test during development. No routine
iteration step may exceed 50 tests or two minutes; the affected runner enforces
those per-step limits. Run corpus rebuilds and browser matrices only at final
integration unless a changed input explicitly invalidates their evidence.

## Shipping contract

1. Work on a feature branch and keep commits narrow.
2. Pass the printed affected local gate for each phase. Run the complete local
   ship gate once after final Epic inputs freeze.
3. Push with `npm run git:push` and open a pull request to `main`.
4. Require exact-head CI and security checks to pass.
5. Verify a fresh checkout of the remote branch.
6. Merge through the repository ship flow; never merge locally around CI.
7. Verify the deployed `release.json` commit equals merged `main` and that its separately labeled product-release and source-data timestamps match the rendered footer.
8. Inspect representative live desktop and mobile routes, keyboard behavior, overflow, and key source records.
9. Keep release evidence in CI artifacts, the pull request, and the release—not a dated documentation file.
10. Delete the completed `docs/Plan.md`, remove clean temporary worktrees and merged local branches, and prune worktrees.

## Evidence boundaries

Automated browser emulation is not physical-device evidence. Automated axe is not hands-on NVDA, VoiceOver, or TalkBack evidence. Report those external checks as unverified until they actually occur. A release may proceed only when the owner has explicitly accepted any remaining non-blocking external evidence gap.

An obsolete public hostname for an earlier release still exists in the wild and returns a GitHub Pages 404. The account that publishes Control Atlas does not own that repository, so no redirect can be published from here; the 404 is an external ownership limitation, not a defect this repository can close. `tests/browser-contract.test.mjs` fails the build if any tracked product or documentation file reintroduces that hostname. Publish a canonical redirect only if the legacy Pages property ever becomes available.

## Runtime boundary

The deployed site is static and public-data-only. It has no backend, authentication, telemetry, user uploads, organizational data, compliance scoring, operational integrations, or stored generated templates.
