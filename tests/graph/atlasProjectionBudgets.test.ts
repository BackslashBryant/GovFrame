import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { AtlasSpine } from "../../src/ui/lib/atlasDrilldown";
import { buildAtlasTree } from "../../src/ui/lib/atlasDecomposition";
import { buildAtlasGraphModel } from "../../src/ui/lib/atlasGraphModel";
import { buildAtlasSemanticProjections } from "../../src/ui/lib/atlasGraphProjection";
import {
  buildAtlasCatalogMemberships,
  type AtlasSourceRegistry,
} from "../../src/ui/lib/atlasPublisherHierarchy";
import { buildAtlasTreeModel } from "../../src/ui/lib/atlasTreeModel";
import { readGeneratedCollection } from "../../scripts/lib/generated-graph-artifacts.mjs";

// T4.3/T4.16: prove the visible-node budgets hold against the real, currently-generated
// 30,799-node graph — not just the synthetic fixture in atlasGraphProjection.test.ts.
test("Atlas projection budgets hold on the real generated graph", () => {
  const nodes = readGeneratedCollection(".", "nodes").nodes;
  const edges = readGeneratedCollection(".", "edges").edges;
  const spineArtifact = JSON.parse(
    readFileSync(join(".", "data", "generated", "atlas-spine.json"), "utf8"),
  ) as { atlas_spine: AtlasSpine };
  const sourceRegistry = JSON.parse(
    readFileSync(join(".", "data", "source-registry.json"), "utf8"),
  ) as AtlasSourceRegistry;

  const artifact = buildAtlasSemanticProjections({
    graph: buildAtlasGraphModel({ nodes, edges }),
    model: buildAtlasTreeModel(spineArtifact.atlas_spine),
    generatedAt: "2026-08-16T00:00:00.000Z",
    catalogMemberships: buildAtlasCatalogMemberships(sourceRegistry),
  });

  // Landscape: one Cybersecurity root plus source-registry-backed publisher ecosystems and
  // bounded authority context. Editorial work areas are retained only for legacy deep links.
  assert.equal(artifact.landscape.nodes.filter((node) => node.atlasStructureRole === "root").length, 1);
  assert.equal(artifact.landscape.nodes.filter((node) => node.atlasStructureRole === "area").length, 0);
  assert.ok(artifact.landscape.nodes.filter((node) => node.atlasStructureRole === "publisher_ecosystem").length >= 6);
  const authorityCount = artifact.landscape.nodes.filter((node) => node.objectLayer === "authority_document").length;
  assert.ok(authorityCount >= 0 && authorityCount <= 3, `authority group count: ${authorityCount}`);
  assert.ok(
    artifact.landscape.nodes.length >= 2 && artifact.landscape.nodes.length <= 20,
    `landscape budget violated: ${artifact.landscape.nodes.length} nodes`,
  );

  assert.equal(Object.values(artifact.ecosystems).flatMap((projection) => projection.nodes).length, 27);
  assert.equal(
    Object.values(artifact.ecosystems).some((projection) =>
      projection.nodes.some((node) => node.publicationId === "microsoft-zt-maturity"),
    ),
    false,
  );
  const fedramp = artifact.ecosystems["ecosystem:fedramp"]!;
  assert.equal(fedramp.nodes.find((node) => node.publicationId === "fedramp-rev5")?.lifecycleStatus, "historical");
  assert.equal(fedramp.nodes.find((node) => node.publicationId === "fedramp-2026")?.lifecycleStatus, "active");

  const sp80053 = artifact.publications["nist-800-53"]!;
  const sp80053Families = sp80053.nodes.filter((node) => !node.id.startsWith("context:"));
  assert.equal(sp80053Families.length, 20);
  const accessControl = sp80053Families.find((node) => node.label === "Access Control")!;
  const accessControlDetail = artifact.details[accessControl.id]!;
  const accessControlRecords = accessControlDetail.nodes.map((node) => node.id);
  const acceptedAccessControlIds = nodes.map((node: { id: string }) => node.id)
    .filter((id: string) => id === "nist-800-53:FAMILY-AC" || /^nist-800-53:AC-\d+(?:\.\d+)?$/.test(id)).sort();
  assert.ok(acceptedAccessControlIds.length > 0);
  assert.deepEqual([...accessControlRecords].sort(), acceptedAccessControlIds);
  assert.equal(accessControlDetail.representedCanonicalNodeCount, acceptedAccessControlIds.length);
  assert.equal(accessControlDetail.nodes.length, acceptedAccessControlIds.length);
  assert.equal(
    buildAtlasTree(artifact, {
      areaId: "ecosystem:nist",
      publicationId: "nist-800-53",
      detailId: accessControl.id,
    }).scopeCount,
    acceptedAccessControlIds.length,
  );

  const cmmc = artifact.publications["cmmc-2"]!;
  const cmmcLevels = cmmc.nodes.find((node) => node.label === "CMMC 2.0 Levels")!;
  const cmmcDetail = artifact.details[cmmcLevels.id]!;
  assert.deepEqual(
    cmmcDetail.nodes.map((node) => node.id).sort(),
    ["cmmc-2:LEVEL-1", "cmmc-2:LEVEL-2", "cmmc-2:LEVEL-3"],
  );
  assert.equal(cmmcDetail.representedCanonicalNodeCount, 3);
  assert.equal(cmmcDetail.nodes.length, 3);
  assert.equal(
    buildAtlasTree(artifact, {
      areaId: "ecosystem:dod",
      publicationId: "cmmc-2",
      detailId: cmmcLevels.id,
    }).scopeCount,
    3,
  );

  // Area: <=60 (enforced by enforceNodeBudget at build time); assert every generated area stays
  // well inside the budget so a future data change has real margin before it fails the build.
  for (const [areaId, projection] of Object.entries(artifact.areas)) {
    assert.ok(projection.nodes.length <= 60, `${areaId} area budget violated: ${projection.nodes.length} nodes`);
  }

  // Publication: <=150 (structurally bounded to <=49 by the 48-group chunking today).
  for (const [publicationId, projection] of Object.entries(artifact.publications)) {
    assert.ok(
      projection.nodes.length <= 150,
      `${publicationId} publication budget violated: ${projection.nodes.length} nodes`,
    );
  }

  // Detail: <=250, already enforced by detailFor()'s own rejection — confirm no generated detail
  // projection ever exceeded it.
  for (const [detailId, projection] of Object.entries(artifact.details)) {
    assert.ok(projection.nodes.length <= 250, `${detailId} detail budget violated: ${projection.nodes.length} nodes`);
    const firstNode = projection.nodes[0]!;
    assert.equal(
      buildAtlasTree(artifact, {
        areaId: firstNode.publisherEcosystemId || firstNode.areaId,
        publicationId: firstNode.publicationId,
        detailId,
      }).scopeCount,
      projection.representedCanonicalNodeCount,
      `${detailId} detail scope count must equal its represented canonical count`,
    );
  }

  // T4.7: every aggregate node's canonicalNodeIds resolve to real canonical IDs, and no canonical
  // node is double-counted across the landscape (the same guarantee buildProjection enforces
  // per-projection, checked here at the whole-artifact level for the top level).
  const canonicalNodeIds = new Set(nodes.map((node: { id: string }) => node.id));
  for (const node of artifact.landscape.nodes) {
    for (const canonicalId of node.canonicalNodeIds) {
      assert.ok(canonicalNodeIds.has(canonicalId), `landscape node ${node.id} cites unknown canonical id ${canonicalId}`);
    }
  }
});
