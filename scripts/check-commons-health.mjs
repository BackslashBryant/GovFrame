import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const datasetPath = resolve("data/commons-resource-dataset.json");
const reportJsonPath = resolve("data/commons-health-report.json");
const reportMdPath = resolve("artifacts/commons-health-report.md");
const checkedAt = new Date().toISOString();
const restrictedAccess = new Set(["cac_required", "dod_network_required", "invitation_required", "access_varies"]);

function tier(resource) {
  if (/kev|nvd/i.test(resource.id) || resource.resourceType === "dataset") return "hot";
  if (resource.resourceLane === "open_source" || resource.resourceType === "tool") return "active";
  if (resource.resourceType === "community_forum") return "slow";
  if (resource.resourceLane === "legacy") return "legacy";
  return "normal";
}

async function request(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "ControlAtlasResourceHealth/3.0 (+https://github.com/rambulls/control-atlas)",
        ...(method === "GET" ? { Range: "bytes=0-2047" } : {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function check(resource, requestResource = request) {
  const base = { id: resource.id, name: resource.name, canonicalUrl: resource.canonicalUrl, publisher: resource.publisher, tier: tier(resource), checkedAt };
  if (restrictedAccess.has(resource.accessType) ||
      (resource.verificationMethod === "manual_restricted" && resource.publicAccessNotes)) {
    return { ...base, outcome: "manual_expected_access", ok: true, status: null, finalUrl: resource.canonicalUrl, note: resource.publicAccessNotes };
  }
  try {
    let response = await requestResource(resource.canonicalUrl, "HEAD");
    if ([403, 405, 406, 429].includes(response.status)) response = await requestResource(resource.canonicalUrl, "GET");
    const expectedAuth = [401, 403].includes(response.status) && resource.accountRequired;
    const ok = response.ok || expectedAuth;
    return { ...base, outcome: expectedAuth ? "expected_auth_boundary" : ok ? "reachable" : "http_error", ok, status: response.status, finalUrl: response.url || resource.canonicalUrl, note: ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ...base, outcome: "network_error", ok: false, status: null, finalUrl: resource.canonicalUrl, note: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  mkdirSync(resolve("artifacts"), { recursive: true });
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
  const results = [];
  for (let index = 0; index < dataset.resources.length; index += 8) {
    results.push(...await Promise.all(dataset.resources.slice(index, index + 8).map((resource) => check(resource))));
  }
  const failures = results.filter((result) => !result.ok);
  const summary = { schemaVersion: "3.0", checkedAt, totalResources: results.length, passedCount: results.length - failures.length, failedCount: failures.length, manualExpectedAccessCount: results.filter((result) => result.outcome === "manual_expected_access").length, results };
  writeFileSync(reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const rows = failures.length ? failures.map((result) => `| \`${result.id}\` | ${result.status || "Network"} | ${String(result.note).replaceAll("|", "\\|")} |`).join("\n") : "| _None_ | — | All public links responded or met an expected authentication boundary. |";
  const markdown = `# Resources health report

Checked: ${checkedAt}

- Resources: ${results.length}
- Reachable or expected restricted boundary: ${summary.passedCount}
- Expected manual-access checks: ${summary.manualExpectedAccessCount}
- Public-link failures requiring review: ${summary.failedCount}

Restricted CAC, DoD-network, invitation, and variable-access services are recorded as manual expected-access checks. The checker never fabricates a successful response for a fast mode.

## Public-link failures

| Resource | Status | Observation |
|---|---:|---|
${rows}
`;
  writeFileSync(reportMdPath, markdown, "utf8");
  console.log(`Checked ${results.length} resources: ${summary.passedCount} passed or expected-restricted, ${failures.length} public failures.`);
  if (process.argv.includes("--strict") && failures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
