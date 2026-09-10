import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  aggregateAtlasChildren,
  aggregateAuthorityOverview,
  ATLAS_RENDER_NODE_CAP,
  TECHNOLOGY_GATE_THRESHOLD,
  maxRenderedAtlasNodes,
  renderedAtlasSet,
  requiresTechnologyGate,
} from "../../src/ui/lib/atlasTreeAggregation";
import { buildAtlasTreeModel, type AtlasTreeNode } from "../../src/ui/lib/atlasTreeModel";
import { atlasTreeCollisions, layoutAtlasTree } from "../../src/ui/lib/atlasTreeLayout";
import type { AtlasSpine } from "../../src/ui/lib/atlasDrilldown";
import { atlasNeighborhoodShardId } from "../../src/app/atlas-neighborhood.mjs";

const spine = JSON.parse(
  readFileSync(new URL("../../data/generated/atlas-spine.json", import.meta.url), "utf8"),
).atlas_spine as AtlasSpine;
const model = buildAtlasTreeModel(spine);

function benchmarkChildren(benchmarkId: string): AtlasTreeNode[] {
  const shardId = atlasNeighborhoodShardId(benchmarkId);
  const artifact = JSON.parse(readFileSync(
    new URL(`../../data/generated/atlas-neighborhood/${shardId}.json`, import.meta.url),
    "utf8",
  )).atlas_neighborhood_shard;
  const record = artifact.records[benchmarkId];
  const childIds = new Set(
    record.edges
      .filter((edge: string[]) => edge[4] === "structural" && edge[1] === benchmarkId)
      .map((edge: string[]) => edge[2]),
  );
  return record.nodes
    .filter((node: string[]) => childIds.has(node[0]))
    .map((node: string[]) => ({
      id: node[0], itemId: node[2], label: node[3], blurb: node[8], nodeType: node[1],
      parentId: benchmarkId, childCount: node[9] || 0, descendantRecordCount: node[10] || 1, level: "summary",
      alsoRequiredBy: [], sourceRefs: [], rationale: node[8] || "Publisher record.",
    } satisfies AtlasTreeNode));
}

test("real spine focus states stay within the 120-node render budget", () => {
  const maximum = maxRenderedAtlasNodes(model);
  assert.ok(maximum <= ATLAS_RENDER_NODE_CAP);
  const overview = renderedAtlasSet({ model });
  assert.equal(overview.length, 13);
  assert.equal(aggregateAuthorityOverview(model).length, 3);
  assert.equal(
    new Set(aggregateAuthorityOverview(model).flatMap((node) => node.memberIds)).size,
    model.authorityNodes.length,
  );
  assert.equal(model.publications.length, 28);
  assert.equal(model.areas.length, 9);
});

test("technology gate is general and matches the real DISA branches", () => {
  assert.equal(TECHNOLOGY_GATE_THRESHOLD, 60);
  assert.ok((model.nodesById.get("disa-stig:CATALOG")?.childCount || 0) > TECHNOLOGY_GATE_THRESHOLD);
  const srgChildren = model.nodes.filter((node) => node.parentId === "disa-srg:CATALOG");
  assert.equal(model.nodesById.get("disa-srg:CATALOG")?.childCount, srgChildren.length);
  assert.equal(requiresTechnologyGate(model.nodesById.get("disa-stig:CATALOG")!), true);
  assert.equal(requiresTechnologyGate(model.nodesById.get("disa-srg:CATALOG")!), srgChildren.length > TECHNOLOGY_GATE_THRESHOLD);
  const gated = renderedAtlasSet({ model, focusId: "disa-stig:CATALOG" });
  assert.ok(gated.some((node) => node.id === "technology-gate:disa-stig:CATALOG"));
  assert.equal(gated.filter((node) => node.parentId === "disa-stig:CATALOG").length, 1);
  const selected = renderedAtlasSet({
    model,
    focusId: "disa-stig:CATALOG",
    selectedTechnologyId: "disa-stig:BENCHMARK-ORACLE-LINUX-9-STIG",
  });
  assert.deepEqual(
    selected.filter((node) => node.parentId === "disa-stig:CATALOG").map((node) => node.id),
    ["disa-stig:BENCHMARK-ORACLE-LINUX-9-STIG"],
  );
});

test("the accepted benchmark buckets preserve exact membership independent of input order", async () => {
  const benchmarkId = "disa-stig:BENCHMARK-ORACLE-LINUX-9-STIG";
  const children = benchmarkChildren(benchmarkId);
  assert.equal(children.length, model.nodesById.get(benchmarkId)?.childCount);
  assert.equal(requiresTechnologyGate(model.nodesById.get(benchmarkId)!), false);
  const first = aggregateAtlasChildren(benchmarkId, children);
  const reversed = aggregateAtlasChildren(benchmarkId, [...children].reverse());
  assert.equal(JSON.stringify(first), JSON.stringify(reversed));
  const memberIds = first.flatMap((node) => "memberIds" in node ? node.memberIds : [node.id]);
  assert.deepEqual([...memberIds].sort(), children.map((node) => node.id).sort());
  assert.equal(new Set(memberIds).size, children.length);
  assert.ok(first.every((bucket) => "aggregate" in bucket && bucket.aggregate));
  const rendered = renderedAtlasSet({
    model,
    focusId: benchmarkId,
    selectedTechnologyId: benchmarkId,
    dynamicChildren: children,
  });
  assert.ok(rendered.length <= ATLAS_RENDER_NODE_CAP);
  assert.deepEqual(rendered.filter((node) => node.parentId === benchmarkId).map((node) => node.id).sort(), first.map((node) => node.id).sort());
  assert.deepEqual(
    atlasTreeCollisions(await layoutAtlasTree({ model, rendered, focusId: benchmarkId })),
    [],
  );
});

test("the Atlas structural index retains flat-catalog records without rendering them all", () => {
  assert.equal(model.nodesById.has("disa-cci:CCI-000366"), true);
  assert.equal(model.nodes.length, spine.entries.length);
  assert.ok(maxRenderedAtlasNodes(model) <= ATLAS_RENDER_NODE_CAP);
});

test("a drilled publication keeps its ancestry and children without sibling publications", () => {
  const publicationId = "nist-800-53:CATALOG";
  const rendered = renderedAtlasSet({ model, focusId: publicationId });
  const ids = new Set(rendered.map((node) => node.id));

  assert.equal(ids.has("atlas:TRUNK"), true);
  assert.equal(ids.has("atlas:LIMB-COMPLIANCE"), true);
  assert.equal(ids.has(publicationId), true);
  assert.equal(ids.has("nist-800-53:FAMILY-AC"), true);
  assert.equal(ids.has("fedramp-rev5:CATALOG"), false);
});
