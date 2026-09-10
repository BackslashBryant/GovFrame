# Control Atlas

**Ctrl+Alt+Trace · Search · Explore · Compare · Build**

Control Atlas is a public research tool for federal cybersecurity requirements, controls, techniques, and guidance.

Uses public NIST, DISA, FedRAMP, MITRE, and CISA data only.
No login. No evidence upload. No organizational data stored.

Use Control Atlas for research, not compliance or authorization decisions.

## Source-First Product Standard

Future work must preserve this order:

1. Exact publication identity and official source text
2. Publisher-declared hierarchy
3. Labeled, source-traceable relationships
4. Concrete retrieval, comparison, navigation, or document action
5. Product-authored notes and limitations
6. Raw technical detail on demand

## What it does

- Finds published records by identifier or topic
- Shows exact publisher, publication, official text, and declared structure
- Traces published and candidate relationships with their provenance
- Compares records through explicitly selected published mapping sources
- Generates blank starter documents from explicitly selected inputs
- Lists external tools, templates, data, training, and communities with owner and provenance

## What it does not do

- Ingest evidence or process authorization packages
- Store user, organization, or system data
- Connect to eMASS, STIG Manager, or any operational system
- Determine applicability, baselines, compliance, inheritance, authorization, or ATO outcomes
- Replace a practitioner, assessor, ISSO, responsible authority, or AO

## Free, open source, and independent

Mappings and starter documents are based on public sources, with their owners
and limitations attached.

This application has no backend.

---

## Live Site
Live site target: https://rambulls.github.io/control-atlas/

Built by [RAM.BULLS](https://rambulls.pages.dev/). If Control Atlas saves you time, you can [support the work](https://buymeacoffee.com/ram.bulls).

## Current Reusable Foundation

- Static GitHub Pages deployment with a React + Vite translation-first shell
- Build-time public-data importers, normalizers, and validators under `scripts/`
- Stable public runtime bundles: `sources`, `nodes`, `edges`, `evidence`, and `graph-health`
- Browser-only search, browse, comparison, source inspection, and CSV export behavior
- Current D3-based relationship visualization foundation for the Epic 0 provenance filter surface and later roadmap work
- Contract, browser, runtime, and data tests enforcing the public-data-only boundary

Start with `docs/README.md`, which points to the canonical product, page, architecture, data, operations, and backlog contracts.

## Commands

```text
npm run build:data
npm run audit:deps
npm run sbom:generate
npm test
npm run test:browser
npm run audit:coverage
npm run verify:public
npm run precommit
```
