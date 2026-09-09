#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToPlainText } from "./lib/markdown-to-text.mjs";
import { strictConditionalFetch } from "./lib/strict-conditional-fetch.mjs";
import { writeJsonAtomically } from "./lib/write-json-atomically.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_PATH = join(ROOT, "data", "commons-resource-dataset.json");
const CAPTURED_AT = new Date().toISOString().slice(0, 10);
const INSTALLABLE_TYPES = new Set(["tool", "ecosystem", "service_portal", "restricted_service"]);
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const PROFILE_TEMPLATES = Object.freeze({
  tool: "tool",
  documentation: "reference",
  training: "training",
  catalog: "directory",
  community_forum: "community",
  dataset: "data",
  product_directory: "directory",
  ecosystem: "ecosystem",
  government_portal: "destination",
  historical_reference: "reference",
  service_portal: "destination",
  matrix: "data",
  restricted_service: "destination",
  template: "artifact",
  instruction: "reference",
  specification: "reference",
  marketplace: "directory",
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function repositoryIdentity(resource) {
  try {
    const url = new URL(resource.repositoryUrl || resource.canonicalUrl || "");
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, ""), scope: "repository" };
    }
    if (parts.length === 1 && resource.id === "tool-ansible-lockdown") {
      return { owner: parts[0], repo: ".github", scope: "organization_profile" };
    }
    return null;
  } catch {
    return null;
  }
}

function cleanMarkdown(value) {
  return markdownToPlainText(value);
}

function excerpt(value, maximum = 1800) {
  const cleaned = cleanMarkdown(value);
  if (cleaned.length <= maximum) return cleaned;
  const shortened = cleaned.slice(0, maximum);
  const boundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, boundary > maximum * 0.75 ? boundary : maximum).trim()}…`;
}

function readmeOverview(readme) {
  const paragraphs = String(readme || "").split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    if (/^\s*(?:#|!\[|<img|<picture|<div|\[!\[)/i.test(paragraph)) continue;
    const cleaned = excerpt(paragraph, 900);
    if (cleaned.length >= 60) return cleaned;
  }
  return null;
}

function markdownSections(readme) {
  const sections = [];
  const matches = [...String(readme || "").matchAll(/^#{1,4}\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = (matches[index].index || 0) + matches[index][0].length;
    const end = matches[index + 1]?.index ?? readme.length;
    const text = excerpt(readme.slice(start, end));
    if (text) sections.push({ heading: cleanMarkdown(matches[index][1]), text });
  }
  return sections;
}

function matchingSection(sections, patterns) {
  return sections.find((section) => patterns.some((pattern) => pattern.test(section.heading))) || null;
}

function documentedSection(section, sourceUrl) {
  return section ? { status: "documented", text: section.text, sourceUrl } : null;
}

function githubHeaders(accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    "User-Agent": "control-atlas-resource-ingestion",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  };
}

async function githubJson(url, options = {}) {
  const response = await strictConditionalFetch(url, { ...options, headers: githubHeaders() });
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function imageDimensions(bytes, contentType) {
  if (contentType === "image/png" && bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (contentType === "image/gif" && bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (contentType === "image/svg+xml") {
    const markup = bytes.toString("utf8", 0, Math.min(bytes.length, 8192));
    const width = Number(markup.match(/\bwidth=["']([\d.]+)/i)?.[1]);
    const height = Number(markup.match(/\bheight=["']([\d.]+)/i)?.[1]);
    if (width > 0 && height > 0) return { width, height };
    const viewBox = markup.match(/\bviewBox=["'][^"']*?([\d.]+)\s+([\d.]+)["']/i);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }
  if (contentType === "image/jpeg" && bytes.length >= 4) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

function readmeMedia(readme, identity, commitSha, readmeUrl) {
  const markdown = [...String(readme || "").matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => ({ alt: cleanMarkdown(match[1]), url: match[2] }));
  const html = [...String(readme || "").matchAll(/<img\b[^>]*>/gi)].map((match) => ({
    alt: cleanMarkdown(match[0].match(/\balt=["']([^"']*)["']/i)?.[1]),
    url: match[0].match(/\bsrc=["']([^"']+)["']/i)?.[1] || "",
  }));
  const candidates = [];
  for (const candidate of [...markdown, ...html]) {
    const signal = `${candidate.alt} ${candidate.url}`;
    if (!/(?:screen(?:shot)?|preview|demo|dashboard|interface|terminal|console|report|example)/i.test(signal)) continue;
    if (/(?:badge|shield|coverage|workflow|license|logo)/i.test(signal)) continue;
    let url;
    try {
      url = new URL(candidate.url, `https://raw.githubusercontent.com/${identity.owner}/${identity.repo}/${commitSha}/`).href;
    } catch {
      continue;
    }
    candidates.push({
      kind: "publisher_screenshot",
      url,
      alt: candidate.alt || `${identity.repo} publisher screenshot`,
      sourceUrl: readmeUrl,
    });
    if (candidates.length === 3) break;
  }
  return candidates;
}

async function validatedMediaItems(items, provenance) {
  if (!provenance.license || provenance.license === "NOASSERTION") return [];
  const valid = [];
  for (const item of items || []) {
    try {
      const response = await strictConditionalFetch(item.url, {
        headers: { "User-Agent": "control-atlas-resource-ingestion" },
        redirect: "follow",
      });
      const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
      const lengthHeader = Number(response.headers.get("content-length") || 0);
      if (!response.ok || !contentType.startsWith("image/") || lengthHeader > 10_000_000) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 10_000_000) continue;
      const dimensions = imageDimensions(bytes, contentType);
      if (!dimensions?.width || !dimensions?.height) continue;
      valid.push({
        ...item,
        sha256: sha256(bytes),
        byteLength: bytes.length,
        contentType,
        width: dimensions.width,
        height: dimensions.height,
        license: provenance.license,
        licenseBasis: "repository_license",
        retrievedAt: CAPTURED_AT,
        commitSha: provenance.commitSha,
      });
    } catch {
      // Media is optional, but absence is made explicit on the Resource record.
    }
  }
  return valid;
}

async function fetchRepositoryEvidence(identity) {
  const apiUrl = `https://api.github.com/repos/${identity.owner}/${identity.repo}`;
  const repository = await githubJson(apiUrl);
  const branch = repository.default_branch || "main";
  const commit = await githubJson(`${apiUrl}/commits/${encodeURIComponent(branch)}`);
  const commitSha = commit.sha;
  if (!/^[a-f0-9]{40}$/i.test(commitSha || "")) throw new Error(`${apiUrl} did not return a valid default-branch commit`);
  const readmeDocument = await githubJson(`${apiUrl}/readme?ref=${commitSha}`);
  const readmeBytes = Buffer.from(String(readmeDocument.content || "").replace(/\s/g, ""), "base64");
  if (!readmeBytes.length) throw new Error(`${apiUrl} README content was empty`);
  const readme = readmeBytes.toString("utf8");
  const readmePath = readmeDocument.path || "README.md";
  const readmeUrl = `https://github.com/${identity.owner}/${identity.repo}/blob/${commitSha}/${readmePath}`;
  const sections = markdownSections(readme);
  const latestRelease = await githubJson(`${apiUrl}/releases/latest`, { allowNotFound: true });
  const release = latestRelease
    ? {
        status: "published",
        version: latestRelease.tag_name || latestRelease.name,
        name: latestRelease.name || latestRelease.tag_name,
        url: latestRelease.html_url,
        publishedAt: latestRelease.published_at || null,
        prerelease: Boolean(latestRelease.prerelease),
      }
    : {
        status: "not_published",
        version: null,
        name: null,
        url: `https://github.com/${identity.owner}/${identity.repo}/releases`,
        publishedAt: null,
        prerelease: false,
      };
  const license = repository.license?.spdx_id || null;
  const mediaCandidates = readmeMedia(readme, identity, commitSha, readmeUrl);
  const media = await validatedMediaItems(mediaCandidates, { license, commitSha });
  return {
    capturedAt: CAPTURED_AT,
    repositoryScope: identity.scope,
    repositoryApiUrl: apiUrl,
    commitSha,
    commitUrl: `https://github.com/${identity.owner}/${identity.repo}/commit/${commitSha}`,
    readmePath,
    readmeUrl,
    readmeSha256: sha256(readmeBytes),
    readmeByteLength: readmeBytes.length,
    overviewExcerpt: readmeOverview(readme),
    sections: {
      installation: matchingSection(sections, [/\binstall(?:ation)?\b/i, /\bsetup\b/i, /\bprerequisites?\b/i]),
      usage: matchingSection(sections, [/\busage\b/i, /\bquick\s*start\b/i, /\bgetting started\b/i, /\brunning\b/i]),
      inputs: matchingSection(sections, [/\binputs?\b/i, /\bscan targets?\b/i]),
      outputs: matchingSection(sections, [/\boutputs?\b/i, /\breporting\b/i]),
      formats: matchingSection(sections, [/\bformats?\b/i]),
      integrations: matchingSection(sections, [/\bintegrations?\b/i, /\bplugins?\b/i]),
      limitations: matchingSection(sections, [/\blimitations?\b/i, /\bcaveats?\b/i, /\bknown issues?\b/i, /\bunsupported\b/i]),
      compatibility: matchingSection(sections, [/\bsupported platforms?\b/i, /\brequirements?\b/i, /\bprerequisites?\b/i, /\binstall(?:ation)?\b/i]),
    },
    media,
    release,
    facts: {
      defaultBranch: branch,
      primaryLanguage: repository.language || null,
      topics: repository.topics || [],
      archived: Boolean(repository.archived),
      lastPushedAt: repository.pushed_at || null,
      latestRepositoryUpdateAt: repository.updated_at || null,
      license,
      description: repository.description || null,
    },
  };
}

function documentedCompatibility(evidence) {
  const text = evidence?.sections?.compatibility?.text || "";
  const operatingSystems = [];
  const environments = [];
  if (/\bwindows\b/i.test(text)) operatingSystems.push("Windows");
  if (/\bmac(?:os| os|intosh)\b|\bos x\b/i.test(text)) operatingSystems.push("macOS");
  if (/\blinux\b|\bubuntu\b|\brhel\b|\bdebian\b/i.test(text)) operatingSystems.push("Linux");
  if (/\bdocker\b|\bcontainer(?:s|ized)?\b/i.test(text)) environments.push("Containers");
  if (/\bkubernetes\b|\bk8s\b/i.test(text)) environments.push("Kubernetes");
  return { operatingSystems, environments };
}

function baseCompatibility(resource) {
  if (!INSTALLABLE_TYPES.has(resource.resourceType)) {
    return {
      status: "not_applicable",
      operatingSystems: [],
      environments: [],
      sourceUrl: resource.sourceEvidence,
      note: "This resource is guidance, data, training, or a web destination rather than installable software.",
    };
  }
  const operatingSystems = (resource.platforms || []).filter((entry) => entry !== "all");
  return {
    status: operatingSystems.length ? "documented" : "not_stated",
    operatingSystems,
    environments: [],
    sourceUrl: resource.sourceEvidence,
    // An unknown is recorded with a stated reason, never as an empty string:
    // "we looked and the publisher does not say" is information, and blank is not.
    note: operatingSystems.length
      ? "Publisher-supported platforms recorded by the reviewed resource inventory."
      : "The reviewed resource inventory records no publisher-stated platform support for this resource.",
  };
}

function presentationSection(status, text, sourceUrl, values = []) {
  return { status, text, sourceUrl, ...(values.length ? { values } : {}) };
}

function presentationProfile(resource, overview) {
  const audienceValues = resource.audiences || [];
  const limitations = [resource.legacyReason, ...(resource.warnings || [])].filter(Boolean);
  return {
    profileType: resource.resourceType,
    template: PROFILE_TEMPLATES[resource.resourceType] || "reference",
    whatItDoes: presentationSection("documented", resource.summary, resource.sourceEvidence),
    ...(audienceValues.length
      ? { whoItIsFor: presentationSection("documented", `Intended audience: ${audienceValues.join(", ")}.`, resource.sourceEvidence, audienceValues) }
      : {}),
    ...(limitations.length
      ? { limitations: presentationSection("documented", limitations.join(" "), resource.sourceEvidence, limitations) }
      : {}),
  };
}

function toolProfile(resource, evidence) {
  const readmeUrl = evidence?.readmeUrl || resource.sourceEvidence;
  const section = (name) => documentedSection(evidence?.sections?.[name], readmeUrl);
  const maintenance = evidence?.facts
    ? {
        status: evidence.facts.archived ? "archived" : "active",
        text: evidence.facts.archived
          ? "The repository is archived."
          : `Latest repository push: ${evidence.facts.lastPushedAt}.`,
        sourceUrl: evidence.repositoryApiUrl,
      }
    : null;
  return {
    ...(section("inputs") ? { inputs: section("inputs") } : {}),
    ...(section("outputs") ? { outputs: section("outputs") } : {}),
    ...(section("formats") ? { formats: section("formats") } : {}),
    ...(section("integrations") ? { integrations: section("integrations") } : {}),
    ...(section("installation") ? { installation: section("installation") } : {}),
    ...(section("usage") ? { usage: section("usage") } : {}),
    ...(resource.license ? { license: { status: "documented", text: resource.license, sourceUrl: evidence?.repositoryApiUrl || resource.sourceEvidence } } : {}),
    ...(maintenance ? { maintenance } : {}),
    ...(evidence?.release ? { release: evidence.release } : {}),
  };
}

export function repositoryResourceIds(dataset) {
  return dataset.resources.filter((resource) => repositoryIdentity(resource)).map((resource) => resource.id);
}

export async function enrichCommonsDataset(dataset, {
  refresh: REFRESH = false, id: REFRESH_ID = '', validateMedia: VALIDATE_MEDIA = false,
  fetchEvidence = fetchRepositoryEvidence,
} = {}) {
if (REFRESH_ID && !dataset.resources.some((resource) => resource.id === REFRESH_ID && repositoryIdentity(resource))) {
  throw new Error(`Unknown repository resource ID: ${REFRESH_ID}`);
}
let repositoryCount = 0;
let mediaCount = 0;
let failureCount = 0;
for (const resource of dataset.resources) {
  if (REFRESH_ID && resource.id !== REFRESH_ID) continue;
  const identity = repositoryIdentity(resource);
  if (identity?.scope === "repository" && !resource.repositoryUrl) resource.repositoryUrl = resource.canonicalUrl;
  let repositoryEvidence = resource.repositoryEvidence || null;
  if (REFRESH && identity && (!REFRESH_ID || REFRESH_ID === resource.id)) {
    try {
      repositoryEvidence = await fetchEvidence(identity);
      repositoryCount += 1;
    } catch (error) {
      failureCount += 1;
      console.warn(`${resource.id}: ${error.message}`);
    }
  }
  if (VALIDATE_MEDIA && repositoryEvidence?.media?.length) {
    repositoryEvidence.media = await validatedMediaItems(repositoryEvidence.media, {
      license: repositoryEvidence.facts?.license,
      commitSha: repositoryEvidence.commitSha,
    });
  }
  const compatibility = baseCompatibility(resource);
  if (repositoryEvidence?.sections) {
    const { operatingSystems, environments } = documentedCompatibility(repositoryEvidence);
    if (operatingSystems.length || environments.length) {
      compatibility.status = "documented";
      compatibility.operatingSystems = operatingSystems;
      compatibility.environments = environments;
      compatibility.sourceUrl = repositoryEvidence.readmeUrl;
      compatibility.note = "Supported environments stated in the commit-pinned repository README.";
    }
  }
  const mediaItems = repositoryEvidence?.media || [];
  mediaCount += mediaItems.length;
  const overview = {
    text: repositoryEvidence?.overviewExcerpt || resource.summary,
    sourceUrl: repositoryEvidence?.readmeUrl || resource.sourceEvidence,
    sourceType: repositoryEvidence?.overviewExcerpt ? "repository_readme" : "publisher_source",
    exactPublisherText: Boolean(repositoryEvidence?.overviewExcerpt),
  };
  resource.overview = overview;
  resource.compatibility = compatibility;
  resource.media = mediaItems.length
    ? { status: "available", items: mediaItems, sourceUrl: repositoryEvidence.readmeUrl }
    : {
        status: "not_available",
        items: [],
        sourceUrl: repositoryEvidence?.readmeUrl || resource.sourceEvidence,
        reason: identity
          ? "No attributable, dimensioned screenshot with repository-license evidence was available in the reviewed commit-pinned README."
          : "No attributable publisher screenshot was available for this resource.",
      };
  resource.repositoryEvidence = repositoryEvidence;
  resource.presentationProfile = presentationProfile(resource, overview);
  if (resource.resourceType === "tool") resource.toolProfile = toolProfile(resource, repositoryEvidence);
  else delete resource.toolProfile;

  if (resource.currentVersion === "Current") resource.currentVersion = null;
  if (repositoryEvidence?.release?.status === "published") {
    resource.currentVersion = repositoryEvidence.release.version;
    resource.lastReleaseAt = repositoryEvidence.release.publishedAt;
  }
  if (repositoryEvidence?.facts) {
    resource.publisherUpdatedAt = repositoryEvidence.facts.latestRepositoryUpdateAt?.slice(0, 10) || resource.publisherUpdatedAt;
    resource.lastCommitAt = repositoryEvidence.facts.lastPushedAt;
    resource.maintenanceStatus = repositoryEvidence.facts.archived ? "archived" : resource.maintenanceStatus;
    if (repositoryEvidence.facts.license && repositoryEvidence.facts.license !== "NOASSERTION") {
      resource.license = repositoryEvidence.facts.license;
    }
  }
}

if (failureCount) {
  throw new Error(`Resource enrichment failed closed with ${failureCount} repository error(s); the dataset was not rewritten.`);
}
if (REFRESH) dataset.lastUpdated = CAPTURED_AT;
return { dataset, repositoryCount, mediaCount };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const id = process.argv.find((argument) => argument.startsWith('--id='))?.slice('--id='.length) || '';
  if (process.argv.includes('--id=')) throw new Error('--id requires a repository resource ID');
  enrichCommonsDataset(JSON.parse(readFileSync(DATASET_PATH, 'utf8')), {
    refresh: process.argv.includes('--refresh'), id, validateMedia: process.argv.includes('--validate-media'),
  }).then(({ dataset, repositoryCount, mediaCount }) => {
    writeJsonAtomically(DATASET_PATH, dataset);
    console.log(`Resource enrichment: ${repositoryCount} repositories refreshed, ${mediaCount} attributable media item(s).`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
