import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { validateGraphArtifacts } from '../tools/validators/federal-graph.mjs';
import {
  CATALOG_TIERS,
  validateDataTrustContracts,
  validatePublisherNativeContainment,
} from '../scripts/build-framework-data.mjs';
import {
  CATALOG_STRUCTURE_IDS,
  catalogStructureProfile,
} from '../src/shared/catalog-structure.mjs';
import { createGeneratedFixtureReader } from './helpers/generated-fixture-cache.mjs';
import { assertPublisherVolume } from './helpers/publisher-volume.mjs';
import {
  RELATIONSHIP_CLASSES,
  isValidatedStructuralEdge,
  isValidatedStructuralPointer,
} from '../src/app/structural-hierarchy.mjs';
import {
  ATLAS_STRUCTURE_NODE_TYPES,
  AUTHORITY_DOCUMENT_NODE_TYPES,
  OBJECT_LAYERS,
  resolveNativeType,
} from '../src/shared/data-trust-contracts.mjs';
import { recordPresentationContract } from '../src/shared/record-presentation.mjs';
import { repairKnownSourceEncoding } from '../src/shared/text-fidelity.mjs';

const generated = createGeneratedFixtureReader();
// build-framework-data.mjs omits evidence_ids from an edge when it is
// exactly the mechanical `evidence:<edge-id-suffix>` pattern (a real ~2 MiB
// budget win — see scripts/build-framework-data.mjs); derive it back here,
// same as src/app/runtime.mjs's evidenceIdsFor.
const evidenceIdsFor = (edge) =>
  edge.evidence_ids !== undefined ? edge.evidence_ids : [`evidence:${edge.id.slice('edge:'.length)}`];
const isNativeStructuralEdge = (edge, nodeById) =>
  isValidatedStructuralEdge(
    edge,
    nodeById.get(edge.source_node_id),
    nodeById.get(edge.target_node_id),
  );
const structuralEdges = (nodes, edges) => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges.filter((edge) => isNativeStructuralEdge(edge, nodeById));
};
const SYNTHETIC_STRUCTURE_NODE_TYPES = new Set([
  'benchmark',
  'catalog',
  'category',
  'family',
  'function',
  'group',
  'limb',
  'policy_directive',
  'regulation',
  'statute',
  'tactic',
  'trunk',
]);
const expectedArtifacts = ['sources', 'nodes', 'edges', 'evidence', 'graph-health'];
const retiredArtifacts = [
  'bootstrap',
  'catalog',
  'coverage',
  'frameworks',
  'items',
  'mappings',
  'paths',
  'candidates',
  'source-health',
];
const forbiddenStructuralParentTypes = new Set([
  'assessment_procedure',
  'baseline',
  'mapping',
  'evidence',
  'implementation_aid',
  'process',
  'resource',
  'rmf_step',
]);

test('generated output uses only the federal graph artifact contract', () => {
  for (const name of expectedArtifacts) {
    assert.ok(existsSync(`data/generated/${name}.json`), `missing ${name}.json`);
    const artifact = generated(name);
    assert.equal(artifact.schema_version, '1.0', `${name}.json schema`);
    assert.ok(artifact.generated_at, `${name}.json generated_at`);
  }
  for (const name of retiredArtifacts) {
    assert.ok(!existsSync(`data/generated/${name}.json`), `retired artifact remains: ${name}.json`);
  }
  assert.ok(existsSync('data/generated/build-manifest.json'));
  assert.ok(existsSync('data/generated/source-manifests.json'));
  assert.ok(existsSync('data/generated/graph-diff-summary.json'));
});

test('every graph node has an eligible defining federal source', () => {
  const sources = generated('sources').sources;
  const nodes = generated('nodes').nodes;
  const sourcesById = new Map(sources.map((source) => [source.id, source]));

  assert.ok(nodes.length > 1000);
  for (const node of nodes) {
    assert.ok(node.id);
    assert.ok(node.node_type);
    assert.ok(node.label);
    assert.ok(node.lifecycle_status);
    const source = sourcesById.get(node.source_id);
    assert.ok(source, `unknown defining source for ${node.id}`);
    assert.equal(source.graph_eligible, true, `ineligible defining source for ${node.id}`);
    assert.notEqual(source.eligibility_status, 'excluded');
  }
});

test('tree doctrine keeps baselines and other lenses out of structural parentage', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const invalidEdges = edges.filter(
    (edge) =>
      edge.relationship_class === RELATIONSHIP_CLASSES.structural &&
      forbiddenStructuralParentTypes.has(
        nodeById.get(edge.source_node_id)?.node_type,
      ),
  );
  const invalidPointers = nodes.filter(
    (node) =>
      node.parent_id &&
      forbiddenStructuralParentTypes.has(nodeById.get(node.parent_id)?.node_type),
  );

  assert.deepEqual(invalidEdges, []);
  assert.deepEqual(invalidPointers, []);
});

test('displayable edges separate semantics, provenance, confidence, and evidence quality', () => {
  const edges = generated('edges').edges;
  const evidence = generated('evidence').evidence;
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));

  assert.ok(edges.length > 0);
  for (const edge of edges) {
    assert.ok(edge.relationship_type);
    assert.ok(
      Object.values(RELATIONSHIP_CLASSES).includes(edge.relationship_class),
      `invalid relationship class for ${edge.id}`,
    );
    assert.ok(edge.provenance_class);
    assert.ok(edge.confidence);
    // 'editorial' is Control Atlas's own organizing spine (trunk/limb/catalog).
    assert.ok(['published', 'candidate', 'editorial'].includes(edge.publication_status));
    const evidenceIds = evidenceIdsFor(edge);
    assert.ok(evidenceIds.length > 0, `missing evidence for ${edge.id}`);
    assert.ok(evidenceIds.every((id) => evidenceById.has(id)), `unknown evidence for ${edge.id}`);
    assert.ok(evidenceIds.every((id) => evidenceById.get(id).evidence_quality));
    assert.notEqual(edge.publication_status, 'blocked');
  }
});

test('candidate edges are inferred and blocked relationships appear only in graph health', () => {
  const edges = generated('edges').edges;
  const findings = generated('graph-health').findings;
  const candidates = edges.filter((edge) => edge.publication_status === 'candidate');

  assert.ok(candidates.every((edge) => edge.provenance_class === 'inferred'));
  assert.ok(candidates.every((edge) => edge.confidence.startsWith('inferred_')));
  assert.ok(candidates.every((edge) => edge.warning && edge.inference_rule_id));
  assert.ok(findings.every((finding) => finding.id
    && finding.finding_type
    && finding.severity
    && finding.source_id
    && finding.subject_id
    && finding.message));
  assert.ok(!edges.some((edge) => edge.publication_status === 'blocked'));
});

test('generated graph excludes retired translation fields', () => {
  assert.ok(generated('nodes').nodes.every((node) => node.plain_language_summary === undefined && node.metadata?.plain_action === undefined));
  assert.ok(generated('edges').edges.every((edge) => edge.plain_language_rationale === undefined));
});

/* Retired with the source-first record contract.
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;

  const badSummaryPatterns = [
    /Ensure we an\b/i,
    /\s+to\s+\./,
    /\s+for each\s+to\s+/,
    /\s+after\s+\./,
  ];

  let checkedSummaries = 0;
  for (const node of nodes) {
    if (!node.plain_language_summary) continue;
    checkedSummaries += 1;
    for (const pattern of badSummaryPatterns) {
      assert.doesNotMatch(node.plain_language_summary, pattern, `bad summary for ${node.id}: ${node.plain_language_summary}`);
    }
    assert.ok(node.plain_language_summary.length >= 20, `summary too short for ${node.id}`);
    assert.ok(!node.plain_language_summary.endsWith('...') || node.plain_language_summary.length > 100, `truncated mid-word for ${node.id}`);
  }
  assert.ok(checkedSummaries > 500, 'expected plain-language summaries on most nodes');

  const olirBoilerplate = edges.filter((edge) =>
    edge.plain_language_rationale && /^NIST OLIR concept crosswalk associates/i.test(edge.plain_language_rationale),
  );
  assert.equal(olirBoilerplate.length, 0, 'plain-language rationales should not echo OLIR boilerplate');

  for (const edge of edges.slice(0, 500)) {
    if (!edge.plain_language_rationale) continue;
    assert.doesNotMatch(edge.plain_language_rationale, /^NIST OLIR concept crosswalk associates/i);
    // This used to require /before|Compare|Review/ — "operational guidance
    // missing" — which mandated a reflexive "review both sides before assuming
    // coverage transfers" tail on all 22k edges. The owner's copy directive
    // retires that pattern, and tests/e2e/critical-path-matrix.spec.mjs:152
    // already asserted the rendered table must NOT show it, so the two
    // contradicted each other. The rationale must still say something real.
    assert.doesNotMatch(
      edge.plain_language_rationale,
      /Review both sides|Compare both items before/i,
      `retired reflexive guidance resurfaced on ${edge.id}`,
    );
    assert.ok(
      edge.plain_language_rationale.trim().length >= 20,
      `plain-language rationale too thin for ${edge.id}`,
    );
  }
});

*/
test('graph validation rejects duplicates, non-public leakage, missing edge evidence, inferred published edges, and blocked edges', () => {
  const artifacts = {
    sources: [{
      id: 'excluded-source',
      provenance_class: 'federal_referenced',
      eligibility_status: 'excluded',
      graph_eligible: false,
      access_status: 'public',
    }, {
      id: 'restricted-source',
      provenance_class: 'federal_published',
      eligibility_status: 'eligible',
      graph_eligible: true,
      access_status: 'restricted',
    }, {
      id: 'restricted-source',
      provenance_class: 'federal_published',
      eligibility_status: 'eligible',
      graph_eligible: true,
      access_status: 'restricted',
    }],
    nodes: [{
      id: 'node:one',
      node_type: 'requirement',
      label: 'One',
      source_id: 'excluded-source',
      lifecycle_status: 'active',
      plain_language_summary: 'Plain language summary for node one',
      metadata: {},
    }, {
      id: 'node:one',
      node_type: 'requirement',
      label: 'Duplicate',
      source_id: 'restricted-source',
      lifecycle_status: 'active',
      plain_language_summary: 'Plain language summary for duplicate node',
      metadata: {},
    }],
    edges: [{
      id: 'edge:blocked',
      source_node_id: 'node:one',
      target_node_id: 'node:one',
      relationship_type: 'maps_to',
      provenance_class: 'federal_referenced',
      confidence: 'direct',
      publication_status: 'blocked',
      evidence_ids: [],
      display_label: 'Blocked',
      warning: null,
      inference_rule_id: null,
      plain_language_rationale: 'Blocked relationship rationale',
      source_refs: [{ source_id: 'excluded-source', ref_type: 'primary', locator: 'test' }],
    }, {
      id: 'edge:published-inferred',
      source_node_id: 'node:one',
      target_node_id: 'node:one',
      relationship_type: 'maps_to',
      provenance_class: 'inferred',
      confidence: 'inferred_high',
      publication_status: 'published',
      evidence_ids: ['evidence:restricted'],
      display_label: 'Bad',
      warning: null,
      inference_rule_id: 'rule-1',
      rationale: 'Inferred mapping rationale',
      plain_language_rationale: 'Inferred plain rationale',
      source_refs: [{ source_id: 'restricted-source', ref_type: 'primary', locator: 'test' }],
    }],
    evidence: [{
      id: 'evidence:restricted',
      source_id: 'restricted-source',
      evidence_quality: 'primary',
    }],
    findings: [],
  };

  const errors = validateGraphArtifacts(artifacts);
  assert.ok(errors.includes('duplicate source id: restricted-source'));
  assert.ok(errors.includes('duplicate node id: node:one'));
  assert.ok(errors.includes('node node:one defining source excluded-source is not graph eligible'));
  assert.ok(errors.includes('node node:one defining source restricted-source must remain public for displayable graph content'));
  assert.ok(errors.includes('edge edge:blocked cannot use blocked publication_status'));
  assert.ok(errors.includes('edge edge:blocked must reference evidence'));
  assert.ok(errors.includes('published edge edge:published-inferred cannot use inferred provenance_class'));
  assert.ok(errors.includes('evidence evidence:restricted source restricted-source must remain public for displayable graph content'));
});

test('every catalog with a declared parent tier has all of its records parented', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nativeStructure = structuralEdges(nodes, edges);
  const parented = new Set(nativeStructure.map((edge) => edge.target_node_id));
  const tierNodeTypes = new Set(Object.values(CATALOG_TIERS).map((tier) => tier.nodeType));

  for (const catalogId of Object.keys(CATALOG_TIERS)) {
    // A catalog summary node is the root of its own tree, so it is the one node
    // that legitimately has no parent. Tier nodes are the branches; parenting
    // those to their catalog is enforced by docs/DATA_POLICY.md.
    const records = nodes.filter(
      (node) =>
        node.metadata?.catalog_id === catalogId &&
        !tierNodeTypes.has(node.node_type) &&
        node.node_type !== 'catalog',
    );
    assert.ok(records.length > 0, `${catalogId} produced no records`);
    const unparented = records.filter((node) => !parented.has(node.id)).map((node) => node.id);
    assert.deepEqual(
      unparented,
      [],
      `${catalogId} declares a parent tier, so every record must have a structural parent edge`,
    );
  }
});

test('all 28 publication-native structure profiles reconcile with valid containment paths', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;

  assert.equal(CATALOG_STRUCTURE_IDS.length, 28);
  assert.deepEqual(validatePublisherNativeContainment(nodes, edges), []);
  assert.deepEqual(
    catalogStructureProfile('disa-stig').paths,
    [['catalog', 'benchmark', 'stig_rule']],
  );
  assert.ok(
    catalogStructureProfile('mitre-attack').paths.some((path) =>
      path.join('>') === 'catalog>tactic>attack_technique>attack_technique'),
  );
  assert.ok(
    catalogStructureProfile('nist-800-53').paths.some((path) =>
      path.join('>') === 'catalog>family>control>control_enhancement'),
  );
});

test('ATT&CK techniques preserve every publisher-declared tactic membership', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentIdsByChild = new Map();
  for (const edge of edges) {
    if (!isNativeStructuralEdge(edge, nodeById)) continue;
    const parents = parentIdsByChild.get(edge.target_node_id) || [];
    parents.push(edge.source_node_id);
    parentIdsByChild.set(edge.target_node_id, parents);
  }

  let multiTacticTechniqueCount = 0;
  for (const catalogId of ['mitre-attack', 'mitre-attack-ics']) {
    const techniques = nodes.filter(
      (node) => node.metadata?.catalog_id === catalogId && node.node_type === 'attack_technique',
    );
    assert.ok(techniques.length > 0, `${catalogId} produced no techniques`);
    for (const technique of techniques) {
      const actualParents = [...(parentIdsByChild.get(technique.id) || [])].sort();
      if (technique.metadata?.is_subtechnique) {
        assert.deepEqual(
          actualParents,
          [`${catalogId}:${technique.metadata.parent_technique_id}`],
          `${technique.id} must be contained only by its publisher-declared parent technique`,
        );
        continue;
      }
      const expectedParents = (technique.metadata?.tactic_memberships || [])
        .map((membership) => `${catalogId}:TACTIC-${membership.id}`)
        .sort();
      assert.ok(expectedParents.length > 0, `${technique.id} needs a publisher tactic membership`);
      assert.deepEqual(actualParents, expectedParents, `${technique.id} tactic memberships drifted`);
      if (expectedParents.length > 1) multiTacticTechniqueCount += 1;
    }
  }
  assert.ok(multiTacticTechniqueCount > 0, 'expected ATT&CK techniques assigned to multiple tactics');
});

test('declared parent tiers materialize real tier nodes with plain-language titles', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childCount = new Map();
  for (const edge of edges) {
    if (!isNativeStructuralEdge(edge, nodeById)) continue;
    childCount.set(edge.source_node_id, (childCount.get(edge.source_node_id) ?? 0) + 1);
  }

  for (const [catalogId, tier] of Object.entries(CATALOG_TIERS)) {
    const tierNodes = nodes.filter(
      (node) => node.metadata?.catalog_id === catalogId && node.node_type === tier.nodeType,
    );
    assert.ok(tierNodes.length > 0, `${catalogId} declares tier ${tier.nodeType} but built none`);
    for (const node of tierNodes) {
      assert.ok(node.label?.trim(), `${node.id} needs a label`);
      assert.ok(node.metadata?.title?.trim(), `${node.id} needs a title`);
      if (node.metadata?.description) {
        assert.equal(
          node.metadata.description_provenance,
          'publisher',
          `${node.id} grouping description must be publisher text`,
        );
      } else {
        assert.equal(node.metadata?.description, undefined, `${node.id} must not invent a grouping description`);
      }
      assert.ok(
        (childCount.get(node.id) ?? 0) > 0,
        `${node.id} is a tier node with no children, so it should not exist`,
      );
    }
  }
});

test('DISA STIG and SRG records carry their benchmark as the grouping label', () => {
  const nodes = generated('nodes').nodes;
  for (const [catalogId, nodeType] of [
    ['disa-stig', 'stig_rule'],
    ['disa-srg', 'srg_requirement'],
  ]) {
    const records = nodes.filter((node) => node.node_type === nodeType);
    assert.ok(records.length > 0, `${catalogId} produced no ${nodeType} records`);
    const unlabelled = records.filter((node) => !node.metadata?.family?.trim()).map((node) => node.id);
    assert.deepEqual(
      unlabelled,
      [],
      `${nodeType} records must carry metadata.family so the catalog family filter works`,
    );
  }

  const benchmarks = nodes.filter((node) => node.node_type === 'benchmark');
  const stigBenchmarks = benchmarks.filter((node) => node.metadata?.catalog_id === 'disa-stig');
  const srgBenchmarks = benchmarks.filter((node) => node.metadata?.catalog_id === 'disa-srg');
  assert.ok(stigBenchmarks.length > 0, 'expected DISA STIG benchmark nodes');
  assert.ok(srgBenchmarks.length > 0, 'expected DISA SRG benchmark nodes');
});

test('DISA STIG and SRG records carry full, untruncated check and fix text', () => {
  const nodes = generated('nodes').nodes;
  for (const nodeType of ['stig_rule', 'srg_requirement']) {
    const records = nodes.filter((node) => node.node_type === nodeType);
    assert.ok(records.length > 0, `expected ${nodeType} nodes`);
    const missingCheckText = records
      .filter((node) => !node.metadata?.check_text?.trim())
      .map((node) => node.id);
    assert.deepEqual(
      missingCheckText,
      [],
      `${nodeType} records must carry metadata.check_text`,
    );
    const missingFixText = records
      .filter((node) => !node.metadata?.fix_text?.trim())
      .map((node) => node.id);
    assert.deepEqual(
      missingFixText,
      [],
      `${nodeType} records must carry metadata.fix_text`,
    );
    const sourceRecords = JSON.parse(
      readFileSync(
        nodeType === 'stig_rule' ? 'data/stig-rules.json' : 'data/srg-requirements.json',
        'utf8',
      ),
    ).records;
    const sourceById = new Map(sourceRecords.map((record) => [record.id, record]));
    for (const node of records) {
      const source = sourceById.get(node.metadata?.item_id);
      assert.equal(
        node.metadata.check_text,
        repairKnownSourceEncoding(source?.check_text),
        `${node.id} check text must preserve the parsed publisher record after known encoding repair`,
      );
      assert.equal(
        node.metadata.fix_text,
        repairKnownSourceEncoding(source?.fix_text),
        `${node.id} fix text must preserve the parsed publisher record after known encoding repair`,
      );
      assert.doesNotMatch(
        `${node.metadata.check_text}\n${node.metadata.fix_text}`,
        /â€|Ã|Â/,
        `${node.id} must not publish known mojibake`,
      );
    }
  }
});

test('every tiered catalog has its outermost tier parented to the catalog node, not floating', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nativeStructure = structuralEdges(nodes, edges);
  const parented = new Set(nativeStructure.map((edge) => edge.target_node_id));
  for (const [catalogId, tier] of Object.entries(CATALOG_TIERS)) {
    const catalogNode = nodes.find((node) => node.id === `${catalogId}:CATALOG`);
    assert.ok(catalogNode, `${catalogId} needs a catalog node for its tier to hang off`);
    // The outermost tier is the parentTier when declared (e.g. CSF Function
    // above Category), else the tier itself (e.g. STIG benchmark).
    const outerNodeType = tier.parentTier?.nodeType || tier.nodeType;
    const outerNodes = nodes.filter(
      (node) => node.metadata?.catalog_id === catalogId && node.node_type === outerNodeType,
    );
    assert.ok(outerNodes.length > 0, `${catalogId} has no ${outerNodeType} tier nodes`);
    for (const node of outerNodes) {
      assert.ok(parented.has(node.id), `${node.id} should be parented to ${catalogId}:CATALOG`);
    }
  }
});

test('CSF 2.0 subcategories chain up through Category to Function', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nativeStructure = structuralEdges(nodes, edges);
  const childrenOf = new Map();
  for (const edge of nativeStructure) {
    if (!childrenOf.has(edge.source_node_id)) childrenOf.set(edge.source_node_id, []);
    childrenOf.get(edge.source_node_id).push(edge.target_node_id);
  }

  const functions = nodes.filter((node) => node.node_type === 'function' && node.metadata?.catalog_id === 'csf-2');
  const categories = nodes.filter((node) => node.node_type === 'category' && node.metadata?.catalog_id === 'csf-2');
  assert.equal(functions.length, 6, 'CSF 2.0 has 6 Functions');
  assert.equal(categories.length, 22, 'CSF 2.0 has 22 Categories');

  for (const fn of functions) {
    const children = childrenOf.get(fn.id) || [];
    assert.ok(children.length > 0, `${fn.id} should include at least one Category`);
    for (const childId of children) {
      const child = nodes.find((node) => node.id === childId);
      assert.equal(child?.node_type, 'category', `${fn.id} should only include Category nodes`);
    }
  }
  for (const category of categories) {
    const children = childrenOf.get(category.id) || [];
    assert.ok(children.length > 0, `${category.id} should include at least one subcategory`);
  }
});

test('CSF records retain the Reference Tool examples, informative references, and both contributing artifacts', () => {
  const nodes = generated('nodes').nodes.filter((node) =>
    node.metadata?.catalog_id === 'csf-2' && node.node_type === 'requirement',
  );
  assertPublisherVolume('csf-2', 'data/csf-subcategories.json', nodes.length);
  for (const node of nodes) {
    assert.ok(node.metadata?.implementation_examples?.length, `${node.id} is missing Reference Tool implementation examples`);
    assert.ok(node.metadata?.informative_references?.length, `${node.id} is missing Reference Tool informative references`);
    assert.ok(node.artifact_ids?.includes('artifact-nist-csf-reference-tool-export'), `${node.id} is missing Reference Tool provenance`);
    assert.ok(node.artifact_ids?.includes('artifact-nist-csf-2'), `${node.id} is missing OSCAL reconciliation provenance`);
  }
});

test('publisher-native containers separate publisher identifiers from stable graph IDs', () => {
  const nodes = generated('nodes').nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const expected = new Map([
    ['csf-2:FUNCTION-PR', 'PR'],
    ['csf-2:CATEGORY-PR.AA', 'PR.AA'],
    ['mitre-attack:TACTIC-TA0001', 'TA0001'],
    ['mitre-attack-ics:TACTIC-TA0100', 'TA0100'],
    ['nist-800-53:FAMILY-AC', 'AC'],
    ['nist-800-53a:FAMILY-AC', 'AC'],
    ['nist-ai-rmf:GROUP-GOVERN-1', 'GOVERN-1'],
    ['disa-stig:BENCHMARK-ACTIVE-DIRECTORY-DOMAIN', 'Active_Directory_Domain'],
  ]);
  for (const [nodeId, publisherItemId] of expected) {
    const node = byId.get(nodeId);
    assert.ok(node, `${nodeId} must keep its stable graph identity`);
    assert.equal(node.metadata?.publisher_item_id, publisherItemId, nodeId);
    assert.notEqual(node.metadata?.item_id, publisherItemId, `${nodeId} must not replace its stable item key`);
  }

  for (const nodeId of [
    'cmmc-2:LEVEL-1',
    'nist-ssdf:GROUP-PREPARE-THE-ORGANIZATION',
    'microsoft-zt-maturity:PILLAR-DEVICES',
    'dod-rai:GROUP-SHIELD-ACTIVITIES',
    'csf-2:CATALOG',
  ]) {
    assert.equal(
      byId.get(nodeId)?.metadata?.publisher_item_id,
      undefined,
      `${nodeId} must not fabricate a publisher identifier`,
    );
  }
  assert.equal(byId.get('nist-800-53:AC-2')?.metadata?.publisher_item_id, undefined);
  assert.equal(byId.get('nist-800-53:AC-2')?.metadata?.item_id, 'AC-2');
});

test('ATT&CK sub-techniques nest under their parent technique', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nativeStructure = structuralEdges(nodes, edges);
  const parented = new Set(nativeStructure.map((edge) => edge.target_node_id));

  for (const catalogId of ['mitre-attack', 'mitre-attack-ics']) {
    const subtechniques = nodes.filter(
      (node) => node.metadata?.catalog_id === catalogId && node.metadata?.item_id?.includes('.'),
    );
    assert.ok(subtechniques.length > 0, `${catalogId} produced no sub-techniques`);
    for (const node of subtechniques) {
      const parentId = `${catalogId}:${node.metadata.item_id.split('.')[0]}`;
      assert.ok(
        nativeStructure.some(
          (edge) =>
            edge.source_node_id === parentId &&
            edge.target_node_id === node.id,
        ),
        `${node.id} should have a structural edge from its parent technique ${parentId}`,
      );
      assert.ok(parented.has(node.id), `${node.id} should be parented`);
    }
  }
});

test('every isolated CCI is one NIST genuinely never re-mapped to Revision 5', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const ccis = JSON.parse(readFileSync('data/ccis.json', 'utf8'));
  const controls = JSON.parse(readFileSync('data/controls-800-53.json', 'utf8'));
  const crosswalk = JSON.parse(readFileSync('data/800-53-rev4-to-rev5-crosswalk.json', 'utf8'));

  const controlIds = new Set(controls.records.map((record) => record.id));
  const connected = new Set();
  for (const edge of edges) {
    connected.add(edge.source_node_id);
    connected.add(edge.target_node_id);
  }
  const legacyId = (index) => {
    const match = /^([A-Z]{2,3}-\d+)(?:\s*\((\d+)\))?/.exec(String(index ?? '').trim());
    if (!match) return null;
    return match[2] ? `${match[1]}.${Number.parseInt(match[2], 10)}` : match[1];
  };

  const isolated = nodes.filter(
    (node) => node.metadata?.catalog_id === 'disa-cci' && !connected.has(node.id),
  );
  const byId = new Map(ccis.records.map((record) => [record.id, record]));

  // The point of the crosswalk: a CCI may only stay isolated when NIST publishes
  // no Revision 5 home for the control it cites. If any legacy control it cites is
  // in the Rev 5 catalog, or has a published withdrawn/Appendix J target, the
  // record should have been connected and this catches the regression.
  for (const node of isolated) {
    const record = byId.get(node.metadata.item_id);
    assert.ok(record, `${node.id} has no matching CCI record`);
    for (const reference of record.references) {
      if (!reference.title.startsWith('NIST SP 800-53')) continue;
      const id = legacyId(reference.index);
      if (!id) continue;
      assert.ok(
        !controlIds.has(id),
        `${node.id} is isolated but cites ${id}, which exists in the Rev 5 catalog`,
      );
      assert.ok(
        !crosswalk.appendix_j[id]?.targets.length,
        `${node.id} is isolated but ${id} has a published Appendix J mapping`,
      );
      assert.ok(
        !crosswalk.withdrawn[id]?.targets.some((target) => controlIds.has(target)),
        `${node.id} is isolated but ${id} has a published withdrawn-control mapping`,
      );
    }
  }
});

test('the Rev 4 crosswalk maps only what NIST published', () => {
  const controls = JSON.parse(readFileSync('data/controls-800-53.json', 'utf8'));
  const map = JSON.parse(readFileSync('maps/cci-to-800-53-rev4.json', 'utf8'));
  const crosswalk = JSON.parse(readFileSync('data/800-53-rev4-to-rev5-crosswalk.json', 'utf8'));
  const controlIds = new Set(controls.records.map((record) => record.id));

  assert.equal(crosswalk.artifacts.length, 2, 'both NIST workbooks are recorded');
  for (const artifact of crosswalk.artifacts) {
    assert.match(artifact.url, /^https:\/\/csrc\.nist\.gov\//, 'artifacts come from NIST CSRC');
    assert.match(artifact.checksum, /^sha256:[0-9a-f]{64}$/, 'artifacts are checksummed');
  }

  assert.ok(map.relationships.length > 0, 'the crosswalk produced relationships');
  for (const relationship of map.relationships) {
    assert.ok(
      controlIds.has(relationship.target_id),
      `${relationship.source_id} maps to ${relationship.target_id}, which is not a Rev 5 control`,
    );
    // These edges compose two published documents rather than restating one, so
    // they must never claim the "direct" confidence a single published mapping gets.
    assert.equal(relationship.confidence, 'derived', `${relationship.source_id} confidence`);
    assert.ok(
      ['carried_forward', 'withdrawn', 'appendix_j'].includes(relationship.basis),
      `${relationship.source_id} has an unrecognized basis ${relationship.basis}`,
    );
    if (relationship.basis === 'appendix_j') {
      const cited = /Revision [34] ([A-Z]{2,3}-\d+)/.exec(relationship.why);
      assert.ok(cited, `${relationship.source_id} does not cite its legacy control`);
      assert.ok(
        crosswalk.appendix_j[cited[1]]?.targets.includes(relationship.target_id),
        `${relationship.source_id} claims an Appendix J target NIST did not publish`,
      );
    }
  }
});

test('DoD Zero Trust tenets are connected to the catalog, not fabricated as pillar children', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const tenets = nodes.filter(
    (node) => node.node_type === 'zt_tenet' && node.metadata?.catalog_id === 'dod-zt',
  );
  assert.equal(tenets.length, 5, 'DoD Zero Trust has 5 tenets');

  const nativeStructure = structuralEdges(nodes, edges);
  for (const tenet of tenets) {
    const parentEdge = nativeStructure.find((edge) => edge.target_node_id === tenet.id);
    assert.ok(parentEdge, `${tenet.id} should not be isolated`);
    assert.equal(
      parentEdge.source_node_id,
      'dod-zt:CATALOG',
      `${tenet.id} should hang off the catalog as a sibling collection to pillars, not a fabricated pillar link`,
    );
  }
});

test('assessment procedures belong to their 800-53A families and only correlate to 800-53 controls', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const procedures = nodes.filter((node) => node.node_type === 'assessment_procedure');
  const nativeStructure = structuralEdges(nodes, edges);
  assert.equal(procedures.length, 1014, 'assessment procedure count');
  for (const node of procedures) {
    const parentEdges = nativeStructure.filter((edge) => edge.target_node_id === node.id);
    assert.equal(parentEdges.length, 1, `${node.id} must have one containment parent`);
    assert.match(parentEdges[0].source_node_id, /^nist-800-53a:FAMILY-/);
    assert.ok(
      edges.some(
        (edge) =>
          edge.source_node_id === node.id &&
          edge.relationship_type === 'assesses' &&
          edge.relationship_class === RELATIONSHIP_CLASSES.correlation,
      ),
      `${node.id} needs an explicit assessment correlation`,
    );
  }
});

test('CCI mappings remain correlation edges and never become structural parents', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  // The CCI library now has a catalog wrapper so it is browsable in Explore
  // (2026-08-02). Count the requirement records themselves, not the wrapper.
  const ccis = nodes.filter(
    (node) =>
      node.metadata?.catalog_id === 'disa-cci' && node.node_type !== 'catalog',
  );
  assertPublisherVolume('disa-cci', 'data/ccis.json', ccis.length);

  assert.ok(ccis.every((node) => node.parent_id === undefined));
  const cciEdges = edges.filter(
    (edge) =>
      edge.source_node_id.startsWith('disa-cci:') ||
      edge.target_node_id.startsWith('disa-cci:'),
  );
  assert.ok(
    cciEdges.length > 5000,
    `expected the published CCI bridge to remain available, got ${cciEdges.length} edges`,
  );
  assert.ok(
    cciEdges.every(
      (edge) =>
        (edge.relationship_class === RELATIONSHIP_CLASSES.structural &&
          edge.source_node_id.startsWith('disa-cci:') &&
          edge.target_node_id.startsWith('disa-cci:')) ||
        edge.relationship_class === RELATIONSHIP_CLASSES.correlation ||
        // Editorial organizing edges (e.g. filing a genuinely-unmappable CCI under
        // a limb for reachability) are explicitly NOT structural ancestry — they
        // are Control Atlas's own badged organizing layer, never a publisher claim.
        edge.relationship_class === RELATIONSHIP_CLASSES.organizing,
    ),
    'CCI crosswalk edges must stay out of structural ancestry',
  );
});

test('every parent_id is explicitly structural and stays inside its native catalog', () => {
  const nodes = generated('nodes').nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (!node.parent_id) continue;
    assert.ok(
      isValidatedStructuralPointer(node, nodeById.get(node.parent_id)),
      `${node.id} has an invalid structural parent pointer`,
    );
  }
});

test('graph health reports zero invalid structural-parent findings', () => {
  const findings = generated('graph-health').findings;
  assert.equal(
    findings.filter((finding) => finding.finding_type === 'invalid_structural_parent').length,
    0,
  );
});

test('every blocked graph-health relationship has checked upstream provenance and remains unpublished', () => {
  const findings = generated('graph-health').findings
    .filter((finding) => finding.finding_type === 'blocked_relationship');
  const provenance = JSON.parse(readFileSync('data/graph-health-provenance.json', 'utf8'));
  const provenanceByFindingId = new Map(provenance.findings.map((entry) => [entry.finding_id, entry]));
  const edges = generated('edges').edges;

  assert.equal(provenance.schema_version, '1.0');
  assert.match(provenance.policy, /do not infer/i);
  assert.deepEqual(
    [...provenanceByFindingId.keys()].sort(),
    findings.map((finding) => finding.id).sort(),
    'provenance inventory must cover exactly the current blocked findings',
  );
  for (const finding of findings) {
    const entry = provenanceByFindingId.get(finding.id);
    assert.equal(entry.source_id, finding.source_id, `${finding.id} source`);
    assert.match(entry.upstream_url, /^https:\/\//, `${finding.id} upstream URL`);
    assert.ok(entry.rejected_reference?.trim(), `${finding.id} rejected reference`);
    assert.ok(entry.reason?.trim(), `${finding.id} reason`);
    assert.equal(entry.disposition, 'blocked_not_published', `${finding.id} disposition`);
    assert.ok(!edges.some((edge) => edge.id === `edge:${finding.subject_id}`));
  }
});

test('publisher prose is complete when required and omitted rather than fabricated when optional', () => {
  const nodes = generated('nodes').nodes;
  const byCatalog = new Map();
  for (const node of nodes) {
    if (SYNTHETIC_STRUCTURE_NODE_TYPES.has(node.node_type) || node.metadata?.structural_group === true) continue;
    const catalogId = node.metadata?.catalog_id;
    if (!catalogId) continue;
    const bucket = byCatalog.get(catalogId) || [];
    bucket.push(node);
    byCatalog.set(catalogId, bucket);
  }
  assert.ok(byCatalog.size > 10, 'expected many catalogs to be present');
  for (const [catalogId, records] of byCatalog) {
    const truncated = records.filter((node) => {
      const description = (node.metadata?.description || '').trim();
      return description.endsWith('...') || description.endsWith('…');
    });
    assert.equal(truncated.length, 0, `${catalogId} contains artificially truncated publisher prose`);
    for (const node of records.filter((entry) => !(entry.metadata?.description || '').trim())) {
      const profile = recordPresentationContract(catalogId, node.node_type);
      assert.equal(
        profile.required_fields.includes('description'),
        false,
        `${node.id} omits a profile-required publisher description`,
      );
    }
  }
});

test('active NIST SP 800-53 controls carry the publisher\'s Discussion text', () => {
  const nodes = generated('nodes').nodes;
  const controls = nodes.filter(
    (node) =>
      node.metadata?.catalog_id === 'nist-800-53' &&
      (node.node_type === 'control' || node.node_type === 'control_enhancement') &&
      node.lifecycle_status !== 'withdrawn',
  );
  assert.ok(controls.length > 1000, 'expected the full active 800-53 control set');
  const missingDiscussion = controls
    .filter((node) => !node.metadata?.discussion?.trim())
    .map((node) => node.id);
  assert.deepEqual(missingDiscussion, [], 'active 800-53 controls must carry metadata.discussion');
});

test('MITRE D3FEND countermeasures carry a real publisher definition', () => {
  const nodes = generated('nodes').nodes;
  const countermeasures = nodes.filter((node) => node.node_type === 'defend_countermeasure');
  assert.ok(countermeasures.length > 200, 'expected the full D3FEND technique set');
  const missingDescription = countermeasures
    .filter((node) => !node.metadata?.description?.trim())
    .map((node) => node.id);
  assert.deepEqual(
    missingDescription,
    [],
    'D3FEND countermeasures must carry a publisher definition, not an empty stub',
  );
});

// --- Phase 1: Canonical Domain Model and Layer Separation ------------------

test('every canonical node has exactly one object layer and the generator round-trips with zero drift', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  assert.deepEqual(validateDataTrustContracts(nodes, edges), []);
  for (const node of nodes) {
    assert.ok(OBJECT_LAYERS.has(node.metadata?.object_layer), `${node.id} missing a valid object_layer`);
  }
});

test('Atlas structure is never emitted as publisher content and never carries a fabricated publication', () => {
  const nodes = generated('nodes').nodes;
  for (const node of nodes) {
    if (ATLAS_STRUCTURE_NODE_TYPES.has(node.node_type)) {
      assert.equal(node.metadata.object_layer, 'atlas_structure', `${node.id} must be atlas_structure`);
      assert.ok(['root', 'area'].includes(node.metadata.atlas_structure_role), `${node.id} needs a root/area role`);
      assert.equal(node.metadata.native_type, '', `${node.id} must not claim a publisher-native type`);
      assert.equal(node.metadata.publication_id, '', `${node.id} must not carry a fabricated publication id`);
      assert.equal(node.metadata.catalog_id, undefined, `${node.id} must not carry a catalog_id`);
    } else {
      assert.notEqual(node.metadata?.object_layer, 'atlas_structure', `${node.id} is publisher/authority content, not Atlas structure`);
    }
  }
});

test('the Cybersecurity trunk and nine areas keep their stable IDs across the layer migration', () => {
  const nodes = generated('nodes').nodes;
  const trunk = nodes.filter((node) => node.node_type === 'trunk');
  const limbs = nodes.filter((node) => node.node_type === 'limb');
  assert.deepEqual(trunk.map((node) => node.id), ['atlas:TRUNK']);
  assert.deepEqual(
    limbs.map((node) => node.id).sort(),
    [
      'atlas:LIMB-ARCHITECTURE',
      'atlas:LIMB-ASSESSMENT',
      'atlas:LIMB-COMPLIANCE',
      'atlas:LIMB-GOVERNANCE',
      'atlas:LIMB-IMPLEMENTATION',
      'atlas:LIMB-KNOWLEDGE',
      'atlas:LIMB-OPERATIONS',
      'atlas:LIMB-RISK',
      'atlas:LIMB-THREAT',
    ],
  );
});

test('authority documents remain source-faithful and are never mislabeled as framework catalogs', () => {
  const nodes = generated('nodes').nodes;
  const authorityNodes = nodes.filter((node) => AUTHORITY_DOCUMENT_NODE_TYPES.has(node.node_type));
  assert.ok(authorityNodes.length > 0, 'expected statute/regulation/policy_directive nodes');
  for (const node of authorityNodes) {
    assert.equal(node.metadata.object_layer, 'authority_document');
    assert.equal(node.metadata.native_type, node.node_type, `${node.id} native_type must equal its source-faithful instrument kind`);
    assert.equal(node.metadata.publication_id, '', `${node.id} is not a publication`);
  }
});

test('nativeType stays source-faithful and is never collapsed to a generic requirement bucket', () => {
  const nodes = generated('nodes').nodes;
  // These catalogs previously shared node_type "requirement" as their only
  // type signal; nativeType must now recover each publisher's own term(s).
  const previouslyCollapsed = [
    ['csf-2', ['csf-subcategory']],
    ['disa-cci', ['cci']],
    ['nist-ai-rmf', ['ai-rmf-outcome']],
    ['nist-ssdf', ['ssdf-task']],
    ['dod-rai', ['rai-toolkit-principle', 'rai-shield-activity']],
    ['fips-200', ['fips-200-requirement']],
  ];
  for (const [catalogId, expectedNativeTypes] of previouslyCollapsed) {
    const records = nodes.filter((node) => node.metadata?.catalog_id === catalogId && node.node_type === 'requirement');
    assert.ok(records.length > 0, `expected ${catalogId} requirement records`);
    for (const node of records) {
      assert.ok(
        expectedNativeTypes.includes(node.metadata.native_type),
        `${node.id} lost its source-faithful native type (got ${node.metadata.native_type})`,
      );
      assert.notEqual(node.metadata.native_type, 'requirement', `${node.id} nativeType must not collapse to the generic Atlas bucket`);
    }
  }
});

test('every publisher-content and authority-document node stamps a nativeType that matches the resolver, with no drift', () => {
  const nodes = generated('nodes').nodes;
  const mismatches = nodes
    .filter((node) => node.metadata?.object_layer !== 'atlas_structure')
    .filter((node) => node.metadata?.native_type !== resolveNativeType(node))
    .map((node) => node.id);
  assert.deepEqual(mismatches, []);
});

test('every publisher-content node resolves a non-empty publicationId and structure/authority nodes stay unassigned', () => {
  const nodes = generated('nodes').nodes;
  for (const node of nodes) {
    if (node.metadata.object_layer === 'publisher_content') {
      assert.ok(node.metadata.publication_id, `${node.id} needs a publicationId`);
      assert.equal(node.metadata.publication_id, node.metadata.catalog_id);
    } else {
      assert.equal(node.metadata.publication_id, '', `${node.id} must not carry a publicationId`);
    }
  }
});

test('every node resolves a sourceMaterialId and no connection evidence id collides with a canonical node or edge id', () => {
  const nodes = generated('nodes').nodes;
  const edges = generated('edges').edges;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  for (const node of nodes) {
    assert.ok(node.source_material_id, `${node.id} needs a sourceMaterialId`);
  }
  for (const edge of edges) {
    const evidenceIds = edge.evidence_ids !== undefined ? edge.evidence_ids : [`evidence:${edge.id.slice('edge:'.length)}`];
    for (const evidenceId of evidenceIds) {
      assert.ok(!nodeIds.has(evidenceId), `${edge.id}: connection evidence id ${evidenceId} collides with a node id`);
      assert.ok(!edgeIds.has(evidenceId), `${edge.id}: connection evidence id ${evidenceId} collides with an edge id`);
    }
  }
});
