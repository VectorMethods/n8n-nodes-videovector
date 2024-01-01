/** Error-channel, diagnostics, empty-result, and async-readiness acceptance in real n8n. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, workflow, action, output } from './live-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient(); await client.login();
const cases = [];
const fixture = client.state.fixtureCredential;
const control = async (config) => {
 const response = await fetch('http://localhost:5679/__control/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
 assert(response.ok, `Fixture setup ${response.status}`);
};
async function scenario(name, config, definition, inspect) {
 const result = { name, started: new Date().toISOString(), status: 'passed' };
 try {
  await control({ scenario: name, ...config });
  const created = await client.createWorkflow(definition); result.workflowId = created.id;
  const run = await client.run(created); result.executionId = run.executionId;
  const execution = await client.wait(run.executionId); result.executionStatus = execution.status;
  result.output = output(execution, 'VideoVector').map(({ json }) => json);
  await inspect(execution, result);
 } catch (error) { Object.assign(result, { status: 'failed', error: error.message }); }
 cases.push(result); console.log(JSON.stringify(result));
 await mkdir(resolve(root, '.reports'), { recursive: true });
 await writeFile(resolve(root, '.reports/live-errors.json'), JSON.stringify({ at: new Date().toISOString(), source: 'real n8n engine, controlled responses', cases }, null, 2));
}
const native = (parameters, extras = {}, credential = fixture) => action('VideoVector', parameters, credential, extras);
const noOp = (name) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [900, 220], parameters: {} });
const binaryItems = { id: randomUUID(), name: 'Input Items', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 220], parameters: { mode: 'runOnceForAllItems', jsCode: "return ['First','Second'].map(label=>({json:{label},binary:{data:{data:'cHJlc2VydmUgbWU=',mimeType:'text/plain',fileName:'source.txt'}}}));" } };
const separate = workflow('Separate error output preserves item data', [binaryItems, native({ resource: 'index', operation: 'create', name: '={{ $json.label }}' }, { onError: 'continueErrorOutput' }), noOp('Success Output'), noOp('Failure Output')]);
separate.connections.VideoVector = { main: [[{ node: 'Success Output', type: 'main', index: 0 }], [{ node: 'Failure Output', type: 'main', index: 0 }]] };
delete separate.connections['Success Output'];
await scenario('Separate error output preserves failed item and binary', { failures: [{ method: 'POST', path: '/indexes', occurrence: 2, status: 403, body: { error: { code: 'authorization_insufficient_scope', message: 'Write scope is required' } } }] }, separate, (execution, result) => {
 assert.equal(execution.status, 'success');
 const success = output(execution, 'Success Output'); const failed = output(execution, 'Failure Output');
 result.successCount = success.length; result.failureCount = failed.length;
 result.failedItem = failed[0] ? { json: failed[0].json, pairedItem: failed[0].pairedItem, binaryFields: Object.keys(failed[0].binary || {}) } : null;
 assert.equal(success.length, 1); assert.equal(failed.length, 1); assert.equal(failed[0].json.label, 'Second');
 assert(failed[0].binary?.data, 'The failed input binary must be retained on the error branch');
 assert.match(failed[0].json.error, /scope/i);
 assert.equal(failed[0].json.details?.code, 'authorization_insufficient_scope');
 assert.equal(String(failed[0].json.details?.statusCode), '403');
 assert.match(String(failed[0].json.details?.requestId), /^fixture-request-/);
 const nativeErrorItem = execution.data.resultData.runData.VideoVector.at(-1).data.main[1][0];
 assert.deepEqual(nativeErrorItem.pairedItem, { item: 1 });
 assert.equal(nativeErrorItem.json.label, 'Second');
 assert.equal(nativeErrorItem.error, undefined, 'Top-level error must not invoke the engine JSON rewrite');
});
const invalid = await client.credential('VideoVector · Rejected fixture key', 'videoVectorApi', { apiKey: 'fixture-revoked-key', baseUrl: 'http://host.docker.internal:5679/api/v2' });
for (const [status, code, message] of [[401, 'authentication_invalid_api_key', 'The fixture API key is invalid'], [403, 'authorization_insufficient_scope', 'This operation requires write scope'], [429, 'rate_limit_exceeded', 'Too many requests; try again shortly']]) {
 const config = status === 401 ? {} : { failures: [{ method: 'GET', path: '/indexes', status, body: { error: { code, message } }, headers: status === 429 ? { 'retry-after': '2' } : {} }] };
 await scenario(`Actionable ${status} structured diagnostics`, config, workflow(`Actionable ${status} structured diagnostics`, [native({ resource: 'index', operation: 'list', fullResponse: true }, { onError: 'continueRegularOutput' }, status === 401 ? invalid : fixture)]), (execution) => {
  assert.equal(execution.status, 'success');
  const error = output(execution, 'VideoVector')[0]?.json;
  assert(error, 'Expected one continued error item');
  assert.equal(error.code ?? error.details?.code, code);
  assert.equal(String(error.statusCode ?? error.details?.statusCode), String(status));
  assert.match(error.error, status === 401 ? /invalid/i : status === 403 ? /scope/i : /requests|rate/i);
  assert.match(String(error.requestId ?? error.details?.requestId), /^fixture-request-/);
  if (status === 429) assert.equal(Number(error.retryAfter ?? error.details?.retryAfter), 2);
 });
}
await scenario('Ready zero selected matches returns zero rows', { selection: 'empty' }, workflow('Ready empty selected results', [native({ resource: 'run', operation: 'results', runId: { mode: 'id', value: 'r' }, view: 'filtered', resultLevel: 'segment', returnAll: true })]), (execution) => {
 assert.equal(execution.status, 'success'); assert.equal(output(execution, 'VideoVector').length, 0);
});
await scenario('Ready zero selected matches preserves full response', { selection: 'empty' }, workflow('Ready empty selected response', [native({ resource: 'run', operation: 'results', runId: { mode: 'id', value: 'r' }, view: 'filtered', resultLevel: 'segment', fullResponse: true, returnAll: true })]), (execution) => {
 assert.equal(execution.status, 'success'); const row = output(execution, 'VideoVector')[0]?.json;
 assert.equal(row.selection_summary.status, 'ready'); assert.deepEqual(row.filtered.data, []);
});
const pending = { failures: [{ method: 'GET', path: '/workflow/runs/r/results', status: 200, body: { run_id: 'r', status: 'processing', result_level: 'segment', selection_summary: { status: 'pending' }, filtered: null, unfiltered: null } }] };
await scenario('Processing unfiltered results reports unavailable', pending, workflow('Pending unfiltered rows', [native({ resource: 'run', operation: 'results', runId: { mode: 'id', value: 'r' }, view: 'unfiltered', resultLevel: 'segment' })]), (execution) => {
 assert.equal(execution.status, 'error', 'Pending extraction must not silently terminate downstream workflow with zero items');
 assert.match(execution.data?.resultData?.error?.message, /unavailable|processing|ready/i);
});
await scenario('Processing full response preserves readiness', pending, workflow('Pending full response', [native({ resource: 'run', operation: 'results', runId: { mode: 'id', value: 'r' }, view: 'both', resultLevel: 'segment', fullResponse: true })]), (execution) => {
 assert.equal(execution.status, 'success'); const row = output(execution, 'VideoVector')[0]?.json;
 assert.equal(row.status, 'processing'); assert.equal(row.unfiltered, null); assert.equal(row.filtered, null);
});
await scenario('Run cancellation preserves canonical terminal state', {}, workflow('Cancel run', [native({ resource: 'run', operation: 'cancel', runId: { mode: 'id', value: 'r' } })]), (execution) => {
 assert.equal(execution.status, 'success'); const row = output(execution, 'VideoVector')[0]?.json;
 assert.equal(row.status, 'cancelled'); assert.equal(row.run_id, 'r');
});
process.exitCode = cases.some((result) => result.status !== 'passed') ? 1 : 0;
