import { expect, test } from '@playwright/test';

/* global document, window */

import { dismissOnboarding, gotoApp, waitForAppReady } from './support.mjs';

test('PDISP presents only scoped, sourced facts at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page, '/#/resources/service-disa-pdisp');
  await waitForAppReady(page);
  await dismissOnboarding(page);

  await expect(page.getByRole('heading', { name: 'Private Data Internet Service Provider (PDISP)' })).toBeVisible();
  await expect(page.getByText('Control Atlas summary', { exact: true })).toBeVisible();
  await expect(page.getByText('Review and request DISA private data internet connectivity.', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'What it is' })).toHaveCount(0);
  await expect(page.getByText('Ordering and connection actions require authorized DoD access.', { exact: true })).toBeVisible();
  await expect(page.locator('#workspace').getByText(/CAC required|\bFree\b|not documented|not stated/i)).toHaveCount(0);
  await expect(page.getByText('Atlas context', { exact: true })).toHaveCount(0);
  // The panel carries Control Atlas's own dated verification record, which is
  // the one trust signal available for a service the reader cannot open. It
  // must still contain no unsourced or placeholder facts.
  const maintenance = page.locator('.resource-detail-maintenance');
  await expect(maintenance).toContainText('Last checked');
  await expect(maintenance.getByText(/not documented|not stated|unknown/i)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('sourced lifecycle and replacement history remain visible', async ({ page }) => {
  await gotoApp(page, '/#/resources/legacy-diacap-transition');
  await waitForAppReady(page);
  await dismissOnboarding(page);

  await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Replaced by', { exact: true })).toBeVisible();
  const replacementLink = page.getByRole('link', { name: /DoDI 8510\.01/ });
  await expect(replacementLink).toBeVisible();
  await replacementLink.click();
  await expect(page).toHaveURL(/#\/sources\?.*source=authority-dodi-8510-01/);
  const replacementInspector = page.locator('.sources-inspector-pane .source-inspector--inline');
  await expect(replacementInspector).toContainText('DoD Instruction 8510.01');
  // The official-source action resolves to the issuance itself, not the
  // directory of every DoD instruction. Sending a practitioner to an index and
  // making them find the document by hand is the work they came here to avoid.
  await expect(replacementInspector.getByRole('link', { name: /^Open official publication/ })).toHaveAttribute(
    'href',
    'https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodi/851001p.pdf',
  );
});

test('exact ATT&CK identifier search opens readable publisher text', async ({ page }) => {
  await gotoApp(page, '/#/search?q=T1098.004');
  await waitForAppReady(page);
  await dismissOnboarding(page);
  const exactResult = page.locator('[data-record-id="mitre-attack:T1098.004"]');
  await expect(exactResult).toBeVisible();
  await exactResult.locator('.workspace-result-row__link').click();
  await expect(page).toHaveURL(/#\/record\/mitre-attack\/T1098\.004/);
  await waitForAppReady(page);
  const publisherText = page.locator('.record-official-text');
  await expect(publisherText).toContainText('<user-home>/.ssh/authorized_keys');
  await expect(publisherText.locator('.publisher-inline-code').first()).toBeVisible();
  await expect(publisherText.locator('.publisher-citation').first()).toBeVisible();
  await expect(publisherText).not.toContainText(/\(Citation:/);
  await expect(publisherText).not.toContainText(/\[[^\]]+\]\(https?:\/\//);
});

test('DISA technical instructions contain no known mojibake', async ({ page }) => {
  await gotoApp(page, '/#/record/disa-stig/V-282727');
  await waitForAppReady(page);
  await dismissOnboarding(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('V-282727');
  await expect(page.locator('.record-official-text')).toContainText("awk -F: '($3>=1000)");
  await expect(page.locator('#workspace')).not.toContainText(/â€|Ã|Â/);
});

test('Source Register separates current, historical, mapping, and reproducible evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page, '/#/sources');
  await waitForAppReady(page);
  await dismissOnboarding(page);
  await expect(page.getByText(/This register includes \d+ publisher publications/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'FedRAMP Consolidated Rules for 2026' })).toBeVisible();
  await expect(page.getByRole('button', { name: /FedRAMP Rev\. 5/ })).toBeVisible();
  await gotoApp(page, '/#/sources?source=nist-iot-device-cybersecurity-requirement-catalogs');
  await waitForAppReady(page);
  const iotInspector = page.locator('.sources-inspector-pane .source-inspector--inline');
  await expect(iotInspector).toContainText('Control Atlas does not claim an independent catalog extraction');
  await expect(iotInspector).toContainText('Published crosswalks (2)');
  await expect(iotInspector.getByText(/Source files \(/)).toHaveCount(0);
  await gotoApp(page, '/#/sources?source=mitre-d3fend-ontology');
  await waitForAppReady(page);
  const d3fendInspector = page.locator('.sources-inspector-pane .source-inspector--inline');
  await expect(d3fendInspector).toContainText('Version 1.6.0');
  await expect(d3fendInspector).toContainText(/SHA-256 [a-f0-9]{12}…/);
  await expect(d3fendInspector).toContainText('committed ontology capture');
});
