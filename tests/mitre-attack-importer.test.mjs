import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseEnterpriseAttackStix,
  parseIcsAttackStix,
  tacticLookupFromStixBundle,
} from '../tools/importers/mitre-attack-adapter.mjs';

const sampleStix = {
  objects: [
    {
      type: 'attack-pattern',
      id: 'attack-pattern--sample',
      name: 'Command and Scripting Interpreter',
      description: 'Adversaries may abuse command and script interpreters.',
      kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: 'execution' }],
      x_mitre_platforms: ['Windows', 'Linux'],
      external_references: [
        {
          source_name: 'mitre-attack',
          external_id: 'T1059',
          url: 'https://attack.mitre.org/techniques/T1059',
        },
      ],
    },
  ],
};

test('parseEnterpriseAttackStix normalizes attack techniques with metadata', () => {
  const document = parseEnterpriseAttackStix(sampleStix, {
    artifactUrl: 'https://example.test/enterprise-attack.json',
    version: '2026-06-19',
    snapshotDate: '2026-06-19',
    checksum: 'sha256:sample',
  });

  assert.equal(document.records.length, 1);
  assert.equal(document.records[0].id, 'T1059');
  assert.equal(document.records[0].type, 'attack_technique');
  assert.equal(document.records[0].metadata.attack_domain, 'enterprise');
  assert.equal(document.records[0].metadata.tactics[0], 'execution');
  assert.match(document.records[0].description, /command and script interpreters/i);
});

test('parseIcsAttackStix uses enterprise external reference ids for ICS bundle', () => {
  const document = parseIcsAttackStix(sampleStix, {
    artifactUrl: 'https://example.test/ics-attack.json',
    version: '2026-06-19',
    snapshotDate: '2026-06-19',
    checksum: 'sha256:sample',
  });

  assert.equal(document.records.length, 1);
  assert.equal(document.records[0].metadata.attack_domain, 'ics');
  assert.equal(document.source_key, 'mitre-attack-ics');
});

test('ICS imports verified legacy publisher IDs and tactics while rejecting malformed or ambiguous identities', () => {
  const technique = { type: 'attack-pattern', id: 'attack-pattern--23270e54-1d68-4c3b-b763-b25607bcef80',
    name: 'Role Identification', external_references: [{ source_name: 'mitre-ics-attack', external_id: 'T0850',
      url: 'https://attack.mitre.org/techniques/T0850' }], kill_chain_phases: [{ phase_name: 'discovery' }],
  };
  const bundle = { objects: [technique, { type: 'x-mitre-tactic', name: 'Discovery', x_mitre_shortname: 'discovery',
    external_references: [{ source_name: 'mitre-ics-attack', external_id: 'TA0102' }],
  }] };
  const metadata = { artifactUrl: 'https://example.test/ics.json', version: '19.2', snapshotDate: '2026-09-09' };
  const document = parseIcsAttackStix(bundle, metadata);
  assert.equal(document.records[0].id, 'T0850');
  assert.equal(document.records[0].metadata.tactic_id, 'TA0102');
  technique.external_references.push({ source_name: 'mitre-attack', external_id: 'T0850' });
  assert.equal(parseIcsAttackStix(bundle, metadata).records.length, 1);
  technique.external_references[1].external_id = 'T0999';
  assert.throws(() => parseIcsAttackStix(bundle, metadata), /Ambiguous publisher/);
  for (const refs of [[], [{ source_name: 'mitre-ics-attack' }], [{ source_name: 'mitre-ics-attack', external_id: 850 }]]) {
    technique.external_references = refs;
    assert.throws(() => parseIcsAttackStix(bundle, metadata), /Missing publisher identity/);
  }
});

const sampleStixWithTacticsAndSubtechnique = {
  objects: [
    {
      type: 'x-mitre-tactic',
      name: 'Execution',
      x_mitre_shortname: 'execution',
      external_references: [
        { source_name: 'mitre-attack', external_id: 'TA0002' },
      ],
    },
    {
      type: 'attack-pattern',
      id: 'attack-pattern--parent',
      name: 'Command and Scripting Interpreter',
      description: 'Adversaries may abuse command and script interpreters.',
      kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: 'execution' }],
      external_references: [
        { source_name: 'mitre-attack', external_id: 'T1059', url: 'https://attack.mitre.org/techniques/T1059' },
      ],
    },
    {
      type: 'attack-pattern',
      id: 'attack-pattern--sub',
      name: 'PowerShell',
      description: 'Adversaries may abuse PowerShell.',
      kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: 'execution' }],
      x_mitre_is_subtechnique: true,
      external_references: [
        { source_name: 'mitre-attack', external_id: 'T1059.001', url: 'https://attack.mitre.org/techniques/T1059/001' },
      ],
    },
  ],
};

test('tacticLookupFromStixBundle resolves tactic shortname to display name and TA-code', () => {
  const lookup = tacticLookupFromStixBundle(sampleStixWithTacticsAndSubtechnique, 'mitre-attack');
  assert.deepEqual(lookup.get('execution'), { id: 'TA0002', title: 'Execution' });
});

test('parseEnterpriseAttackStix attaches the resolved tactic title and parent technique id', () => {
  const document = parseEnterpriseAttackStix(sampleStixWithTacticsAndSubtechnique, {
    artifactUrl: 'https://example.test/enterprise-attack.json',
    version: '2026-06-19',
    snapshotDate: '2026-06-19',
    checksum: 'sha256:sample',
  });

  const parent = document.records.find((record) => record.id === 'T1059');
  assert.equal(parent.metadata.tactic_id, 'TA0002');
  assert.equal(parent.metadata.tactic_title, 'Execution');
  assert.equal(parent.metadata.is_subtechnique, false);
  assert.equal(parent.metadata.parent_technique_id, null);

  const sub = document.records.find((record) => record.id === 'T1059.001');
  assert.equal(sub.metadata.is_subtechnique, true);
  assert.equal(sub.metadata.parent_technique_id, 'T1059');
});

test('parseEnterpriseAttackStix preserves every publisher tactic membership', () => {
  const sample = structuredClone(sampleStixWithTacticsAndSubtechnique);
  sample.objects.unshift({
    type: 'x-mitre-tactic',
    name: 'Defense Evasion',
    x_mitre_shortname: 'defense-evasion',
    external_references: [{ source_name: 'mitre-attack', external_id: 'TA0005' }],
  });
  sample.objects.find((entry) => entry.id === 'attack-pattern--parent').kill_chain_phases.push(
    { kill_chain_name: 'mitre-attack', phase_name: 'defense-evasion' },
  );
  const document = parseEnterpriseAttackStix(sample, {
    artifactUrl: 'https://example.test/enterprise-attack.json',
    version: 'test', snapshotDate: '2026-08-12', checksum: 'sha256:sample',
  });
  assert.deepEqual(
    document.records.find((record) => record.id === 'T1059').metadata.tactic_memberships,
    [
      { id: 'TA0002', title: 'Execution', shortname: 'execution' },
      { id: 'TA0005', title: 'Defense Evasion', shortname: 'defense-evasion' },
    ],
  );
});

test('parseEnterpriseAttackStix converts publisher HTML and retains lifecycle history', () => {
  const sample = {
    objects: [
      {
        type: 'attack-pattern',
        id: 'attack-pattern--retired',
        name: '<strong>Retired</strong> technique',
        description: '<p>Publisher &amp; history<br>remains useful.</p>',
        revoked: true,
        external_references: [{ source_name: 'mitre-attack', external_id: 'T0001' }],
      },
      {
        type: 'attack-pattern',
        id: 'attack-pattern--deprecated',
        name: 'Deprecated technique',
        description: 'Historical publisher text.',
        x_mitre_deprecated: true,
        external_references: [{ source_name: 'mitre-attack', external_id: 'T0002' }],
      },
    ],
  };
  const document = parseEnterpriseAttackStix(sample, {
    artifactUrl: 'https://example.test/enterprise-attack-19.2.json',
    version: '19.2', snapshotDate: '2026-08-25', checksum: 'sha256:sample',
  });
  assert.equal(document.records.length, 2);
  assert.equal(document.records[0].status, 'withdrawn');
  assert.equal(document.records[0].title, 'T0001 Retired technique');
  assert.equal(document.records[0].description, 'Publisher & history remains useful.');
  assert.equal(document.records[1].status, 'deprecated');
});

// Citation resolution, exercised against the exact shape MITRE publishes.
// Verified against the pinned Enterprise v19.2 bundle: 2,722 of 2,729 markers
// resolve with a URL; the seven that do not are gaps in MITRE's own data.
const citationStix = {
  objects: [
    {
      type: 'attack-pattern',
      id: 'attack-pattern--valid-accounts',
      name: 'Valid Accounts',
      description:
        'Adversaries may obtain credentials for VPNs and remote desktop.(Citation: volexity_0day_sophos_FW) Compromised credentials may grant privilege.(Citation: CISA MFA PrintNightmare) A key with no reference.(Citation: Nonexistent Reference)',
      kill_chain_phases: [
        { kill_chain_name: 'mitre-attack', phase_name: 'stealth' },
        { kill_chain_name: 'mitre-attack', phase_name: 'initial-access' },
      ],
      external_references: [
        { source_name: 'mitre-attack', external_id: 'T1078', url: 'https://attack.mitre.org/techniques/T1078' },
        {
          source_name: 'volexity_0day_sophos_FW',
          url: 'https://www.volexity.com/blog/2022/06/15/driftingcloud',
          description: 'Adair, S., Lancaster, T. (2022, June 15). DriftingCloud.',
        },
        {
          source_name: 'CISA MFA PrintNightmare',
          url: 'https://www.cisa.gov/uscert/ncas/alerts/aa22-074a',
          description: 'CISA. (2022, March 15). Russian State-Sponsored Actors.',
        },
      ],
    },
    {
      type: 'x-mitre-tactic',
      x_mitre_shortname: 'stealth',
      name: 'Stealth',
      external_references: [{ source_name: 'mitre-attack', external_id: 'TA0005' }],
    },
    {
      type: 'x-mitre-tactic',
      x_mitre_shortname: 'initial-access',
      name: 'Initial Access',
      external_references: [{ source_name: 'mitre-attack', external_id: 'TA0001' }],
    },
  ],
};

test('citation markers resolve to the publisher reference they name', () => {
  const parsed = parseEnterpriseAttackStix(citationStix, {
    artifactUrl: 'https://example.test/enterprise-attack.json',
    version: '19.2',
    snapshotDate: '2026-09-06',
    checksum: 'sha256:test',
    byteLength: 1,
    locatorPrefix: 'enterprise-attack.json',
  });
  const record = parsed.records.find((entry) => entry.id === 'T1078');
  const citations = record.metadata.citations;

  assert.deepEqual(citations.volexity_0day_sophos_FW, {
    title: 'Adair, S., Lancaster, T. (2022, June 15). DriftingCloud.',
    url: 'https://www.volexity.com/blog/2022/06/15/driftingcloud',
  });
  assert.equal(citations['CISA MFA PrintNightmare'].url, 'https://www.cisa.gov/uscert/ncas/alerts/aa22-074a');

  // A key MITRE never published a reference for is absent, so the renderer
  // drops the marker instead of printing a raw internal identifier.
  assert.equal('Nonexistent Reference' in citations, false);

  // The ATT&CK id reference is identity, not a citation, and must not appear.
  assert.equal('mitre-attack' in citations, false);

  // Every tactic MITRE lists is carried, not just the first.
  assert.deepEqual(
    record.metadata.tactic_memberships.map((entry) => entry.title),
    ['Stealth', 'Initial Access'],
  );
});
