import { expect, test } from "@playwright/test";

import { dismissOnboarding, gotoApp, waitForAppReady } from "./support.mjs";

async function open(page, route) {
  await page.goto(route);
  await waitForAppReady(page);
  await dismissOnboarding(page);
}

test("V1 workflow 01 — find a known identifier", async ({ page }) => {
  await open(page, "/#/");
  await page.getByRole("button", { name: "Open search" }).click();
  const search = page.getByRole("dialog", { name: "Search Control Atlas" })
    .getByRole("searchbox", { name: "Search Control Atlas" });
  await search.fill("AC-2");
  await search.press("Enter");
  await expect(page).toHaveURL(/#\/library\?q=AC-2/);
  await expect(page.locator('[data-record-id="nist-800-53:AC-2"]')).toBeVisible();
});

test("V1 workflow 02 — search a topic without an identifier", async ({ page }) => {
  await open(page, "/#/search?q=account%20management");
  await expect(page.getByLabel("Filter results by ID, title, or topic")).toHaveValue(
    "account management",
  );
  await expect(page.locator("#library-results .workspace-result-row").first()).toBeVisible();
});

test("V1 workflow 03 — distinguish exact, ambiguous, and honest zero results", async ({
  page,
}) => {
  await open(page, "/#/search?q=AC-2");
  await expect(page.locator('[data-record-id="nist-800-53:AC-2"]')).toBeVisible();

  await open(page, "/#/search?q=account");
  await expect
    .poll(() => page.locator("#library-results .workspace-result-row").count())
    .toBeGreaterThan(1);

  await open(page, "/#/search?q=qzxv9417nohit");
  await expect(
    page.getByRole("heading", { name: "No records found." }),
  ).toBeVisible();
});

test("V1 workflow 04 — verify official record identity and source", async ({ page }) => {
  await open(page, "/#/record/nist-800-53/AC-2");
  await expect(
    page.getByRole("heading", { name: "NIST AC-2", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".record-official-name")).toHaveText("Account Management");
  await expect(page.getByRole("heading", { name: "Control Statement", exact: true })).toBeVisible();
  const facts = page.locator(".record-source-facts");
  await expect(facts).toContainText("Publisher");
  await expect(facts).toContainText("NIST");
  await expect(facts).toContainText("Publication");
  await expect(facts).toContainText(/Revision 5|Rev\. 5/);
  // Retrieval/currentness provenance now lives on the Sources page; the record
  // sidebar stays user-first (who published it, which publication, how current).
  await expect(facts).toContainText("Source last checked");
  await expect(facts).not.toContainText("Publication currentness review");

  await open(page, "/#/record/nist-mobile-threats/CEL-1");
  const retrievedOnlyFacts = page.locator(".record-source-facts");
  await expect(retrievedOnlyFacts).toContainText("Publisher");
  await expect(retrievedOnlyFacts).not.toContainText("Publication currentness review");
});

test("V1 workflow 05 — follow a record and return without losing search state", async ({
  page,
}) => {
  await open(page, "/#/search?q=AC-2");
  await page.locator('[data-record-id="nist-800-53:AC-2"] .workspace-result-row__link').click();
  await expect(page).toHaveURL(/#\/record\/nist-800-53\/AC-2/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/library\?q=AC-2/);
  await expect(page.getByLabel("Filter results by ID, title, or topic")).toHaveValue("AC-2");
});

test("V1 workflow 06 — explore one record through Connections, Hierarchy, and the full list", async ({
  page,
}) => {
  await open(page, "/#/atlas?node=nist-800-53%3AAC-2&relationshipView=path");

  // The focused record remains the workspace while the hierarchy panel is open.
  await expect(page.getByRole("region", { name: "Focused Atlas record" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connections", level: 2 })).toBeVisible();
  // Orientation stays on screen without opening anything.
  await expect(page.getByRole("navigation", { name: "Where this sits" })).toContainText(
    "SP 800-53 Rev. 5",
  );

  // The explicit Path deep link opens publisher hierarchy with real structural substance.
  await expect(page).toHaveURL(/relationshipView=path/);
  const hierarchy = page.locator("#atlas-hierarchy-panel");
  await expect(hierarchy).toContainText("Control Atlas structure");
  await expect(hierarchy).toContainText("Publisher hierarchy");
  await expect(hierarchy).toContainText("Decomposes into");
  await expect(
    hierarchy.getByRole("link", { name: "AC-2.1", exact: true }),
  ).toBeVisible();

  // The complete list supports the Atlas map instead of replacing it.
  await page.getByRole("button", { name: "View all", exact: true }).click();
  await expect(page).toHaveURL(/relationshipView=list/);
  await expect(
    page.getByRole("table", { name: "Relationship table" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Focused Atlas record" })).toBeVisible();
});

test("V1 workflow 07 — compare with a shareable explicit configuration", async ({
  page,
}) => {
  await open(
    page,
    "/#/compare/relationships?intent=frameworks&source=nist-800-53&target=csf-2",
  );
  await expect(page).toHaveURL(/#\/compare\/relationships\?/);
  await expect(page).toHaveURL(/source=nist-800-53/);
  await expect(page).toHaveURL(/target=csf-2/);
  await expect(
    page.getByRole("tab", { name: "Frameworks" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Choose a framework to compare with",
    }),
  ).toBeVisible();
  await expect(page.getByText("Crosswalk source", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Show published mappings" }).click();
  await expect(page).toHaveURL(/compareRun=true/);
  await expect(page.locator(".compare-crosswalk-source")).toContainText(
    "NIST CSF 2.0",
    { timeout: 30_000 },
  );
  await expect(
    page.getByRole("table", { name: "Published crosswalk mappings" }),
  ).toBeVisible({ timeout: 30_000 });

  await page.goBack();
  await waitForAppReady(page);
  await expect(page.locator("#compare-results")).toHaveCount(0);
  // The target field is a searchable publication picker like step 1, so it
  // shows the publication's name rather than its catalog id.
  await expect(page.getByLabel("Target publication")).toHaveValue("NIST CSF 2.0");
  await page.goForward();
  await waitForAppReady(page);
  await expect(
    page.getByRole("table", { name: "Published crosswalk mappings" }),
  ).toBeVisible({ timeout: 30_000 });
});

test("V1 workflow 08 — inspect a source and how it is used", async ({ page }) => {
  await open(page, "/#/sources?q=NIST");
  await expect(page.getByRole("table", { name: "Control Atlas publication register" })).toBeVisible();
  await expect(page.getByLabel("Search publications")).toHaveValue("NIST");
  await expect(page.locator(".source-register-row").first()).toBeVisible();

  await open(
    page,
    "/#/sources?source=nist-iot-device-cybersecurity-requirement-catalogs",
  );
  const iotDetail = page.getByRole("region", { name: "Source status summary" });
  await expect(iotDetail).toContainText("Version / current through");
  await expect(iotDetail).toContainText("Spring 2021");
  await expect(iotDetail).toContainText("Source freshness");
  // No verification check is recorded for this source. The register reports the
  // retrieval date and labels it as retrieval, so the cell is neither blank nor
  // a check date the evidence does not support.
  await expect(iotDetail).toContainText("Retrieved");
  await expect(iotDetail).not.toContainText("undefined");

  await open(page, "/#/sources?source=nist-800-53");
  const checkedDetail = page.getByRole("region", { name: "Source status summary" });
  await expect(checkedDetail).toContainText("Source freshness");
  await expect(checkedDetail).toContainText(/Checked\s+Jul 28, 2026/);

  await open(page, "/#/sources?source=nist-800-53a-assessment-procedures");
  const assessmentDetail = page.getByRole("region", { name: "Source status summary" });
  await expect(assessmentDetail).toContainText("Revision 5, Release 5.2.0");
  // Shape, not a frozen value: this date advances with every source refresh.
  await expect(assessmentDetail).toContainText(/\w{3} \d{1,2}, \d{4}/);
  await expect(assessmentDetail).toContainText("1,014 normalized records");
});

test("source detail routes use specific identity at every governed width", async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  const sources = [
    { id: "nist-800-53", name: "NIST SP 800-53 Rev. 5" },
    {
      id: "nist-iot-device-cybersecurity-requirement-catalogs",
      name: "NIST IoT Device Cybersecurity Requirement Catalogs",
    },
  ];
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }

  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
    for (const source of sources) {
      await gotoApp(page, `/#/sources?source=${source.id}`);
      await waitForAppReady(page);
      await dismissOnboarding(page);
      const inspector = page.locator(".source-inspector");
      await expect(inspector.getByRole("heading", { name: source.name, level: 2 })).toBeVisible();
      await expect(page).toHaveTitle(`${source.name} — Control Atlas`);
      const technicalDetails = inspector.locator("details.source-inspector-provenance");
      if ((await technicalDetails.getAttribute("open")) === null) {
        await technicalDetails.locator("summary").click();
      }
      await expect(technicalDetails).toHaveAttribute("open", "");
      const copy = technicalDetails.getByRole("button", { name: /^Copy source ID / });
      await expect(copy).toBeVisible();
      expect(await page.evaluate(() =>
        globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
      )).toBeLessThanOrEqual(1);
    }
  }

  await gotoApp(page, `/#/sources?source=${sources[0].id}`);
  await waitForAppReady(page);
  await gotoApp(page, `/#/sources?source=${sources[1].id}`);
  await waitForAppReady(page);
  await page.goBack();
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: sources[0].name, level: 2 })).toBeVisible();
  await expect(page).toHaveTitle(`${sources[0].name} — Control Atlas`);
  await page.goForward();
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: sources[1].name, level: 2 })).toBeVisible();
  await expect(page).toHaveTitle(`${sources[1].name} — Control Atlas`);

  const inspector = page.locator(".source-inspector");
  const technicalDetails = inspector.locator("details.source-inspector-provenance");
  if ((await technicalDetails.getAttribute("open")) === null) {
    await technicalDetails.locator("summary").click();
  }
  const copy = technicalDetails.getByRole("button", { name: `Copy source ID ${sources[1].id}` });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sources[1].id);
  }
});

test("a supplemental source material resolves to its parent publication's identity", async ({
  page,
}) => {
  // cyber-mil-stig-downloads and cyber-mil-stig-compilations are supplemental
  // materials attached to the disa-stig-library publication identity
  // (Phase 2 T2.2 consolidation), not standalone publication landmarks —
  // deep-linking to either now opens the parent publication's inspector
  // (Phase 7 T7.1: one publication register, one scoped inspector) rather
  // than a dedicated per-material page.
  for (const materialId of ["cyber-mil-stig-downloads", "cyber-mil-stig-compilations"]) {
    await open(page, `/#/sources?source=${materialId}`);
    await expect(
      page.getByRole("heading", { name: "DISA Public STIG Library", level: 2 }),
    ).toBeVisible();
    const inspector = page.locator(".source-inspector");
    const technicalDetails = inspector.locator("details.source-inspector-provenance");
    if ((await technicalDetails.getAttribute("open")) === null) {
      await technicalDetails.locator("summary").click();
    }
    await expect(technicalDetails.getByRole("button", { name: "Copy source ID disa-stig-library" })).toBeVisible();
  }
});

test("source detail has one return action and preserves the Sources workspace", async ({ page }) => {
  test.setTimeout(120_000);
  const detailPath = "/#/sources?q=DISA&source=cyber-mil-stig-downloads&publisher=DISA";

  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
    await gotoApp(page, detailPath);
    await waitForAppReady(page);
    await dismissOnboarding(page);

    await expect(page.locator(".sources-page .page-header")).toBeVisible();
    expect(
      await page.evaluate(() =>
        globalThis.document.documentElement.scrollWidth -
        globalThis.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const dialog = page.getByRole("dialog");
    if (width < 1200) {
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close inspector" }).click();
    } else {
      const closeDetails = page.getByRole("button", { name: "Close publication details" });
      await expect(closeDetails).toBeVisible();
      await closeDetails.click();
    }
    await expect.poll(() =>
      page.evaluate(() =>
        new URLSearchParams(globalThis.location.hash.split("?")[1]).has("source"),
      ),
    ).toBe(false);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
    await expect(page.locator("#source-search")).toHaveValue("DISA");
    await expect(page.getByLabel("Publisher", { exact: true })).toHaveValue("DISA");
    expect(
      await page.evaluate(() =>
        new URLSearchParams(globalThis.location.hash.split("?")[1]).has("source"),
      ),
    ).toBe(false);

    await page.goBack();
    await waitForAppReady(page);
    await expect(
      page.getByRole("heading", { name: "DISA Public STIG Library", level: 2 }),
    ).toBeVisible();

    await page.goForward();
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
    await expect(page.locator("#source-search")).toHaveValue("DISA");
  }
});

test("unknown Source detail links fail closed and preserve recovery state", async ({ page }) => {
  test.setTimeout(120_000);
  const sourceId = `not-a-real-source-${"x".repeat(140)}`;
  const detailPath =
    `/#/sources?q=DISA&source=${encodeURIComponent(sourceId)}&publisher=DISA`;

  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
    await gotoApp(page, detailPath);
    await waitForAppReady(page);
    await dismissOnboarding(page);
    await page.reload();
    await waitForAppReady(page);

    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
    await expect(page).toHaveTitle("Source not found — Control Atlas");
    await expect(
      page.getByText(
        "This link points to a publication that is not in the current public register.",
      ),
    ).toBeVisible();
    await expect(page.locator(".source-not-found-banner")).not.toContainText(sourceId);
    await expect(page.locator(".source-not-found-banner code")).toHaveCount(0);
    // The register stays visible so the user can search/browse while seeing
    // the not-found message — it does not empty out or disappear.
    await expect(page.getByRole("table", { name: "Control Atlas publication register" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Source register layers" })).toHaveCount(0);

    const returnButton = page.getByRole("button", { name: "Return to the publication register" });
    await expect(returnButton).toHaveCount(1);
    const target = await returnButton.boundingBox();
    expect(target).not.toBeNull();
    if (width <= 390) expect(target.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() =>
        globalThis.document.documentElement.scrollWidth -
        globalThis.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await returnButton.click();
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
    await expect(page.locator("#source-search")).toHaveValue("DISA");
    await expect(page.getByLabel("Publisher", { exact: true })).toHaveValue("DISA");

    await page.goBack();
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
    await expect(page.locator(".source-not-found-banner")).toContainText(
      "This link points to a publication that is not in the current public register.",
    );
    await expect(page.locator(".source-not-found-banner")).not.toContainText(sourceId);
    await page.goForward();
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
  }
});

test("source and record provenance stay distinct at every governed width", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
    await open(
      page,
      "/#/sources?source=nist-iot-device-cybersecurity-requirement-catalogs",
    );
    const facts = page.getByRole("region", { name: "Source status summary" });
    await expect(facts).toContainText("Version / current throughSpring 2021");
    await expect(facts).toContainText("Source freshnessRetrieved");
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
      `${width}px document overflow`,
    ).toBe(0);

    // The record sidebar is user-first: publisher, publication, and how current
    // it is. Detailed field-by-field provenance stays on the Sources page
    // (asserted above), not repeated on every record.
    await open(page, "/#/record/nist-800-53/AC-2");
    const recordFacts = page.locator(".record-source-facts");
    await expect(recordFacts).toContainText("Publisher");
    await expect(recordFacts).toContainText(/Source last checked|Source retrieved/);
    await expect(recordFacts).not.toContainText("Publication currentness review");
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
      `${width}px record document overflow`,
    ).toBe(0);
  }
});

test("source review presents lifecycle and version disposition honestly", async ({
  page,
}) => {
  await open(page, "/#/sources?source=nist-800-171-rev2");
  await expect(page.getByRole("region", { name: "Source status summary" })).toContainText(
    "Version / current through2021-01",
  );
  await expect(page.getByRole("region", { name: "Source status summary" })).toContainText(
    // nist-800-53a-assessment-procedures is auto_synced, so its checked date
    // advances with every refresh. Assert the rendered shape, not a frozen day.
    /Source freshnessChecked\s+\w{3} \d{1,2}, \d{4}/,
  );

  await open(page, "/#/record/nist-800-171-rev2/3.1.1");
  await expect(page.locator(".record-source-facts")).toContainText("Source last checked");

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1024 });
    await open(
      page,
      "/#/sources?source=nist-800-53a-assessment-procedures",
    );
    const facts = page.getByRole("region", { name: "Source status summary" });
    await expect(facts).toContainText("Revision 5, Release 5.2.0");
    await expect(facts).toContainText(/\w{3} \d{1,2}, \d{4}/);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
      `${width}px multi-review document overflow`,
    ).toBe(0);
  }
});

test("V1 workflow 09 — find an external tool or starter resource", async ({ page }) => {
  await open(page, "/#/resources?q=OSCAL");
  await expect(page).toHaveURL(/#\/resources\?q=OSCAL/);
  await expect(page.getByRole("heading", { name: "Resources", level: 1 })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Find resources" })).toHaveValue("OSCAL");
  await expect(page.locator(".workspace-result-row--resource").first()).toBeVisible();
});

test("V1 workflow 10 — recover from invalid settings, missing records, and empty filters", async ({
  page,
}) => {
  await open(page, "/#/explore?relationshipView=unsupported&bogus=value");
  await expect(page.locator(".route-recovery")).toContainText("unsupported link settings");
  await open(page, "/#/record/nist-800-53/NOT-A-REAL-CONTROL");
  await expect(page.getByRole("heading", { name: "Record not found" })).toBeVisible();
});

test("V1 workflow 11 — refresh and browser history preserve valid URL state", async ({
  page,
}) => {
  await open(page, "/#/library?q=AC-2&kind=requirements&sort=identifier");
  const kindFilter = page.getByRole("group", { name: "Content kind" }).getByRole("checkbox", { name: /Requirements/ });
  const sort = page.getByLabel("Sort Library results");
  await expect(kindFilter).toBeChecked();
  await expect(sort).toHaveValue("identifier");
  await page.reload();
  await waitForAppReady(page);
  await expect(kindFilter).toBeChecked();
  await expect(sort).toHaveValue("identifier");
  await sort.selectOption("title");
  await expect(page).toHaveURL(/sort=title/);
  await page.goBack();
  await expect(kindFilter).toBeChecked();
  await expect(sort).toHaveValue("identifier");
});

test("V1 workflow 12 — defining work reflows at mobile, tablet, and desktop widths", async ({
  page,
}) => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await open(page, "/#/");
    await expect(page.locator(".site-header:visible .brand-name").last()).toBeVisible();
    await expect(page.getByRole("search")).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      client: globalThis.document.documentElement.clientWidth,
      scroll: globalThis.document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  }
});
