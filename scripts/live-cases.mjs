/** Runs independent scenarios through a real n8n instance; collects every failure. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, workflow, action, itemsNode, output, runCase } from './live-test.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const cases = [];
const credential = client.state.fixtureCredential;
const control = async (path, body) => {
  const response = await fetch(`http://localhost:5679/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fixture ${path} returned ${response.status}`);
  return response.json();
};
const native = (parameters, extras) => action('VideoVector', parameters, credential, extras);
const parameters = (resource, operation, values = {}) => ({ resource, operation, additionalFields: {}, fullResponse: false, idempotencyKey: '', ...values });

async function scenario(name, config, build, inspect) {
  try {
    await control('reset', { scenario: name, ...config });
    cases.push(await runCase(client, name, workflow(name, build()), inspect));
  } catch (error) { cases.push({ name, status: 'failed', phase: 'setup', error: error.message }); }
  process.stdout.write(`${name}: ${cases.at(-1).status}\n`);
}

await scenario('Per-item expressions and paired output', {}, () => [
  itemsNode([{ label: 'First' }, { label: 'Second' }]),
  native(parameters('index', 'create', { name: '={{$json.label}}' })),
], async (execution) => {
  assert.equal(execution.status, 'success');
  assert.equal(output(execution, 'VideoVector').length, 2);
  assert.equal(output(execution, 'VideoVector')[0].json.name, 'First');
  assert.equal(output(execution, 'VideoVector')[1].json.name, 'Second');
  assert.deepEqual(output(execution, 'VideoVector').map((item) => item.pairedItem), [{ item: 0 }, { item: 1 }]);
});

await scenario('Retry On Fail replays earlier successful items', {
  failures: [{ method: 'POST', path: '/api/v2/indexes', occurrence: 2, status: 503, body: { message: 'Injected temporary failure' } }],
}, () => [
  itemsNode([{ label: 'First' }, { label: 'Second' }]),
  native(parameters('index', 'create', { name: '={{$json.label}}' }), { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 }),
], async (execution) => {
  assert.equal(execution.status, 'success');
  assert.equal(output(execution, 'VideoVector').length, 2);
  const report = await control('report');
  const calls = report.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/indexes');
  assert.ok(calls.length >= 4, 'The entire node should run again');
  assert.equal(calls[0].idempotencyKey, calls[2].idempotencyKey, 'Earlier successful item must retain its key');
  assert.equal(calls[1].idempotencyKey, calls[3].idempotencyKey, 'Failed item must retain its key');
});

await scenario('Continue on error retains item pairing', {
  failures: [{ method: 'POST', path: '/api/v2/indexes', occurrence: 2, status: 403, body: { message: 'Insufficient scope', code: 'insufficient_scope' } }],
}, () => [itemsNode([{ label: 'First' }, { label: 'Second' }]),
  native(parameters('index', 'create', { name: '={{$json.label}}' }), { onError: 'continueRegularOutput' })], async (execution) => {
  assert.equal(execution.status, 'success');
  const items = output(execution, 'VideoVector');
  assert.equal(items.length, 2);
  assert.equal(items[1].pairedItem.item, 1);
  assert.match(items[1].json.error, /scope/i);
});

await scenario('Filtered and unfiltered pagination stay independent', {
  resultPages: { filtered: [[{ segment_id: 'f1' }]], unfiltered: [[{ segment_id: 'u1' }], [{ segment_id: 'u2' }]] },
}, () => [native(parameters('run', 'results', { runId: { mode: 'id', value: 'run-1' }, view: 'both', resultLevel: 'segment', returnAll: true, limit: 50 }))], async (execution) => {
  assert.equal(execution.status, 'success');
  assert.deepEqual(output(execution, 'VideoVector').map((item) => item.json.segment_id), ['f1', 'u1', 'u2']);
});

await scenario('Unavailable selected results are explicit', { selection: 'unavailable' }, () => [
  native(parameters('run', 'results', { runId: { mode: 'id', value: 'run-1' }, view: 'filtered', resultLevel: 'segment', returnAll: false, limit: 50 })),
], async (execution) => {
  assert.equal(execution.status, 'error');
  assert.match(execution.data.resultData.error.message, /unavailable/i);
});

await scenario('Search continuation does not repeat billed search', {
  searchPages: [[{ segment_id: 's1' }], [{ segment_id: 's2' }]],
}, () => [native(parameters('search', 'semantic', { searchScope: 'playground', query: 'person', resultLevel: 'segment', returnAll: true, limit: 50, cursor: '' }))], async (execution) => {
  assert.equal(execution.status, 'success');
  assert.equal(output(execution, 'VideoVector').length, 2);
  const report = await control('report');
  assert.equal(report.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/workflow/search').length, 1);
});

for (const status of ['completed', 'completed_with_failures', 'failed', 'cancelled']) {
  await scenario(`Run status preserves ${status}`, { statusSequence: [status] }, () => [
    native(parameters('run', 'get', { runId: { mode: 'id', value: 'run-1' } })),
  ], async (execution) => {
    assert.equal(execution.status, 'success');
    assert.equal(output(execution, 'VideoVector')[0].json.status, status);
  });
}

if (client.state.liveCredential) {
  for (const [resource, operation] of [['index', 'list'], ['prompt', 'list'], ['import', 'list'], ['export', 'list']]) {
    const name = `Deployed API ${resource}.${operation}`;
    cases.push(await runCase(client, name, workflow(name, [action('VideoVector', parameters(resource, operation, { limit: 5, fullResponse: true }), client.state.liveCredential)])));
    process.stdout.write(`${name}: ${cases.at(-1).status}\n`);
  }
}
await mkdir(resolve(packageRoot, '.reports'), { recursive: true });
await writeFile(resolve(packageRoot, '.reports/live-discovery.json'), JSON.stringify({ at: new Date().toISOString(), cases }, null, 2));
process.stdout.write(JSON.stringify({ passed: cases.filter((c) => c.status === 'passed').length, failed: cases.filter((c) => c.status === 'failed').length }) + '\n');
process.exitCode = cases.some((c) => c.status === 'failed') ? 1 : 0;
