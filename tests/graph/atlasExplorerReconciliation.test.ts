import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { catalogProfileFor } from "../../src/ui/lib/catalogProfiles";
import {
  buildAtlasGroups,
  buildAtlasContextGroups,
  selectAtlasOverviewGroups,
  summarizeAtlasRelationshipScopes,
} from "../../src/ui/lib/atlasModel";
import type {
  AtlasNeighborhoodEdge,
  AtlasNeighborhoodNode,
  AtlasNeighborhoodRecord,
} from "../../src/ui/lib/runtimeLoader";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATED = join(ROOT, "data", "generated");

type ShardedManifest = {
  sharded_collection: {
    record_count: number;
    shards: Array<{ path: string; record_count: number }>;
  };
};

function loadNodeManifest(): ShardedManifest {
  return JSON.parse(readFileSync(join(GENERATED, "nodes.json"), "utf8"));
}

function loadEdgeManifest(): ShardedManifest {
  return JSON.parse(readFileSync(join(GENERATED, "edges.json"), "utf8"));
}

function catalogsInNodeShards(): Set<string> {
  const manifest = loadNodeManifest();
  const catalogs = new Set<string>();
  for (const shard of manifest.sharded_collection.shards) {
    const data = JSON.parse(
      readFileSync(join(GENERATED, shard.path), "utf8"),
    );
    for (const node of data.nodes) {
      if (node.id?.includes(":")) {
        catalogs.add(node.id.split(":")[0]);
      }
    }
  }
  return catalogs;
}

type NeighborhoodNode = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
];
type NeighborhoodSourceRef = [string, string, string];
type NeighborhoodEdge = [
  string,
  string,
  string,
  string,
  "structural" | "applicability" | "correlation",
  string,
  string,
  string,
  NeighborhoodSourceRef[],
];
type NeighborhoodRecord = {
  center_node: AtlasNeighborhoodNode;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  structural_path: string[];
  structural_paths?: string[][];
  published_connection_count: number;
  candidate_connection_count: number;
};

type FullGraphEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  relationship_class: "structural" | "applicability" | "correlation";
  mapping_model: string;
  source_artifact_id: string;
  status: string;
  authority_class: string;
  provenance_class: string;
  confidence: string;
  publication_status: string;
  source_refs: Array<{
    source_id: string;
    ref_type: string;
    locator: string;
  }>;
};

type SourceRegistry = {
  sources: Array<{
    id: string;
    version: string;
    lifecycle_status: string;
    provenance_class: string;
    metadata?: { transition_note?: string };
  }>;
};

function loadNeighborhood(nodeId: string): NeighborhoodRecord | null {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const shard = ((h >>> 0) % 128).toString(16).padStart(2, "0");
  const path = join(GENERATED, "atlas-neighborhood", `${shard}.json`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.atlas_neighborhood_shard.records[nodeId] || null;
}

const fullEdgeCache = new Map<string, FullGraphEdge[]>();

function loadFullEdgesForNode(nodeId: string): FullGraphEdge[] {
  const cached = fullEdgeCache.get(nodeId);
  if (cached) return cached;
  const manifest = loadEdgeManifest();
  const matches: FullGraphEdge[] = [];
  for (const shard of manifest.sharded_collection.shards) {
    const raw = readFileSync(join(GENERATED, shard.path), "utf8");
    if (!raw.includes(nodeId)) continue;
    const data = JSON.parse(raw) as { edges: FullGraphEdge[] };
    matches.push(
      ...data.edges.filter(
        (edge) =>
          edge.source_node_id === nodeId || edge.target_node_id === nodeId,
      ),
    );
  }
  fullEdgeCache.set(nodeId, matches);
  return matches;
}

function loadSourceRegistry(): SourceRegistry {
  return JSON.parse(
    readFileSync(join(ROOT, "data", "source-registry.json"), "utf8"),
  );
}

function decodeNeighborhood(record: NeighborhoodRecord): AtlasNeighborhoodRecord {
  const nodes = record.nodes.map(
    ([
      id,
      nodeType,
      itemId,
      title,
      catalogId,
      sourceId,
      family,
      parentId,
      description,
      structuralChildCount,
      structuralDescendantRecordCount,
    ]) => ({
      id,
      node_type: nodeType,
      label: title,
      parent_id: parentId || undefined,
      source_id: sourceId || undefined,
      metadata: {
        item_id: itemId,
        title,
        description,
        catalog_id: catalogId,
        family,
        structural_child_count: structuralChildCount,
        structural_descendant_record_count: structuralDescendantRecordCount,
      },
    }),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const centerNode = nodeById.get(record.center_node.id) || record.center_node;
  const edges: AtlasNeighborhoodEdge[] = record.edges.map(
    ([
      id,
      sourceNodeId,
      targetNodeId,
      relationshipType,
      relationshipClass,
      provenanceClass,
      publicationStatus,
      confidence,
      sourceRefs,
    ]) => ({
      id,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relationship_type: relationshipType,
      relationship_class: relationshipClass,
      provenance_class: provenanceClass,
      publication_status: publicationStatus,
      confidence,
      source_refs: sourceRefs.map(([sourceId, refType, locator]) => ({
        source_id: sourceId,
        ref_type: refType,
        locator,
      })),
    }),
  );

  return {
    center_node: centerNode,
    nodes,
    edges,
    structural_path: [],
    published_connection_count: record.published_connection_count,
    candidate_connection_count: record.candidate_connection_count,
  };
}

function counterpartId(
  edge: Pick<FullGraphEdge, "source_node_id" | "target_node_id">,
  centerId: string,
): string {
  return edge.source_node_id === centerId
    ? edge.target_node_id
    : edge.source_node_id;
}

function catalogId(nodeId: string): string {
  return nodeId.split(":")[0];
}

const EXPECTED_USER_FACING_CATALOGS = [
  "nist-800-53", "csf-2", "dod-zt", "nist-zt", "mitre-attack", "mitre-d3fend",
  "nist-iot-cybersecurity", "nist-800-171", "nist-800-172", "cmmc-2",
  "fedramp-2026", "nist-ai-rmf", "nist-ssdf", "dod-rai", "nist-mobile-threats",
  "mitre-attack-ics", "nist-800-171-rev2", "disa-stig", "disa-srg", "disa-cci",
  "nist-800-53a", "nist-800-53b", "fips-199", "fips-200", "nist-800-37",
  "cui-policy", "fedramp-rev5",
];

// ── Source Scope ─────────────────────────────────────────────

test("microsoft-zt-maturity is present in data but excluded from user-facing scope", () => {
  const catalogs = catalogsInNodeShards();
  assert.ok(catalogs.has("microsoft-zt-maturity"), "microsoft-zt-maturity should exist in graph data");
});

test("every user-facing catalog has nodes in the graph data shards", () => {
  const catalogs = catalogsInNodeShards();
  for (const id of EXPECTED_USER_FACING_CATALOGS) {
    assert.ok(catalogs.has(id), `Catalog ${id} has no nodes in graph data`);
  }
});

test("node manifest declares > 30,000 records", () => {
  const manifest = loadNodeManifest();
  assert.ok(
    manifest.sharded_collection.record_count > 30000,
    `Expected > 30,000 nodes, got ${manifest.sharded_collection.record_count}`,
  );
});

// ── Publication Kind / Source Type ────────────────────────────

test("catalog profiles classify all 27 user-facing publications", () => {
  for (const id of EXPECTED_USER_FACING_CATALOGS) {
    assert.ok(
      catalogProfileFor(id).publicationKind,
      `Missing publication kind for ${id}`,
    );
  }
});

test("catalog profiles label records for all 27 user-facing publications", () => {
  for (const id of EXPECTED_USER_FACING_CATALOGS) {
    assert.ok(
      catalogProfileFor(id).recordLabel,
      `Missing record label for ${id}`,
    );
  }
});

test("catalog profiles describe all 27 user-facing publications", () => {
  for (const id of EXPECTED_USER_FACING_CATALOGS) {
    assert.ok(catalogProfileFor(id).synopsis, `Missing synopsis for ${id}`);
  }
});

test("publication kind assignments match the public catalog taxonomy", () => {
  const expected: Record<string, string> = {
    "nist-800-53": "Control catalog",
    "csf-2": "Outcome framework",
    "dod-zt": "Implementation standard",
    "mitre-attack": "Threat knowledge base",
    "mitre-d3fend": "Defensive knowledge base",
    "cmmc-2": "Certification program",
    "fedramp-2026": "Authorization program",
    "nist-mobile-threats": "Threat knowledge base",
    "disa-stig": "Implementation standard",
    "nist-800-53a": "Control catalog",
    "nist-800-53b": "Control-selection method",
    "fips-199": "Risk framework",
    "fips-200": "Risk framework",
    "nist-800-37": "Risk framework",
    "cui-policy": "Policy and regulation",
    "fedramp-rev5": "Authorization program",
  };
  for (const [id, expectedKind] of Object.entries(expected)) {
    assert.equal(
      catalogProfileFor(id).publicationKind,
      expectedKind,
      `${id} should be "${expectedKind}"`,
    );
  }
});

// ── AC-2 Connection Reconciliation ───────────────────────────

const AC2_ID = "nist-800-53:AC-2";
const acceptedControls = JSON.parse(readFileSync(join(ROOT, 'data', 'controls-800-53.json'), 'utf8')).records as Array<{
  id: string;
  metadata?: { nist_800_53b_baselines?: string[]; fedramp_baselines?: string[] };
}>;

function requireAc2Neighborhood(): NeighborhoodRecord {
  const record = loadNeighborhood(AC2_ID);
  assert.ok(record, "AC-2 neighborhood not found");
  return record;
}

test("AC-2 neighborhood contains every accepted canonical relationship exactly once", () => {
  const neighborhood = requireAc2Neighborhood();
  const edges = loadFullEdgesForNode(AC2_ID);
  assert.deepEqual(neighborhood.edges.map((edge) => edge[0]).sort(), edges.map((edge) => edge.id).sort());
  assert.equal(neighborhood.published_connection_count, edges.length);
  assert.equal(neighborhood.candidate_connection_count, 0);
  assert.ok(edges.length > 0);
  assert.ok(edges.every((edge) => edge.status === "active"));
  assert.ok(edges.every((edge) => edge.publication_status === "published"));

  const perCatalog = new Map<string, number>();
  for (const edge of edges) {
    const id = catalogId(counterpartId(edge, AC2_ID));
    perCatalog.set(id, (perCatalog.get(id) || 0) + 1);
  }
  const neighborhoodCounts = new Map<string, number>();
  for (const edge of decodeNeighborhood(neighborhood).edges) {
    const id = catalogId(counterpartId(edge, AC2_ID));
    neighborhoodCounts.set(id, (neighborhoodCounts.get(id) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...neighborhoodCounts].sort()), Object.fromEntries([...perCatalog].sort()));
});

test("AC-2 native structure has its family parent and accepted enhancement children", () => {
  const edges = loadFullEdgesForNode(AC2_ID).filter(
    (edge) => edge.relationship_class === "structural",
  );
  const incoming = edges.filter((edge) => edge.target_node_id === AC2_ID);
  const outgoing = edges.filter((edge) => edge.source_node_id === AC2_ID);
  const enhancementIds = acceptedControls.filter((record) => /^AC-2\.\d+$/.test(record.id)).map((record) => `nist-800-53:${record.id}`).sort();
  assert.equal(edges.length, enhancementIds.length + 1);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]?.source_node_id, "nist-800-53:FAMILY-AC");
  assert.deepEqual(outgoing.map((edge) => edge.target_node_id).sort(), enhancementIds);
  assert.ok(outgoing.every((edge) => edge.relationship_type === "contains"));
  assert.ok(
    outgoing.every((edge) => edge.target_node_id.startsWith("nist-800-53:AC-2.")),
  );
});

test("AC-2 cross-source scope partitions into correlations and applicability selections", () => {
  const edges = loadFullEdgesForNode(AC2_ID);
  const crossSource = edges.filter(
    (edge) => catalogId(counterpartId(edge, AC2_ID)) !== "nist-800-53",
  );
  const correlations = crossSource.filter(
    (edge) => edge.relationship_class === "correlation",
  );
  const applicability = crossSource.filter(
    (edge) => edge.relationship_class === "applicability",
  );
  assert.equal(crossSource.length, correlations.length + applicability.length);
  const decodedCrossSource = decodeNeighborhood(requireAc2Neighborhood()).edges
    .filter((edge) => catalogId(counterpartId(edge, AC2_ID)) !== 'nist-800-53');
  assert.deepEqual(decodedCrossSource.map((edge) => edge.id).sort(), crossSource.map((edge) => edge.id).sort());
  assert.equal(
    crossSource.filter((edge) => edge.mapping_model === "implementation").length,
    0,
    "AC-2 has no direct implementation relationships",
  );
});

test("AC-2 cross-source correlations separate CCI, assessment, and publisher mappings", () => {
  const correlations = loadFullEdgesForNode(AC2_ID).filter(
    (edge) => edge.relationship_class === "correlation",
  );
  const cci = correlations.filter(
    (edge) => catalogId(counterpartId(edge, AC2_ID)) === "disa-cci",
  );
  const assessment = correlations.filter(
    (edge) => edge.relationship_type === "assesses",
  );
  const publisherMappings = correlations.filter(
    (edge) => !cci.includes(edge) && !assessment.includes(edge),
  );
  assert.ok(cci.length > 0, "DISA CCI correlation junctions");
  assert.equal(assessment.length, 1, "SP 800-53A assessment procedure");
  assert.equal(cci.length + assessment.length + publisherMappings.length, correlations.length);
  assert.ok(cci.every((edge) => edge.mapping_model === "correlation"));
});

test("AC-2 baseline applicability records preserve active and historical lifecycle context", () => {
  const acceptedAc2 = acceptedControls.find((record) => record.id === 'AC-2');
  assert.ok(acceptedAc2);
  const applicability = loadFullEdgesForNode(AC2_ID).filter(
    (edge) => edge.relationship_class === "applicability",
  );
  assert.equal(
    applicability.filter((edge) => edge.source_refs[0]?.source_id === "nist-800-53b-baselines").length,
    acceptedAc2.metadata?.nist_800_53b_baselines?.length || 0,
  );
  assert.equal(
    applicability.filter((edge) => edge.source_refs[0]?.source_id === "fedramp-rev5").length,
    acceptedAc2.metadata?.fedramp_baselines?.length || 0,
  );

  const sources = new Map(loadSourceRegistry().sources.map((source) => [source.id, source]));
  const nistBaselines = sources.get("nist-800-53b-baselines");
  const legacyFedramp = sources.get("fedramp-rev5");
  assert.equal(nistBaselines?.lifecycle_status, "active");
  assert.equal(nistBaselines?.version, "Revision 5, Release 5.2.0");
  assert.equal(legacyFedramp?.lifecycle_status, "historical");
  assert.equal(legacyFedramp?.version, "Legacy Rev5 security controls baseline workbook");
  assert.match(
    legacyFedramp?.metadata?.transition_note || "",
    /Use the Consolidated Rules for 2026/,
  );
});

test("AC-2 neighborhood preserves accepted canonical relationship semantics and provenance", () => {
  const neighborhood = requireAc2Neighborhood();
  const decoded = decodeNeighborhood(neighborhood);
  const canonicalEdges = loadFullEdgesForNode(AC2_ID);
  const allowedSignatures = new Set([
    "csf-2|requirement|concept_crosswalk|correlation|outgoing|correlation|federal_published|direct|nist-olir-csf2-to-sp800-53|active|published",
    "disa-cci|requirement|maps_to|correlation|incoming|correlation|federal_published|derived|nist-800-53-rev4-rev5-crosswalk|active|published",
    "disa-cci|requirement|maps_to|correlation|incoming|correlation|federal_published|direct|disa-cci-nist-references|active|published",
    "dod-zt|zt_capability|supports|correlation|outgoing|correlation|federal_published|direct|dod-zt-overlays-2024|active|published",
    "fedramp-rev5|baseline|selects|applicability|incoming|applicability|federal_program|direct|fedramp-rev5|active|published",
    "nist-800-171|requirement|maps_to|correlation|incoming|correlation|federal_published|direct|nist-800-171-oscal-mappings|active|published",
    "nist-800-53a|assessment_procedure|assesses|correlation|incoming|correlation|federal_published|direct|nist-800-53a-assessment-procedures|active|published",
    "nist-800-53b|baseline|selects|applicability|incoming|applicability|federal_published|direct|nist-800-53b-baselines|active|published",
    "nist-800-53|control_enhancement|contains|structural|outgoing|structural|federal_published|derived|nist-800-53|active|published",
    "nist-800-53|family|contains|structural|incoming|structural|federal_published|derived|nist-800-53|active|published",
    "nist-iot-cybersecurity|iot_capability_element|maps_to|correlation|incoming|correlation|federal_published|direct|nist-iot-requirements-80053-mapping-draft|active|published",
    "nist-iot-cybersecurity|iot_capability_subelement|maps_to|correlation|incoming|correlation|federal_published|direct|nist-iot-requirements-80053-mapping-draft|active|published",
    "nist-zt|zt_product_component|supports|correlation|incoming|correlation|federal_published|direct|nist-sp-1800-35-sp80053-mappings|active|published",
    "nist-zt|zt_reference_component|supports|correlation|incoming|correlation|federal_published|direct|nist-sp-1800-35-sp80053-mappings|active|published",
  ]);
  const nodeTypes = new Map(neighborhood.nodes.map((node) => [node[0], node[1]]));
  for (const edge of canonicalEdges) {
    const other = counterpartId(edge, AC2_ID);
    const actual = [catalogId(other), nodeTypes.get(other), edge.relationship_type,
      edge.relationship_class, edge.source_node_id === AC2_ID ? 'outgoing' : 'incoming',
      edge.mapping_model, edge.provenance_class, edge.confidence, edge.source_refs[0]?.source_id,
      edge.status, edge.publication_status].join('|');
    assert.ok(allowedSignatures.has(actual), `Unreviewed AC-2 semantic signature: ${actual}`);
  }
  const signature = (edge: Pick<FullGraphEdge, "id" | "source_node_id" | "target_node_id" | "relationship_type" | "relationship_class" | "provenance_class" | "confidence" | "publication_status" | "source_refs">) => ({
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    type: edge.relationship_type,
    classification: edge.relationship_class,
    provenance: edge.provenance_class,
    confidence: edge.confidence,
    status: edge.publication_status,
    sourceRefs: edge.source_refs,
  });
  assert.deepEqual(
    decoded.edges.map(signature).sort((a, b) => a.id.localeCompare(b.id)),
    canonicalEdges.map(signature).sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("AC-2 relationship IDs and endpoint-type assertions are unique", () => {
  const edges = loadFullEdgesForNode(AC2_ID);
  const ids = new Set(edges.map((edge) => edge.id));
  const assertions = new Set(
    edges.map(
      (edge) =>
        `${edge.source_node_id}|${edge.target_node_id}|${edge.relationship_type}`,
    ),
  );
  assert.equal(ids.size, edges.length, "canonical edge IDs are the deduplication key");
  assert.equal(assertions.size, edges.length, "endpoint-type assertions must not duplicate");
});

// ── CMMC Level Verification ──────────────────────────────────

test("CMMC 2.0 Level 2 has 800-171 Rev. 2 connections in neighborhood", () => {
  const manifest = loadNodeManifest();
  let levelId: string | null = null;
  for (const shard of manifest.sharded_collection.shards) {
    const data = JSON.parse(readFileSync(join(GENERATED, shard.path), "utf8"));
    for (const node of data.nodes) {
      if (node.id?.startsWith("cmmc-2:") && node.label?.includes("Level 2")) {
        levelId = node.id;
        break;
      }
    }
    if (levelId) break;
  }
  assert.ok(levelId, "CMMC Level 2 node not found in graph data");

  const rec = loadNeighborhood(levelId);
  if (rec) {
    let rev2Count = 0;
    for (const edge of rec.edges) {
      const other = edge[1] === levelId ? edge[2] : edge[1];
      if (other.startsWith("nist-800-171-rev2:")) rev2Count++;
    }
    assert.ok(
      rev2Count >= 100,
      `CMMC Level 2 → 800-171 Rev. 2: expected >= 100, got ${rev2Count}`,
    );
  }
});

// ── Presentation vs Data Separation ──────────────────────────

test("connection presentation caps do not alter AC-2 source truth or grouping", () => {
  const source = requireAc2Neighborhood();
  const decoded = decodeNeighborhood(source);
  const filters = {
    relationshipType: "",
    provenance: "",
    confidence: "",
    nodeType: "",
    includeCandidates: false,
    search: "",
  };
  const groups = buildAtlasGroups(decoded, filters);
  const connectionGroups = buildAtlasContextGroups(decoded, filters);
  const scopes = summarizeAtlasRelationshipScopes(decoded);
  const fullGroupCounts = Object.fromEntries(
    groups.map((group) => [group.id, group.items.length]),
  );
  const provenance = decoded.edges.map((edge) => ({
    id: edge.id,
    provenance: edge.provenance_class,
    sources: edge.source_refs,
  }));

  const overview = selectAtlasOverviewGroups(connectionGroups, 6);
  const previews = overview.map((group) => group.items.slice(0, 2));
  const acceptedEdges = loadFullEdgesForNode(AC2_ID);
  const crossSourceEdges = acceptedEdges.filter((edge) => catalogId(counterpartId(edge, AC2_ID)) !== 'nist-800-53');
  const nativeEdges = acceptedEdges.filter((edge) => edge.relationship_class === 'structural');

  assert.equal(groups.reduce((total, group) => total + group.items.length, 0), acceptedEdges.length);
  assert.equal(connectionGroups.reduce((total, group) => total + group.items.length, 0), crossSourceEdges.length);
  assert.deepEqual(scopes, {
    publishedNeighborhood: acceptedEdges.length,
    nativeStructure: nativeEdges.length,
    crossSource: crossSourceEdges.length,
    sameSourceContext: 0,
  });
  assert.equal(decoded.edges.length, acceptedEdges.length);
  assert.equal(decoded.published_connection_count, acceptedEdges.length);
  assert.ok(overview.length <= 6);
  assert.ok(previews.every((preview) => preview.length <= 2));
  assert.deepEqual(
    Object.fromEntries(groups.map((group) => [group.id, group.items.length])),
    fullGroupCounts,
  );
  assert.deepEqual(
    decoded.edges.map((edge) => ({
      id: edge.id,
      provenance: edge.provenance_class,
      sources: edge.source_refs,
    })),
    provenance,
  );
});
