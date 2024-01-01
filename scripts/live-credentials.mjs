/**
 * Real deployed credential/scope/revocation acceptance. The product UI creates
 * a dedicated read-only key and transfers it straight into the two named n8n
 * credentials. No key or JWT is read by this script, written to disk, or logged.
 * Run `active`, revoke ONLY that test key in the product UI, then run `revoked`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, workflow, action, output } from './live-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
const credentialOnly = process.argv.includes('--credential-only');
assert.ok(['active', 'revoked'].includes(phase), 'Usage: node live-credentials.mjs active|revoked');
const client = await loadClient(); await client.login();
const credentials = await client.request('/credentials');
const native = credentials.find((entry) => entry.name === 'VideoVector · Live read-only acceptance' && entry.type === 'videoVectorApi');
const http = credentials.find((entry) => entry.name === 'VideoVector · Live read-only HTTP acceptance' && entry.type === 'httpHeaderAuth');
assert.ok(native && http, 'Create the dedicated temporary read-only credentials through the authorized product and n8n UI first');
await mkdir(resolve(root, '.reports'), { recursive: true });
const file = resolve(root, '.reports/deployed-credentials.json');
let report = { source: 'deployed VideoVector API, real n8n engine, dedicated read-only API key', credentials: { nativeId: native.id, httpId: http.id }, cases: [] };
if (phase === 'revoked' || credentialOnly) report = JSON.parse(await readFile(file, 'utf8'));
async function scenario(name, inspect) {
 if (credentialOnly && !/native credential/.test(name)) return;
 const evidence = { name, phase, started: new Date().toISOString(), source: 'live' };
 try { await inspect(evidence); evidence.status = 'passed'; }
 catch (error) { evidence.status = 'failed'; evidence.error = error.message; }
 report.cases = report.cases.filter((entry) => entry.name !== name || entry.phase !== phase);
 report.cases.push(evidence); await writeFile(file, JSON.stringify(report, null, 2));
 console.log(JSON.stringify(evidence));
}
async function nativeExecution(name, parameters, evidence) {
 const created = await client.createWorkflow(workflow(name, [action('VideoVector', parameters, native, { onError: 'continueRegularOutput' })]));
 evidence.workflowId = created.id;
 const run = await client.run(created); evidence.executionId = run.executionId;
 const execution = await client.wait(run.executionId, { timeoutMs: 45000 });
 assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
 return output(execution, 'VideoVector').map((item) => item.json);
}
async function httpExecution(name, method, path, evidence) {
 const request = { id: randomUUID(), name: 'Scope Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 220], parameters: {
  method, url: `https://api.vectormethods.com/api/v2${path}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
 }, credentials: { httpHeaderAuth: { id: http.id, name: http.name } } };
 const created = await client.createWorkflow(workflow(name, [request])); evidence.workflowId = created.id;
 const run = await client.run(created); evidence.executionId = run.executionId;
 const execution = await client.wait(run.executionId, { timeoutMs: 45000 });
 assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
 const response = output(execution, 'Scope Request')[0]?.json;
 evidence.request = { method, path, status: Number(response?.statusCode), requestId: response?.headers?.['x-request-id'] ?? null };
 evidence.errorCode = response?.body?.error?.code ?? response?.body?.code;
 return response;
}
async function credentialTest(evidence, expected) {
 // Match the editor: return the redacted data received from GET to the test
 // endpoint, which restores its existing secret inside n8n. Omitting data tests
 // an empty draft credential instead of the saved credential.
 const saved = await client.request(`/credentials/${native.id}?includeData=true`);
 assert.ok(!String(saved.data.apiKey).startsWith('sk_live_'), 'Expected n8n to return its redacted credential representation');
 const result = await client.request('/credentials/test', 'POST', { credentials: { id: native.id, name: native.name, type: native.type, data: saved.data } });
 evidence.endpoint = '/auth/validate'; evidence.credentialTest = result;
 assert.equal(result.status, expected);
}
if (phase === 'active') {
 await scenario('Read-only key passes native credential validation', (e) => credentialTest(e, 'OK'));
 await scenario('Read-only API key validates with HTTP 204', async (e) => {
  const response = await httpExecution('Live read-only validation', 'GET', '/auth/validate', e); assert.equal(Number(response.statusCode), 204);
 });
 await scenario('Read-only native index discovery succeeds', async (e) => {
  const rows = await nativeExecution('Live read-only index discovery', { resource: 'index', operation: 'list', fullResponse: true }, e);
  assert.ok(!rows.some((row) => row.error)); e.outputItemCount = rows.length;
 });
 await scenario('Native mutation reports live insufficient scope with HTTP 403', async (e) => {
  const rows = await nativeExecution('Live read-only rejected cancellation', { resource: 'run', operation: 'cancel', runId: { mode: 'id', value: `n8n-scope-probe-${randomUUID()}` } }, e);
  const rejected = rows[0]; e.error = rejected.error; e.details = rejected.details;
  assert.equal(Number(rejected.details?.statusCode ?? rejected.statusCode), 403);
  assert.match(rejected.error, /scope|permission|forbidden/i);
 });
 await scenario('Webhook cleanup requires admin scope before resource lookup', async (e) => {
  const response = await httpExecution('Live read-only rejected webhook cleanup', 'DELETE', `/webhooks/n8n-scope-probe-${randomUUID()}`, e);
  assert.equal(Number(response.statusCode), 403);
 });
 await scenario('Index selector uses real n8n resource-locator search with read-only credentials', async (e) => {
  const created = await client.createWorkflow(workflow('Live read-only index selector', [action('VideoVector', { resource: 'index', operation: 'get', indexId: { mode: 'list', value: '' } }, native)]));
  e.workflowId = created.id;
  const result = await client.request('/dynamic-node-parameters/resource-locator-results', 'POST', {
   workflowId: created.id, path: 'indexId', methodName: 'listIndexes', filter: 'n8n',
   credentials: { videoVectorApi: { id: native.id, name: native.name } },
   currentNodeParameters: { resource: 'index', operation: 'get', indexId: { mode: 'list', value: '' } },
   nodeTypeAndVersion: { name: '@vectormethods/n8n-nodes-videovector.videoVector', version: 1 },
  });
  assert.ok(Array.isArray(result.results)); e.resultCount = result.results.length;
  e.results = result.results.map(({ name, value }) => ({ name, value }));
  assert.ok(result.results.every((row) => `${row.name} ${row.value}`.toLowerCase().includes('n8n')));
 });
} else {
 await scenario('Revoked key fails the native credential test', (e) => credentialTest(e, 'Error'));
 await scenario('Revoked key is rejected by deployed auth validation', async (e) => {
  const response = await httpExecution('Live revoked API key validation', 'GET', '/auth/validate', e); assert.equal(Number(response.statusCode), 401);
 });
 await scenario('Native read rejects a revoked key with actionable HTTP 401', async (e) => {
  const rows = await nativeExecution('Live revoked key read rejection', { resource: 'index', operation: 'list', fullResponse: true }, e);
  const rejected = rows[0]; e.error = rejected.error; e.details = rejected.details;
  assert.equal(Number(rejected.details?.statusCode ?? rejected.statusCode), 401);
  assert.match(rejected.error, /key|revoked|auth|invalid|credential/i);
 });
}
process.exitCode = report.cases.some((entry) => entry.status === 'failed') ? 1 : 0;
