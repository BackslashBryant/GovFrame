import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

import { dismissOnboarding, gotoApp, waitForAppReady } from "./support.mjs";

const LARGE_COMPARE =
  "/#/compare/relationships?intent=frameworks&source=nist-800-53&target=disa-cci&compareRun=true";

function expectedMappings() {
  const root = new URL("../../data/generated/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("edges.json", root), "utf8"));
  const sources = new Set();
  let mappings = 0;
  for (const shard of manifest.sharded_collection.shards) {
    for (const edge of JSON.parse(readFileSync(new URL(shard.path, root), "utf8")).edges) {
      if (edge.publication_status !== "published") continue;
      const endpoints = [edge.source_node_id, edge.target_node_id];
      const source = endpoints.find((id) => id.startsWith("nist-800-53:"));
      if (!source || !endpoints.some((id) => id.startsWith("disa-cci:"))) continue;
      mappings += 1;
      sources.add(source.slice("nist-800-53:".length));
    }
  }
  return { mappings, sourceIds: [...sources].sort((a, b) => a.localeCompare(b)) };
}

test("large Compare results use restorable 100-row pages while totals and exports remain complete", async ({ page }) => {
  const { mappings, sourceIds } = expectedMappings();
  const totalPages = Math.ceil(sourceIds.length / 100);
  const lastPageIds = sourceIds.slice((totalPages - 1) * 100);
  const format = (count) => count.toLocaleString("en-US");
  expect(totalPages, "fixture must exercise next and out-of-range pages").toBeGreaterThan(3);
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, `${LARGE_COMPARE}&page=2`);
  await waitForAppReady(page);
  await dismissOnboarding(page);

  await expect(page.locator(".compare-mapping-total")).toHaveText(
    `${format(mappings)} published mappings across ${format(sourceIds.length)} source records`,
  );
  const tableRows = page.locator(".compare-results-table tbody tr");
  await expect(tableRows).toHaveCount(100);
  const pagination = page.getByRole("navigation", { name: "Mapping result pages" });
  await expect(pagination).toContainText(`Showing source records 101–200 of ${format(sourceIds.length)}`);
  await expect(pagination).toContainText(`Page 2 of ${totalPages}`);
  await expect(pagination).toContainText(
    `Counts and exports cover all ${format(mappings)} published mappings matching the current filters and search.`,
  );

  const displayedSourceIds = () => tableRows.locator("td:first-child strong");
  await expect(displayedSourceIds()).toHaveText(sourceIds.slice(100, 200));
  await pagination.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=3/);
  await expect(tableRows).toHaveCount(100);
  await expect(displayedSourceIds()).toHaveText(sourceIds.slice(200, 300));

  await gotoApp(page, `${LARGE_COMPARE}&page=999`);
  await waitForAppReady(page);
  await expect(page.getByRole("alert")).toContainText(
    `That result page is not available. Showing page ${totalPages} of ${totalPages}.`,
  );
  await expect(tableRows).toHaveCount(lastPageIds.length);
  await expect(displayedSourceIds()).toHaveText(lastPageIds);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
});
