/** Real n8n retry/loop acceptance against controlled API responses. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, workflow, action, itemsNode, output } from './live-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const cases = [];
const control = async (path, body) => {
 const response = await fetch(`http://localhost:5679/__control/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 assert(response.ok, `Fixture control ${response.status}`); return response.json();
};
const native = (parameters, extras = {}) => action('VideoVector', parameters, client.state.fixtureCredential, extras);
async function scenario(name, test) {
 const result = { name, started: new Date().toISOString(), status: 'passed' };
 try { await test(result); } catch (error) { Object.assign(result, { status: 'failed', error: error.message }); }
 cases.push(result); console.log(JSON.stringify(result));
 await mkdir(resolve(root, '.reports'), { recursive: true });
 await writeFile(resolve(root, '.reports/live-retry-loop.json'), JSON.stringify({ at: new Date().toISOString(), source: 'real n8n engine, controlled fixture API', cases }, null, 2));
}
async function execute(definition, result) {
 const created = await client.createWorkflow(definition); result.workflowId = created.id;
 const run = await client.run(created); result.executionId = run.executionId;
 return { created, execution: await client.wait(run.executionId) };
}
await scenario('Native Retry Execution preserves all per-item identities', async (result) => {
 await control('reset', { scenario: result.name, failures: [{ method: 'POST', path: '/indexes', occurrence: 2, status: 503, body: { message: 'Temporary second-item failure' } }] });
 const { execution } = await execute(workflow(result.name, [itemsNode([{ label: 'First' }, { label: 'Second' }]), native({ resource: 'index', operation: 'create', name: '={{$json.label}}' })]), result);
 assert.equal(execution.status, 'error');
 const retry = await client.request(`/executions/${result.executionId}/retry`, 'POST', { loadWorkflow: false });
 result.retryExecutionId = retry.id; result.retryOf = retry.retryOf;
 const retried = await client.wait(retry.id);
 assert.equal(retried.status, 'success', retried.data?.resultData?.error?.message);
 assert.equal(output(retried, 'VideoVector').length, 2);
 const report = await control('report');
 const calls = report.calls.filter((call) => call.method === 'POST' && call.routePath === '/indexes');
 result.calls = calls.map(({ idempotencyKey, body, occurrence }) => ({ idempotencyKey, body, occurrence })); result.effects = report.effects;
 assert.equal(calls.length, 4);
 assert(calls[0].idempotencyKey);
 assert.equal(calls[0].idempotencyKey, calls[2].idempotencyKey);
 assert.equal(calls[1].idempotencyKey, calls[3].idempotencyKey);
 assert.equal(report.effects.indexes, 2, 'Retry Execution must not recreate the successful first item');
});
await scenario('Loop iterations and fresh executions receive distinct identities', async (result) => {
 await control('reset', { scenario: result.name });
 const loop = { id: randomUUID(), name: 'Loop Over Items', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [400, 220], parameters: { batchSize: 1, options: {} } };
 const done = { id: randomUUID(), name: 'Done', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [850, 80], parameters: {} };
 const definition = workflow(result.name, [itemsNode([{ label: 'First' }, { label: 'Second' }]), loop, native({ resource: 'index', operation: 'create', name: '={{$json.label}}' }), done]);
 definition.connections['Loop Over Items'] = { main: [[{ node: 'Done', type: 'main', index: 0 }], [{ node: 'VideoVector', type: 'main', index: 0 }]] };
 definition.connections.VideoVector = { main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]] };
 const { created, execution } = await execute(definition, result);
 assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
 const fresh = await client.run(created); result.freshExecutionId = fresh.executionId;
 const second = await client.wait(fresh.executionId);
 assert.equal(second.status, 'success', second.data?.resultData?.error?.message);
 const report = await control('report');
 const calls = report.calls.filter((call) => call.method === 'POST' && call.routePath === '/indexes');
 result.calls = calls.map(({ idempotencyKey, body, occurrence }) => ({ idempotencyKey, body, occurrence })); result.effects = report.effects;
 assert.equal(calls.length, 4); assert.equal(new Set(calls.map((call) => call.idempotencyKey)).size, 4);
 assert.equal(report.effects.indexes, 4);
});
for (const operation of ['image', 'multimodal']) await scenario(`Billed ${operation} search reuses keys during native retry`, async (result) => {
 const path = `/indexes/index-fixture/${operation === 'image' ? 'image-search' : 'multimodal-search'}`;
 await control('reset', { scenario: result.name, failures: [{ method: 'POST', path, occurrence: 2, status: 503 }] });
 const binary = { id: randomUUID(), name: 'Binary Items', type: 'n8n-nodes-base.code', typeVersion: 2, position: [250, 220], parameters: { mode: 'runOnceForAllItems', jsCode: "return [0,1].map(i=>({json:{item:i},binary:{data:{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',mimeType:'image/png',fileName:'query.png'}}}));" } };
 const { execution } = await execute(workflow(result.name, [binary, native({ resource: 'search', operation, indexId: { __rl: true, mode: 'id', value: 'index-fixture' }, binaryProperty: 'data', query: 'scene', limit: 10 }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 })]), result);
 assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
 const report = await control('report');
 const calls = report.calls.filter((call) => call.method === 'POST' && call.routePath === path);
 result.calls = calls.map(({ idempotencyKey, occurrence }) => ({ idempotencyKey, occurrence }));
 assert.equal(calls.length, 4); assert(calls[0].idempotencyKey, 'Paid image/multimodal requests need a stable key');
 assert.equal(calls[0].idempotencyKey, calls[2].idempotencyKey); assert.equal(calls[1].idempotencyKey, calls[3].idempotencyKey);
});
process.exitCode = cases.some((test) => test.status !== 'passed') ? 1 : 0;
