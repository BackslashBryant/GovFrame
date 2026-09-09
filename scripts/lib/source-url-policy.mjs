// Audited publisher hosts from ingestion literals and source-registry.json.
// Exact hosts only: a redirect does not grant authority to another destination.
const PUBLISHER_HOSTS = new Set([
  'airc.nist.gov', 'csrc.nist.gov', 'nvlpubs.nist.gov', 'pages.nist.gov', 'www.nist.gov',
  'd3fend.mitre.org', 'dl.dod.cyber.mil', 'public.cyber.mil', 'www.cyber.mil',
  'dodcio.defense.gov', 'download.microsoft.com', 'www.archives.gov', 'www.fedramp.gov',
  'www.ai.mil', 'www.ecfr.gov', 'www.esd.whs.mil', 'www.federalregister.gov',
  'www.govinfo.gov', 'www.acquisition.gov', 'uscode.house.gov',
  'whitehouse.gov', 'www.whitehouse.gov',
]);

// Publisher-maintained repositories identified in committed Commons canonical
// repository URLs and fetcher literals. This static list deliberately does not
// read refreshed data or admit arbitrary repositories under these owners.
const PUBLISHER_REPOSITORIES = new Set([
  'anchore/grype', 'anchore/syft', 'aquasecurity/kube-bench', 'aquasecurity/trivy',
  'bridgecrewio/checkov', 'checkmarx/kics', 'cisagov/cset', 'cisagov/decider',
  'cisagov/malcolm', 'cisagov/scubagear', 'cisagov/vulnrichment', 'cisofy/lynis',
  'cloud-custodian/cloud-custodian', 'complianceascode/content', 'cyberark/community',
  'cyclonedx/cyclonedx-cli', 'dependencytrack/dependency-track', 'elastic/detection-rules',
  'falcosecurity/falco', 'gchq/cyberchef', 'gitleaks/gitleaks', 'google/osv-scanner',
  'gsa/oscal-ssp-to-word', 'ibm/compliance-trestle', 'kubescape/kubescape',
  'maester365/maester', 'microsoft/powerstig', 'microsoft/stigrepo',
  'microsoft365dsc/microsoft365dsc', 'misp/misp', 'mitre-attack/attack-navigator',
  'mitre/caldera', 'mitre/emass_client', 'mitre/heimdall2', 'mitre/saf', 'mitre/vulcan',
  'nccgroup/scoutsuite', 'nswc-crane/c-pat', 'nuwcdivnpt/stig-manager',
  'open-policy-agent/opa', 'opencontrol/compliance-masonry', 'opencti-platform/opencti',
  'openscap/openscap', 'oscal-club/awesome-oscal', 'osquery/osquery', 'ossf/scorecard',
  'projectdiscovery/nuclei', 'prowler-cloud/prowler', 'redcanaryco/atomic-red-team',
  'scipag/hardeningkitty', 'semgrep/semgrep', 'sigmahq/sigma', 'sigstore/cosign',
  'specterops/bloodhound', 'tenable/terrascan', 'turbot/steampipe', 'usnistgov/macos_security',
  'velocidex/velociraptor', 'virustotal/yara-x', 'volatilityfoundation/volatility3', 'wazuh/wazuh',
  'fedramp/rules', 'mitre-attack/attack-stix-data', 'usnistgov/oscal-content',
  'usnistgov/zero-trust-architecture',
]);

export function assertOfficialSourceUrl(input) {
  const raw = String(input);
  const reject = () => { throw new Error('source URL policy rejected unapproved destination'); };
  if ([...raw].some((char) => char === '\\' || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
      /%(?:2e|2f|5c|25)/i.test(raw.split(/[?#]/)[0])) reject();
  let url;
  try { url = new URL(raw); } catch { reject(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) reject();
  // Reject ambiguous encoded path separators, dot segments, and nested encoding.
  if (/%(?:2e|2f|5c|25)/i.test(url.pathname)) reject();
  if (PUBLISHER_HOSTS.has(url.hostname)) return url;
  const parts = url.pathname.split('/').filter(Boolean);
  const api = url.hostname === 'api.github.com';
  if (api && parts.shift() !== 'repos') reject();
  if (!api && !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) reject();
  if (!PUBLISHER_REPOSITORIES.has(parts.slice(0, 2).join('/').toLowerCase())) reject();
  const rest = parts.slice(2);
  if (api) {
    if (rest.length && !(
      (['commits', 'branches'].includes(rest[0]) && rest.length === 2) ||
      (rest[0] === 'readme' && rest.length === 1) ||
      (rest[0] === 'releases' && rest[1] === 'latest' && rest.length === 2)
    )) reject();
  } else if (url.hostname === 'raw.githubusercontent.com') {
    if (rest.length < 2) reject();
  } else if (rest.length && !(
    (['blob', 'raw', 'tree'].includes(rest[0]) && rest.length >= 3) ||
    (rest[0] === 'releases' && (rest.length === 1 || (rest[1] === 'tag' && rest.length === 3)))
  )) reject();
  return url;
}
