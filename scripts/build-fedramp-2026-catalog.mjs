#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomically } from "./lib/write-json-atomically.mjs";
import { assertPublisherInventory } from "./lib/publisher-inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "data", "fedramp-2026-rules.json");
const OUTPUT = join(ROOT, "data", "fedramp-2026-catalog.json");
const SOURCE_KEY = "fedramp-2026-rules";

function text(values) {
  return values.flat(Infinity).filter((value) => typeof value === "string" && value.trim()).join("\n\n");
}

function source(locator, data) {
  return {
    key: SOURCE_KEY,
    locator,
    snapshot_date: data.info.last_updated,
    version: data.info.version,
  };
}

export function normalizeFedramp2026(data, sourceEvidence = {}) {
  const records = [];
  const inventory = { control_context: 0, definitions: 0, rules: 0, key_security_indicators: 0 };

  for (const [family, controls] of Object.entries(data.CTL || {})) {
    for (const [controlId, control] of Object.entries(controls || {})) {
      const description = text([
        control.guidance || [],
        (control.parameters || []).map((parameter) => `${parameter.parameterId}: ${parameter.value}`),
      ]);
      if (!description) continue;
      records.push({
        id: `CTL-${controlId}`,
        type: "control_context",
        title: `${controlId} control context`,
        description,
        family: `Control parameters and guidance: ${family}`,
        source: source(`CTL.${family}.${controlId}`, data),
      });
      inventory.control_context += 1;
    }
  }

  for (const [definitionId, definition] of Object.entries(data.FRD?.data?.all || {})) {
    records.push({
      id: definitionId,
      type: "definition",
      title: definition.term || definitionId,
      description: definition.definition,
      family: data.FRD.info?.name || "FedRAMP Definitions",
      source: source(`FRD.data.all.${definitionId}`, data),
    });
    inventory.definitions += 1;
  }

  for (const [processId, process] of Object.entries(data.FRR || {})) {
    for (const [applicability, subsets] of Object.entries(process.data || {})) {
      for (const [subsetId, rules] of Object.entries(subsets || {})) {
        for (const [ruleId, rule] of Object.entries(rules || {})) {
          const variedStatements = Object.entries(rule.varies_by_class || {})
            .map(([classId, variant]) => `Class ${classId.toUpperCase()}: ${variant.statement || ""}`);
          const description = text([rule.statement || [], variedStatements]);
          if (!description) continue;
          records.push({
            id: ruleId,
            type: "rule",
            title: rule.name || ruleId,
            description,
            discussion: text([rule.following_information || [], rule.notes || [], rule.note || []]),
            family: process.info?.name || processId,
            source: source(`FRR.${processId}.data.${applicability}.${subsetId}.${ruleId}`, data),
            metadata: {
              applicability,
              subset_id: subsetId,
              force: rule.force || null,
              effective: process.info?.effective || null,
            },
          });
          inventory.rules += 1;
        }
      }
    }
  }

  for (const [groupId, group] of Object.entries(data.KSI || {})) {
    for (const [indicatorId, indicator] of Object.entries(group.indicators || {})) {
      const variedStatements = Object.entries(indicator.varies_by_class || {})
        .map(([classId, variant]) => `Class ${classId.toUpperCase()}: ${variant.statement || ""}`);
      const description = text([indicator.statement || [], variedStatements]);
      if (!description) continue;
      records.push({
        id: indicatorId,
        type: "key_security_indicator",
        title: indicator.name || indicatorId,
        description,
        family: `Key Security Indicators: ${group.name || groupId}`,
        source: source(`KSI.${groupId}.indicators.${indicatorId}`, data),
        metadata: {
          controls: indicator.controls || [],
          status: group.status || null,
        },
      });
      inventory.key_security_indicators += 1;
    }
  }

  records.sort((left, right) => left.id.localeCompare(right.id));
  const publisherInventory = assertPublisherInventory('fedramp-2026', data, records);
  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_artifact: "https://raw.githubusercontent.com/FedRAMP/rules/main/fedramp-consolidated-rules.json",
    source_version: data.info.version,
    snapshot_date: data.info.last_updated,
    source_inventory: { ...inventory, total: records.length },
    record_count: records.length,
    publisher_inventory: { ...sourceEvidence, ...publisherInventory, publisher_version: data.info.version || null },
    records,
  };
}

export function buildFedramp2026FromBytes(bytes, previousDocument = null) {
  const inputSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const prior = previousDocument?.publisher_inventory;
  const sourceMatches = prior?.source_sha256 === inputSha && prior?.source_byte_length === bytes.length;
  return normalizeFedramp2026(JSON.parse(bytes.toString('utf8')), {
    input_sha256: inputSha,
    input_byte_length: bytes.length,
    source_url: prior?.source_url || null,
    source_sha256: sourceMatches ? prior.source_sha256 : null,
    source_byte_length: sourceMatches ? prior.source_byte_length : null,
    ...(sourceMatches ? {} : { source_evidence_reason: 'Input bytes do not match retained downloaded-byte evidence; only the local input checksum is verified' }),
  });
}

if (process.argv[1]?.includes('build-fedramp-2026-catalog.mjs')) {
  const prior = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : null;
  const normalized = buildFedramp2026FromBytes(readFileSync(INPUT), prior);
  writeJsonAtomically(OUTPUT, normalized);
  console.log(`Normalized ${normalized.record_count} FedRAMP 2026 records.`);
}
