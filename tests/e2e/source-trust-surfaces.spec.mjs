import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { dismissOnboarding, gotoApp, waitForAppReady } from "./support.mjs";

async function open(page, path) {
  await gotoApp(page, path);
  await waitForAppReady(page);
  await dismissOnboarding(page);
}

test("source register, inspector, catalog, and record use one official publication identity", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/#/sources?q=DISA%20STIG");

  const publication = page.getByRole("button", { name: "DISA Public STIG Library" });
  await expect(publication).toBeVisible();
  await publication.click();
  await expect(page.getByRole("heading", { name: "DISA Public STIG Library", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Page context" })).toHaveCount(0);

  await open(page, "/#/catalog/disa-stig");
  await expect(page.getByRole("heading", { name: "DISA Public STIG Library", level: 1 })).toBeVisible();
  const summary = page.locator(".catalog-facts");
  await expect(summary).toContainText("Status Active");
  // A rendered "last checked" date moves on every refresh by design, so assert
  // that a real date is rendered rather than freezing one -- the same shape-not-
  // value idiom this suite already uses for SHA-256 digests. Pinning the literal
  // made a successful refresh fail the browser contracts.
  await expect(summary).toContainText(/Source last checked \w{3} \d{1,2}, \d{4}/);
  await expect(page.getByRole("link", { name: "Review source details" })).toBeVisible();

  await open(page, "/#/record/disa-stig/V-256609");
  await expect(page.locator("[data-record-source-identity]")).toContainText("DISA Public STIG Library");
  const facts = page.locator(".record-template-sidebar .record-source-facts");
  await expect(facts).toContainText("PublicationDISA Public STIG Library · V3R7");
  await expect(facts).toContainText("StatusActive");
  await expect(facts).toContainText(/Source last checked\w{3} \d{1,2}, \d{4}/);
});

test("NIST publication headings and OSCAL mapping evidence keep distinct identities", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  for (const [route, heading] of [
    ["/#/catalog/nist-800-171-rev2", "SP 800-171 Rev. 2"],
    ["/#/catalog/nist-800-172", "SP 800-172 Rev. 3"],
  ]) {
    await open(page, route);
    await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
  }

  await open(page, "/#/sources?q=SP%20800-171%20Rev.%203");
  const publication = page.getByRole("button", { name: "SP 800-171 Rev. 3" });
  await expect(publication).toBeVisible();
  await publication.click();
  const crosswalks = page.locator("details.source-inspector-section").filter({
    hasText: "Published crosswalks",
  });
  await expect(crosswalks).toContainText("SP 800-171 Rev. 3 OSCAL Artifact");
  await expect(crosswalks).not.toContainText("SP 800-53 Rev. 5");
});

test("missing source fields and zero results are explicit instead of blank or contradictory", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/#/sources?q=DoD%20AI%20Assurance");
  const row = page.locator(".source-register-row").first();
  await expect(row.locator(".source-col-version")).toHaveText("Not recorded");
  await row.getByRole("button", { name: "CDAO AI Assurance Toolkit" }).click();
  await expect(page.getByRole("region", { name: "Source status summary" })).toContainText(
    "Version / current throughNot recorded",
  );

  await open(page, "/#/sources?q=zzzz-no-publication");
  await expect(page.locator(".calibration-rail")).toContainText("0 publications");
  await expect(page.getByRole("button", { name: "Clear publication filters" })).toHaveCount(1);
});

test("V-256609 preserves publisher procedures, commands, paths, and mobile reading order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/#/record/disa-stig/V-256609");

  const official = page.locator('[data-record-section="official-text"]');
  await expect(official.locator(":scope > section > h2")).toHaveText(["Discussion", "Check", "Fix"]);
  await expect(official.locator('[data-source-field="check_text"] [data-source-code-snippet]')).toContainText(
    "rpm -V VMware-Postgres",
  );
  const fix = official.locator('[data-source-field="fix_text"]');
  await expect(fix.locator(".source-procedure-list")).toHaveCount(2);
  await expect(fix.locator("[data-source-code-snippet]")).toHaveCount(2);
  await expect(fix).toContainText("/etc/vmware-syslog/vmware-services-vmware-vpostgres.conf");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("representative publisher-native records expose official identity and source facts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    "/#/record/nist-800-53/AC-2",
    "/#/record/disa-cci/CCI-000366",
    "/#/record/mitre-attack/T1195.002",
    "/#/record/mitre-d3fend/D3-AA",
    "/#/record/nist-800-171-rev2/3.1.1",
    "/#/record/nist-mobile-threats/CEL-10",
  ];

  for (const route of routes) {
    await open(page, route);
    await expect(page.locator("[data-record-source-error]"), route).toHaveCount(0);
    await expect(page.locator("[data-record-source-identity]"), route).toBeVisible();
    await expect(page.locator(".record-template-sidebar .record-source-facts"), route).toContainText("Publication");
    await expect(page.getByRole("link", { name: "View source details" }), route).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      route,
    ).toBeLessThanOrEqual(1);
  }
});

test("selected source trust controls have no serious or critical WCAG violations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/#/sources?source=disa-stig-library");

  const results = await new AxeBuilder({ page })
    .include("#workspace")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact || ""),
  );
  expect(blocking).toEqual([]);
});
