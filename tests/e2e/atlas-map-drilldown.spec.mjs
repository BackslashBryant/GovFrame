import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  attachPageDiagnostics,
  dismissOnboarding,
  gotoApp,
  waitForAppReady,
} from "./support.mjs";

test.beforeEach(async ({ page }) => {
  attachPageDiagnostics(page);
});

function map(page) {
  return page.getByTestId("atlas-area-map");
}

/* The publisher-native columns are still reached by URL, below the map. */
function atlas(page) {
  return page.getByTestId("atlas-map");
}

function level(page, key) {
  return atlas(page).locator(`.atlas-decomp__column[data-column="${key}"]`);
}

function panel(page) {
  return page.getByTestId("atlas-detail");
}

/**
 * Opens a cell by name. Every cell is a real button whose accessible name is
 * its label and its count, so a prefix match is enough at any depth.
 */
async function open(page, label) {
  const cell = map(page).getByRole("button", { name: new RegExp(`^${label}`) }).first();
  await expect(cell).toBeVisible();
  await cell.click();
}

test("the Atlas landing groups by publisher and NIST opens to its publications", async ({
  page,
}) => {
  await gotoApp(page, "/#/atlas?atlasLanding=publishers");
  await waitForAppReady(page);
  await dismissOnboarding(page);

  // Eight publishers, sized by how many publications each issues. The three
  // authority landmarks are named beneath the map: obligations are not
  // publishers, and nobody crosswalks to them.
  await expect(map(page).locator("button.atlas-area__cell")).toHaveCount(8);
  const labels = await map(page).locator("button.atlas-area__cell").allTextContents();
  for (const ecosystem of ["NIST", "DISA", "MITRE", "FedRAMP", "DoD CIO"]) {
    expect(labels.join(" "), `${ecosystem} cell`).toContain(ecosystem);
  }
  await expect(page.locator(".atlas-mapcol__aside").first()).toContainText("Statutes");

  await open(page, "NIST");
  await expect(page).toHaveURL(/atlasLensFamily=ecosystem(?::|%3A)nist/);
  await expect(map(page).getByRole("button", { name: /^800-53 / }).first()).toBeVisible();
});

test("a drilled branch survives refresh and the trail steps back one level", async ({
  page,
}) => {
  await gotoApp(page, "/#/atlas?atlasLanding=publishers");
  await waitForAppReady(page);
  await dismissOnboarding(page);

  await open(page, "NIST");
  await open(page, "800-53 ");
  await expect(page).toHaveURL(/atlasFramework=nist-800-53/);
  await expect(panel(page).getByRole("heading", { level: 2 })).toContainText("800-53");

  await page.reload();
  await waitForAppReady(page);
  // Onboarding comes back with the fresh document and would swallow the click.
  await dismissOnboarding(page);
  await expect(page).toHaveURL(/atlasFramework=nist-800-53/);
  await expect(map(page).locator(".atlas-area__cell").first()).toBeVisible();

  // One step back is the group, not the top of the route.
  await page
    .getByRole("navigation", { name: "Map depth" })
    .getByRole("button", { name: /^NIST/ })
    .click();
  await expect(page).not.toHaveURL(/atlasFramework=/);
  await expect(page).toHaveURL(/atlasLensFamily=ecosystem(?::|%3A)nist/);
});

test("a section shows its own records and only its own", async ({ page }) => {
  const catalog = JSON.parse(readFileSync(new URL("../../data/generated/catalog-records/nist-800-53.json", import.meta.url), "utf8"));
  const expectedIds = catalog.catalog_records.nodes
    .map((node) => node.metadata?.item_id)
    .filter((id) => /^AC-\d/.test(id || "") || id === "FAMILY-AC")
    .map((id) => id === "FAMILY-AC" ? "AC" : id)
    .sort();
  expect(expectedIds.length).toBeGreaterThan(1);
  await gotoApp(page, "/#/atlas?atlasLanding=publishers");
  await waitForAppReady(page);
  await dismissOnboarding(page);

  await open(page, "NIST");
  await open(page, "800-53 ");
  await open(page, "Access Control");
  await expect(page).toHaveURL(/atlasFamily=group(?::|%3A)nist-800-53(?::|%3A)0/);

  // The drawing stops where every child is one record; the panel lists them.
  await expect(panel(page).getByRole("heading", { level: 2 })).toContainText("Access Control");
  const records = panel(page).locator(".atlas-detail__links button");
  await expect(records).toHaveCount(expectedIds.length);
  // AtlasGraphProjection uses recordDisplayTitle: the publisher identifier
  // precedes " — ". Enhancement IDs stay dotted (AC-2.1), not parenthesized.
  const actualIds = (await records.locator(".atlas-detail__link-name").allTextContents())
    .map((label) => label.trim().split(" — ")[0])
    .sort();
  expect(actualIds, "Access Control must include its entire family and no other family").toEqual(expectedIds);
  await expect(records.first()).toContainText("AC-1");

  await records.first().click();
  await expect(page).toHaveURL(/nist-800-53:AC-1/);
});

test("structural records use publisher-native labels without changing their route targets", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const cases = [
    {
      route: "/#/atlas?atlasLimb=ecosystem%3Anist&atlasFramework=csf-2&atlasFamily=group%3Acsf-2%3A9",
      label: "PR.AA — Identity Management, Authentication, and Access Control",
      target: /#\/atlas\/csf-2:CATEGORY-PR\.AA\?/,
    },
    {
      route: "/#/atlas?atlasLimb=ecosystem%3Amitre&atlasFramework=mitre-attack&atlasFamily=group%3Amitre-attack%3A8",
      label: "TA0001 — Initial Access",
      target: /#\/atlas\/mitre-attack:TACTIC-TA0001\?/,
    },
    {
      route: "/#/atlas?atlasLimb=ecosystem%3Anist&atlasFramework=nist-800-53&atlasFamily=group%3Anist-800-53%3A0",
      label: "AC — Access Control",
      target: /#\/atlas\/nist-800-53:FAMILY-AC\?/,
    },
  ];

  for (const entry of cases) {
    await gotoApp(page, entry.route);
    await waitForAppReady(page);
    await dismissOnboarding(page);
    const records = level(page, "record");
    await expect(records.locator(".atlas-decomp__label").first()).toBeVisible();
    const label = records
      .locator(".atlas-decomp__label")
      .getByText(entry.label, { exact: true });
    const showMore = records.getByRole("button", { name: /Show \d+ more/ });
    if (!(await label.count()) && (await showMore.count())) {
      await showMore.click();
    }
    await expect(label).toBeVisible();
    await label.locator("xpath=ancestor::button").click();
    await expect(page).toHaveURL(entry.target);
  }
});

test("guided structural identity is identical before and after optional catalog hydration", async ({
  page,
}) => {
  let releaseRecords = () => {};
  const recordsGate = new Promise((resolve) => {
    releaseRecords = () => resolve();
  });
  await page.route(
    "**/data/generated/catalog-records/mitre-attack.json*",
    async (route) => {
      await recordsGate;
      await route.continue();
    },
  );

  await gotoApp(
    page,
    "/#/atlas?atlasAxis=framework&atlasLimb=atlas%3ALIMB-THREAT&atlasFramework=mitre-attack&relationshipView=path",
  );
  await waitForAppReady(page, { allowPartial: true });
  await dismissOnboarding(page);
  const explorer = page.locator("[data-atlas-structural-explorer]:visible");
  const row = explorer.getByRole("button", {
    name: "Open TA0001 — Initial Access",
    exact: true,
  });
  await expect(row).toBeVisible();
  const label = row.locator("strong");
  const initialLabel = await label.innerText();
  expect(initialLabel).toBe("TA0001 — Initial Access");

  releaseRecords();
  await waitForAppReady(page);
  await expect(label).toHaveText(initialLabel);
  await row.click();
  await expect(page).toHaveURL(/#\/atlas\/mitre-attack:TACTIC-TA0001\?/);
});

test("CMMC reaches its three publisher-native levels through the map", async ({ page }) => {
  await gotoApp(page, "/#/atlas?atlasLanding=publishers");
  await waitForAppReady(page);
  await dismissOnboarding(page);

  // "DoD " alone also prefixes "DoD CIO", so this matched whichever of the two
  // the map happened to lay out first. The em dash is the boundary between a
  // cell's name and its count, which makes the match exact.
  await open(page, "DoD —");
  await open(page, "CMMC");
  await open(page, "CMMC 2.0 Levels");

  // Three levels, and they are the records themselves rather than another
  // drawing: at this depth every child holds exactly one record, so area would
  // say nothing.
  const records = panel(page).locator(".atlas-detail__links button");
  await expect(records).toHaveCount(3);
  for (const levelNumber of [1, 2, 3]) {
    await expect(
      panel(page).getByRole("button", { name: new RegExp(`CMMC Level ${levelNumber}`) }),
    ).toBeVisible();
  }
});
