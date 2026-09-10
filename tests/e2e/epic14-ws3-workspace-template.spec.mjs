import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import commonsDataset from "../../data/commons-resource-dataset.json" with { type: "json" };

import { attachPageDiagnostics, gotoApp, waitForAppReady } from "./support.mjs";

function supplyChainMatchCount() {
  const root = existsSync(join(process.cwd(), "dist", "site", "data", "generated"))
    ? join(process.cwd(), "dist", "site", "data", "generated")
    : join(process.cwd(), "data", "generated");
  const manifest = JSON.parse(readFileSync(join(root, "library-search-index.json"), "utf8"));
  const fields = manifest.library_search_index.fields;
  const searchable = ["item_id", "title", "control_family", "source_name", "publisher_name", "official_text_preview"];
  return manifest.sharded_collection.shards.reduce((count, shard) => {
    const { columns } = JSON.parse(readFileSync(join(root, shard.path), "utf8")).library_search_index;
    return count + columns[0].filter((_, index) => {
      const text = searchable.map((field) => String(columns[fields.indexOf(field)][index] || "").toLowerCase()).join(" ");
      return text.includes("supply") && text.includes("chain");
    }).length;
  }, 0);
}

test.beforeEach(async ({ page }) => {
  attachPageDiagnostics(page);
});

test("WS3 Library uses Template C browse, facets, and fully linked record rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, "/#/library");
  await waitForAppReady(page, { allowPartial: true });

  const workspace = page.locator('[data-page-template="workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await expect(workspace.locator('[data-browse-state="library"]')).toBeVisible();
  await expect(workspace.getByRole("list", { name: "Search results" })).toHaveCount(0);

  const rail = workspace.getByRole("complementary", { name: "Library filters" });
  await expect(rail).toBeVisible();
  const facetControls = rail.locator('.workspace-facet-controls[data-facet-set="publication,kind,area,asset_class,domain,vendor_brand,program"]');
  await expect(facetControls).toBeVisible();
  await expect(
    facetControls.locator(":scope > .workspace-typeahead > span, :scope > .workspace-checkbox-facet > summary > .workspace-facet-group__label"),
  ).toHaveText(["Publication", "Content kind", "Area"]);
  const advanced = facetControls.locator('details[data-advanced-facet-set="publisher,technology,product,framework,organization,environment,connections"]');
  await expect(advanced).not.toHaveAttribute("open", "");
  await expect(advanced.getByText("Publisher", { exact: true })).toBeHidden();
  await advanced.locator("summary").click();
  await expect(advanced.getByText("Publisher", { exact: true })).toBeVisible();
  await expect(advanced.getByText("Has published connections", { exact: true })).toBeVisible();
  await expect(advanced).not.toContainText("No governed tags are available in this context.");
  const railStyle = await rail.evaluate((element) => ({
    position: element.ownerDocument.defaultView.getComputedStyle(element).position,
    width: Math.round(element.getBoundingClientRect().width),
  }));
  expect(railStyle).toEqual({ position: "sticky", width: 280 });
  await expect(workspace.getByRole("button", { name: "Filters" })).toBeHidden();
  // Empty editorial areas are intentionally not selectable Library facets.
  await expect(workspace.locator(".workspace-area-card .bucket-tag")).toHaveCount(7);

  await page.getByRole("searchbox", { name: "Filter results by ID, title, or topic" }).fill("3.1.1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator('[data-result-bar-order="count,sort,view,compare"]')).toBeVisible();
  const row = page.locator('[data-result-class="published-record"]').first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("heading", { level: 3 })).toHaveText(/^NIST AC 3\.1\.1$/);
  const recordRows = page.locator('[data-result-class="published-record"]');
  await expect(row.locator(".bucket-tag")).toBeVisible();
  expect(await recordRows.count()).toBeGreaterThan(0);
  await expect(recordRows.locator(".bucket-tag")).toHaveCount(await recordRows.count());
  await expect(row.locator(".workspace-result-row__signals")).toBeVisible();
  await expect(row.locator(".workspace-result-row__link")).toHaveCount(1);
  const sizes = await row.evaluate((element) => ({
    row: element.getBoundingClientRect().width,
    link: element.querySelector(".workspace-result-row__link")?.getBoundingClientRect().width || 0,
  }));
  expect(sizes.link).toBeGreaterThan(sizes.row - 8);
  await expect(page.getByRole("button", { name: /Open record/i })).toHaveCount(0);
});

test("WS3 Library communicates visible, loaded, and total search scope", async ({ page }) => {
  const total = supplyChainMatchCount();
  expect(total, "query must exercise the 100-result relevance cap").toBeGreaterThan(100);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, "/#/library?q=supply%20chain");
  await waitForAppReady(page, { allowPartial: true });

  // The header names the way to the matches past the cap, so a reader who never
  // scrolls 100 rows still learns the list is not all of them.
  await expect(page.locator(".workspace-result-count")).toHaveText(
    `${total.toLocaleString("en-US")} matches · showing 25 of the 100 most relevant · narrow with filters to reach the rest`,
  );
  const rows = page.locator('[data-result-class="published-record"]');
  await expect(rows).toHaveCount(25);
  await page.getByRole("button", { name: "Show 25 more" }).click();
  await expect(rows).toHaveCount(50);
  await expect(page.locator(".workspace-result-count")).toHaveText(
    `${total.toLocaleString("en-US")} matches · showing 50 of the 100 most relevant · narrow with filters to reach the rest`,
  );

  await page.getByRole("button", { name: "Map", exact: true }).click();
  const map = page.getByRole("region", { name: "Map of Library results" });
  await expect(map.getByRole("heading", { name: "75 of 100 loaded records mapped" })).toBeVisible();
  await expect(map).toContainText("Refine the query or filters to change this map.");
  await expect(map.locator('[data-map-node-id]')).toHaveCount(75);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("WS3 Resources shares Template C with real list, map, and comparison modes", async ({ page }) => {
  const resourceCount = commonsDataset.resources.length;
  expect(resourceCount).toBeGreaterThan(75);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, "/#/resources");
  await waitForAppReady(page, { allowPartial: true });

  const workspace = page.locator('[data-page-template="workspace"]');
  await expect(workspace.getByRole("heading", { name: "Resources", level: 1 })).toBeVisible();
  const companions = workspace.getByRole("navigation", { name: "Resource companions" });
  const companionLinks = companions.getByRole("link");
  await expect(companionLinks).toHaveText([
    "Looking for a starter document? Browse Templates →",
    "Want framework context? Browse Guides →",
  ]);
  await expect(companionLinks.nth(0)).toHaveAttribute("href", "#/build");
  await expect(companionLinks.nth(1)).toHaveAttribute("href", "#/guides");
  await expect(workspace.locator('[data-browse-state="resources"]')).toBeVisible();
  const rail = workspace.getByRole("complementary", { name: "Resource filters" });
  await expect(rail).toBeVisible();
  await expect(rail.locator('[data-facet-set="collection,type,owner"]')).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Filters" })).toBeHidden();
  await expect(workspace.locator('[data-browse-state="resources"] .eyebrow')).toHaveCount(0);
  await expect(workspace.getByRole("heading", { name: "Contribute", level: 2 })).toBeVisible();
  await expect(workspace.locator(".page-header").getByRole("link", { name: "Submit resource" })).toHaveCount(0);
  const browseColumnCount = await workspace
    .locator('[data-browse-state="resources"] .workspace-browse-grid')
    .evaluate((element) => globalThis.getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(browseColumnCount).toBeGreaterThanOrEqual(3);

  await workspace.getByRole("button", { name: /Browse all \d+ resources/ }).click();
  await expect(page.locator('[data-result-bar-order="count,sort,view,compare"]')).toBeVisible();
  await expect(page.locator(".workspace-result-count")).toHaveText(`${resourceCount.toLocaleString("en-US")} results · showing 25`);
  await expect(page.locator('[data-result-class="resource"]')).toHaveCount(25);
  const firstRow = page.locator('[data-result-class="resource"]').first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow.locator(".resource-type-icon")).toBeVisible();
  await expect(firstRow.locator(".workspace-kind-tag")).toBeVisible();
  await expect(firstRow.getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Open resource/i })).toHaveCount(0);

  await workspace.getByRole("button", { name: "Map", exact: true }).click();
  const map = page.getByRole("region", { name: "Map of Resource results" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("heading", { name: `75 of ${resourceCount.toLocaleString("en-US")} resources mapped` })).toBeVisible();
  await expect(map.locator('[data-map-node-id]')).toHaveCount(75);
  await expect(page.locator(".workspace-result-count")).toHaveText(`${resourceCount.toLocaleString("en-US")} results · mapping 75`);
  await workspace.getByRole("button", { name: "List", exact: true }).click();
  const compare = workspace.getByRole("button", { name: "Compare", exact: true });
  await expect(compare).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "true");
  const selectors = page.getByRole("checkbox", { name: /^Select .* for comparison$/ });
  await selectors.nth(0).check();
  await selectors.nth(1).check();
  await expect(page.getByRole("heading", { name: "Selected resources", level: 2 })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("WS3 Resource detail uses a knowledge-base reading sequence", async ({ page }) => {
  const resource = commonsDataset.resources.find((item) => item.id === "tool-grype-vulnerability-scanner");
  expect(resource).toBeDefined();
  // Publisher media is optional. Assert against the input dataset, never the
  // rendered section, so both a missing image and an invented section fail.
  const media = resource.media?.status === "available" ? resource.media.items : [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, "/#/resources/tool-grype-vulnerability-scanner");
  await waitForAppReady(page, { allowPartial: true });

  const article = page.locator("article.resource-detail-main");
  await expect(page.getByText("Resource", { exact: true })).toBeVisible();
  await expect(page.getByText("Publisher Anchore", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open resource" })).toBeVisible();
  await expect(article.getByRole("heading", { level: 2 })).toHaveText([
    "What it is",
    "How to use or access",
    ...(media.length ? ["Screenshots"] : []),
    "Filed under",
  ]);
  await expect(page.getByRole("heading", { name: "Governed discovery tags" })).toHaveCount(0);
  const details = page.locator("details.resource-detail-maintenance");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  await expect(details.getByText("Verification method", { exact: true })).toBeVisible();
  const images = page.locator(".resource-detail-media img");
  await expect(images).toHaveCount(media.length);
  for (const [index, item] of media.entries()) {
    await expect(images.nth(index)).toHaveAttribute("src", item.url);
    await expect(images.nth(index)).toHaveAttribute("alt", item.alt);
    await expect(page.locator(".resource-detail-media figcaption").nth(index)).not.toContainText(/commit\s+[0-9a-f]/i);
  }
});

test("WS3 facets move to a modal sheet below the desktop breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  for (const route of ["/#/library", "/#/resources"]) {
    await gotoApp(page, route);
    await waitForAppReady(page, { allowPartial: true });
    await expect(page.locator(".workspace-facet-rail")).toBeHidden();
    await page.getByRole("button", { name: "Filters" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    if (route === "/#/library") {
      const facetControls = dialog.locator('.workspace-facet-controls[data-facet-set="publication,kind,area,asset_class,domain,vendor_brand,program"]');
      await expect(
        facetControls.locator(":scope > .workspace-typeahead > span, :scope > .workspace-checkbox-facet > summary > .workspace-facet-group__label"),
      ).toHaveText(["Publication", "Content kind", "Area"]);
      await expect(facetControls.locator("summary", { hasText: "Advanced filters" })).toBeVisible();
    }
    await page.getByRole("button", { name: "Close filters" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("WS3 compact Library rows preserve a readable vertical information hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page, "/#/library?q=AC-2");
  await waitForAppReady(page, { allowPartial: true });
  const row = page.locator(".workspace-result-row").first();
  const body = row.locator(".workspace-result-row__body");
  await expect(row.locator(".workspace-result-row__link")).toBeVisible();
  await expect(body.locator(".workspace-result-row__signals")).toBeVisible();
  const layout = await body.evaluate((element) => {
    const selectors = [
      ".workspace-result-row__meta",
      "h3",
      ".workspace-result-row__snippet",
      ".workspace-result-row__signals",
    ];
    const boxes = selectors.map((selector) => element.querySelector(selector)?.getBoundingClientRect());
    return {
      direction: element.ownerDocument.defaultView.getComputedStyle(element).flexDirection,
      overlaps: boxes.slice(1).some((box, index) => Boolean(
        box && boxes[index] && box.top < boxes[index].bottom - 1,
      )),
    };
  });
  expect(layout.direction).toBe("column");
  expect(layout.overlaps).toBe(false);
});

test("WS3 Library presents generated records with human identity at every governed width", async ({ page }) => {
  test.setTimeout(120_000);
  const records = [
    {
      id: "nist-zt:COLLABORATOR-APPGATE-835EC7F121",
      primary: "Appgate",
      type: "Technology collaborator",
    },
    {
      id: "nist-zt:MAPPING-CONTRIBUTOR-APPGATE-835EC7F121",
      primary: "Appgate",
      type: "Mapping workbook contributor",
    },
    {
      id: "nist-zt:PRODUCT-COMPONENT-APPGATE-APPGATE-HEADLESS-CLIENT-RESOURCE-PROTECTION-CL-E65DEBF0E8",
      primary: "Appgate Headless Client — Resource Protection – Cloud Workload Protection",
      type: "Product component",
    },
  ];

  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
    await gotoApp(page, "/#/library?q=Appgate");
    await waitForAppReady(page, { allowPartial: true });
    for (const record of records) {
      const row = page.locator(`[data-record-id="${record.id}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByRole("heading", { name: record.primary, level: 3 })).toBeVisible();
      await expect(row.locator(".workspace-result-row__meta")).toContainText(record.type);
      await expect(row.locator(".workspace-result-row__meta")).toContainText("NIST Zero Trust");
      await expect(row.locator(".workspace-result-row__meta")).not.toContainText("nist-zt");
      const link = row.locator(".workspace-result-row__link");
      await expect(link).toHaveAttribute(
        "aria-label",
        `Open ${record.primary}, ${record.type}, NIST Zero Trust`,
      );
      await expect(row.getByRole("heading", { level: 3 })).not.toContainText(/-[0-9A-F]{10}$/);
      await expect(link).not.toHaveAttribute("aria-label", /-[0-9A-F]{10}$/);
    }
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
      ),
      `${width}px Library overflow`,
    ).toBeLessThanOrEqual(1);
  }
});

test("WS3 global search and publication rows use the same generated identity contract", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });

    await gotoApp(page, "/#/library");
    await waitForAppReady(page, { allowPartial: true });
    await page.getByRole("button", { name: "Open search" }).click();
    const dialog = page.getByRole("dialog", { name: "Search Control Atlas" });
    const search = dialog.getByRole("searchbox", { name: "Search Control Atlas" });
    await search.fill("Appgate");
    const collaborator = dialog.getByRole("link", {
      name: "Open Appgate, Technology collaborator, NIST Zero Trust",
    });
    await expect(collaborator).toBeVisible();
    await expect(collaborator.getByRole("heading", { name: "Appgate", level: 3 })).toBeVisible();
    await expect(collaborator).toContainText("Technology collaborator · NIST Zero Trust");

    await gotoApp(page, "/#/library/publication/nist-zt?browseAll=true&q=Appgate");
    await waitForAppReady(page, { allowPartial: true });
    const row = page.getByRole("link", {
      name: "Open Appgate, Technology collaborator, NIST Zero Trust",
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Appgate");
    await expect(row).toContainText("Technology collaborator · NIST Zero Trust");
    await expect(row).not.toContainText("COLLABORATOR-APPGATE-835EC7F121");
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
      ),
      `${width}px publication overflow`,
    ).toBeLessThanOrEqual(1);
  }
});
