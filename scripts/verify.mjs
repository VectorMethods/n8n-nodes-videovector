import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// Complete the sweep even when independent checks fail. Fixes happen after this report.
const checks = ['build', 'typecheck', 'lint', 'test', 'check:examples', 'scan'];
const results = [];
mkdirSync('.reports', { recursive: true });
for (const check of checks) {
  const start = Date.now();
  const result = spawnSync('npm', ['run', check], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(`.reports/${check.replaceAll(':', '-')}.log`, output);
  results.push({ check, status: result.status, durationMs: Date.now() - start });
  process.stdout.write(`${check}: ${result.status === 0 ? 'PASS' : 'FAIL'}\n`);
}
writeFileSync('.reports/verification.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exitCode = results.some((r) => r.status !== 0) ? 1 : 0;
