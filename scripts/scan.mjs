/** Scan both reviewed sources and the exact files npm installs, using n8n's scanner. */
import { analyzePackage, SOURCE_FILE_PATTERNS } from '@n8n/scan-community-package/scanner/scanner.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'videovector-n8n-scan-'));
const results = [];
try {
  results.push({ target: 'source', ...await analyzePackage(root, SOURCE_FILE_PATTERNS) });
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const [{ filename }] = JSON.parse(pack.stdout);
  const unpack = spawnSync('tar', ['-xzf', join(directory, filename), '-C', directory], { encoding: 'utf8' });
  if (unpack.status !== 0) throw new Error(`Package extraction failed: ${unpack.stderr}`);
  results.push({ target: 'npm artifact', ...await analyzePackage(join(directory, 'package')) });
} catch (error) {
  results.push({ target: 'npm artifact', passed: false, message: error.message });
} finally {
  await rm(directory, { recursive: true, force: true });
}
await mkdir(join(root, '.reports'), { recursive: true });
await writeFile(join(root, '.reports/scan-results.json'), JSON.stringify(results, null, 2));
for (const result of results) {
  console.log(`${result.target}: ${result.passed ? 'PASS' : 'FAIL'}`);
  if (!result.passed) console.log(result.details || result.message);
}
process.exitCode = results.some((result) => !result.passed) ? 1 : 0;
