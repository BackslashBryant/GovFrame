import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function productionLighthousePlan(target) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Production Lighthouse requires a public HTTPS URL');
  // Fixed warmups address host/Chrome startup variance. Every measured run is
  // retained; failure never triggers score-based retries or sample selection.
  return Array.from({ length: 5 }, (_, index) => ({
    warmup: index < 2,
    args: ['node_modules/lighthouse/cli/index.js', url.href, '--quiet',
      '--chrome-flags=--headless --no-sandbox', '--form-factor=mobile',
      '--screenEmulation.mobile', '--save-assets', '--output=json',
      `--output-path=artifacts/deployed-lighthouse/${index < 2 ? 'warmups/' : ''}run-${index + 1}.report.json`],
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  mkdirSync('artifacts/deployed-lighthouse/warmups', { recursive: true });
  for (const [index, run] of productionLighthousePlan(process.env.TARGET_URL).entries()) {
    console.log(`Lighthouse ${run.warmup ? 'host warmup' : 'measured cold-browser run'} ${index + 1}/5`);
    const result = spawnSync(process.execPath, run.args, { stdio: 'inherit', timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Lighthouse collection failed: ${result.status}`);
  }
}
