/** Supplementary live acceptance through installed native nodes. Never deletes existing user resources. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, action, workflow, output, runCase } from './live-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '../.local/n8n');
const statePath = resolve(local, 'live-contract-resources.json');
const client = await loadClient(); await client.login();
assert(client.state.liveCredential && client.state.httpCredential, 'Live native and HTTP credentials must be stored in n8n first');
const main = JSON.parse(await readFile(resolve(local, 'live-resources.json'), 'utf8'));
assert(main.indexId && main.promptId && main.videoId, 'Run live-media prepare before supplementary acceptance');
const credential = client.state.liveCredential;
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch { state = { runTag: main.runTag, results: [] }; }
if (process.argv.includes('--fresh')) {
 try { await copyFile(resolve(root, '.reports/live-contracts.json'), resolve(root, `.reports/live-contracts-${Date.now()}.json`)); } catch { /* No earlier sweep. */ }
 state = { runTag: main.runTag, attempt: String(Date.now()), results: [] };
}
assert.equal(state.runTag, main.runTag, 'Supplementary resources belong to another main test run');
const timeoutMs = Number(process.argv[2] || 600000);
const selectedFamilies = (process.argv[3] || 'setup,image,reasoning,connector,retry,deletion').split(',');
const mutationKey = (name) => `${main.runTag}:contracts:${state.attempt || 'initial'}:${name}`;
const id = (value) => ({ __rl: true, mode: 'id', value });
async function persist() {
 await mkdir(local, { recursive: true, mode: 0o700 }); await mkdir(resolve(root, '.reports'), { recursive: true });
 await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
 await writeFile(resolve(root, '.reports/live-contracts.json'), JSON.stringify({ at: new Date().toISOString(), environment: 'official n8n, deployed VideoVector API', runTag: main.runTag, resources: { disposableIndexId: state.indexId, disposablePromptId: state.promptId, imageVideoId: state.imageVideoId, imageRunId: state.imageRunId, connectorImportId: state.connectorImportId, connectorEmptyImportId: state.connectorEmptyImportId, segmentRetryId: state.segmentRetryId }, connectorOutcome: state.connectorOutcome, connectorRetryOutcome: state.connectorRetryOutcome, results: state.results }, null, 2));
}
async function scenario(name, definition, inspect, options) {
 const result = await runCase(client, name, definition, async (execution) => {
  let inspectionError;
  try { if (inspect) await inspect(execution); } catch (error) { inspectionError = error; }
 assert.equal(execution.status, options?.expectedStatus || 'success', execution.data?.resultData?.error?.message || `Execution ${execution.id}: ${execution.status}`);
  if (inspectionError) throw inspectionError;
 }, options || { timeoutMs });
 state.results.push(result); await persist(); console.log(JSON.stringify(result)); return result;
}
async function notApplicable(name, reason) {
 const result = { name, status: 'not_applicable', reason, at: new Date().toISOString() };
 state.results.push(result); await persist(); console.log(JSON.stringify(result));
}
async function blocked(name, reason) {
 const result = { name, status: 'blocked', error: reason, at: new Date().toISOString() };
 state.results.push(result); await persist(); console.log(JSON.stringify(result));
}
async function one(name, parameters, inspect) {
 return scenario(name, workflow(name, [action('Action', parameters, credential)]), (execution) => inspect?.(output(execution, 'Action'), execution));
}
function httpNode(name, path, method = 'GET', body) {
 return { id: randomUUID(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 200], parameters: { method, url: `https://api.vectormethods.com/api/v2${path}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...(body === undefined ? {} : { sendBody: true, specifyBody: 'json', jsonBody: JSON.stringify(body) }), options: {} }, credentials: { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } } };
}
async function http(name, path, method, body, inspect) {
 return scenario(name, workflow(name, [httpNode('HTTP API', path, method, body)]), (execution) => inspect?.(output(execution, 'HTTP API').map((entry) => entry.json)));
}
function condition(name, expression) {
 return { id: randomUUID(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [800, 200], parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: randomUUID(), leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } };
}
function polling(name, submit, get, terminal, accepted, final) {
 const done = condition('Terminal?', terminal);
 const successful = condition('Succeeded?', accepted);
 const deadline = condition('Deadline?', "={{ Date.now() >= Date.parse($('Deadline').first().json.deadline) }}");
 const settings = { id: randomUUID(), name: 'Deadline', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 200], parameters: { assignments: { assignments: [{ id: 'deadline', name: 'deadline', value: '={{ new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }}', type: 'string' }] }, includeOtherFields: true, options: {} } };
 const wait = { id: randomUUID(), name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1200, 350], parameters: { resume: 'timeInterval', amount: 65, unit: 'seconds' } };
 const failure = { id: randomUUID(), name: 'Failure', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [1200, 0], parameters: { errorMessage: '={{ JSON.stringify($json) }}' } };
 const definition = workflow(name, [settings, ...(submit ? [submit] : []), get, done, successful, deadline, wait, failure, final]);
 const edge = (node) => [{ node, type: 'main', index: 0 }];
 definition.connections['Terminal?'] = { main: [edge('Succeeded?'), edge('Deadline?')] };
 definition.connections['Succeeded?'] = { main: [edge(final.name), edge('Failure')] };
 definition.connections['Deadline?'] = { main: [edge('Failure'), edge('Wait')] };
 definition.connections.Wait = { main: [edge(get.name)] }; delete definition.connections.Failure;
 return definition;
}
async function setup() {
 await createIndex();
 await one('Create disposable edit/delete prompt', { resource: 'prompt', operation: 'create', name: `n8n contracts ${main.runTag}`.slice(0, 100), promptText: 'Describe the image in a concise sentence.', jsonSchema: '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}', idempotencyKey: mutationKey('prompt') }, (items) => { assert(items[0]?.json.prompt_id); state.promptId = items[0].json.prompt_id; });
 if (state.promptId) {
  await one('Edit disposable prompt description', { resource: 'prompt', operation: 'update', promptId: id(state.promptId), additionalFields: { description: 'n8n live edit acceptance' }, idempotencyKey: mutationKey('edit') }, (items) => assert.equal(items[0]?.json.description, 'n8n live edit acceptance'));
  await one('Clear disposable prompt description', { resource: 'prompt', operation: 'update', promptId: id(state.promptId), additionalFields: { description: '' }, idempotencyKey: mutationKey('clear') }, (items) => assert.equal(items[0]?.json.description, ''));
 }
 await one('Estimate processing with saved prompt defaults', { resource: 'run', operation: 'estimate', promptId: id(main.promptId), target: 'videos', videoIds: JSON.stringify([main.videoId]) }, (items) => assert(items.length));
}
async function createIndex() {
 await one('Create disposable contract-test index', { resource: 'index', operation: 'create', name: `n8n contracts ${main.runTag}`, idempotencyKey: mutationKey('index') }, (items) => { assert(items[0]?.json.index_id); state.indexId = items[0].json.index_id; });
}
let imageData;
async function imageInput() {
 if (!imageData) {
  const file = resolve(local, 'fixtures/query.png');
  await promisify(execFile)('ffmpeg', ['-y', '-i', resolve(local, 'fixtures/sample.mp4'), '-frames:v', '1', '-vf', 'scale=320:-1', file], { maxBuffer: 1024 * 1024 });
  imageData = (await readFile(file)).toString('base64');
 }
 return { id: randomUUID(), name: 'Query Image', type: 'n8n-nodes-base.code', typeVersion: 2, position: [400, 0], parameters: { mode: 'runOnceForAllItems', jsCode: `return [{json:{},binary:{data:{data:${JSON.stringify(imageData)},mimeType:'image/png',fileName:'query.png'}}}];` } };
}
async function imageCoverage() {
 if (!state.indexId) await createIndex();
 if (!state.indexId) return blocked('Image extraction and searches', 'Disposable index creation failed');
 const definition = JSON.parse(await readFile(resolve(root, 'examples/native-upload-process-results.json'), 'utf8'));
 definition.name = `VideoVector QA · Live image extraction · ${main.runTag}`;
 definition.nodes = definition.nodes.filter((node) => node.name !== 'Fetch Media');
 definition.nodes.push(await imageInput());
 const configure = definition.nodes.find((node) => node.name === 'Configure');
 configure.parameters.assignments.assignments.find((item) => item.name === 'promptId').value = main.promptId;
 const start = definition.nodes.find((node) => node.name === 'Manual Trigger'); start.name = 'Start';
 definition.connections.Start = definition.connections['Manual Trigger']; delete definition.connections['Manual Trigger'];
 definition.connections.Configure = { main: [[{ node: 'Query Image', type: 'main', index: 0 }]] };
 definition.connections['Query Image'] = { main: [[{ node: 'Upload Media', type: 'main', index: 0 }]] }; delete definition.connections['Fetch Media'];
 for (const node of definition.nodes) if (node.type.startsWith('@vectormethods/n8n-nodes-videovector.')) node.credentials = { videoVectorApi: { id: credential.id, name: credential.name } };
 Object.assign(definition.nodes.find((node) => node.name === 'Upload Media').parameters, { destination: 'index', indexId: id(state.indexId), idempotencyKey: mutationKey('image') });
 Object.assign(definition.nodes.find((node) => node.name === 'Start Run').parameters, { target: 'videos', mediaScope: 'index', indexId: id(state.indexId), additionalFields: { enable_image_embedding: true, enable_transcription: false }, idempotencyKey: mutationKey('image-run') });
 await scenario('Extract tiny image with image embeddings', definition, (execution) => {
  state.imageVideoId = output(execution, 'Upload Media')[0]?.json.video?.video_id;
  state.imageRunId = output(execution, 'Start Run')[0]?.json.run_id;
  assert(output(execution, 'Get Results').length, execution.data?.resultData?.error?.message || 'Expected extracted image result');
 });
 if (!state.imageRunId) return;
 for (const operation of ['image', 'multimodal']) {
  await scenario(`Live ${operation} search`, workflow(`Live ${operation} search`, [await imageInput(), action('Search', { resource: 'search', operation, indexId: id(state.indexId), binaryProperty: 'data', query: 'The visible colors and test pattern', limit: 5, additionalFields: { run_ids: JSON.stringify([state.imageRunId]) }, fullResponse: true, idempotencyKey: mutationKey(`${operation}-search`) }, credential)]), (execution) => {
   const results = output(execution, 'Search')[0]?.json.data;
   assert(Array.isArray(results)); assert(results.length > 0, 'Matching indexed image must be returned');
  });
 }
}
async function reasoningCoverage() {
 Object.assign(main, JSON.parse(await readFile(resolve(local, 'live-resources.json'), 'utf8')));
 if (!main.runId) return blocked('Live SQL and agentic searches', 'Main live-media run is not available yet');
 await one('Generate SQL against the completed run', { resource: 'search', operation: 'sqlGenerate', indexId: id(main.indexId), instruction: 'Return the available scene summary rows. Use the supplied table catalog and do not invent columns.', additionalFields: { run_ids: JSON.stringify([main.runId]) }, idempotencyKey: mutationKey('sql-generate') }, (items) => { assert(typeof items[0]?.json.query === 'string'); state.generatedSql = items[0].json.query; });
 if (state.generatedSql) await one('Execute generated SQL', { resource: 'search', operation: 'sqlExecute', indexId: id(main.indexId), query: state.generatedSql, additionalFields: { run_ids: JSON.stringify([main.runId]), result_limit: 5 }, fullResponse: true }, (items) => assert(Array.isArray(items[0]?.json.rows)));
 await one('Scoped non-streaming agentic search', { resource: 'search', operation: 'agentic', query: 'Summarize the visible media from this run in one sentence, citing the available evidence.', additionalFields: { index_ids: JSON.stringify([main.indexId]), prompt_run_ids: JSON.stringify([main.runId]), title: `n8n live ${main.runTag}` }, idempotencyKey: mutationKey('agentic') }, (items) => {
  const turn = items[0]?.json.turn; assert(turn?.session_id); state.agentSessionId = turn.session_id; assert.equal(turn.status, 'completed', turn.error?.message); assert(turn.assistant_message?.content);
 });
}
async function connectorCoverage() {
 if (!state.indexId) await createIndex();
 if (!state.indexId) return blocked('Existing connector import', 'Disposable index creation failed');
 let connectors = [];
 await http('Discover import-capable connectors', '/connectors', 'GET', undefined, (items) => { connectors = items.filter((item) => item.status === 'active' && item.scopes?.includes('import')); });
 if (!connectors.length) return notApplicable('Existing connector import', 'This test account has no active connector with import scope');
 let selected; let successfulBrowses = 0;
 try {
  const verified = JSON.parse(await readFile(resolve(local, 'connector-fixture.json'), 'utf8'));
  const connector = connectors.find((item) => item.connector_id === verified.connectorId);
  if (connector && verified.file?.size_bytes > 0 && verified.file.size_bytes <= 5 * 1024 * 1024) {
   selected = { connector, file: verified.file };
   await http('Browse verified small connector fixture', `/connectors/${encodeURIComponent(connector.connector_id)}/browse`, 'POST', { prefix: verified.file.path, pattern: basename(verified.file.path), recursive: false, limit: 1 }, (items) => {
    assert.equal(items.length, 1); assert.equal(items[0].path, verified.file.path); assert.equal(items[0].size_bytes, verified.file.size_bytes);
   });
  }
 } catch { /* A separately verified object is optional; normal discovery uses browse. */ }
 for (const connector of connectors.slice(0, 3)) {
  if (selected) break;
  await http(`Browse bounded connector ${connector.connector_id}`, `/connectors/${encodeURIComponent(connector.connector_id)}/browse`, 'POST', { prefix: '', pattern: '*', recursive: true, limit: 25 }, (items) => {
   successfulBrowses++;
   const file = items.filter((item) => item.size_bytes > 0 && item.size_bytes <= 5 * 1024 * 1024 && /\.(mp4|png|jpe?g|webp|wav|mp3)$/i.test(item.path)).sort((a, b) => a.size_bytes - b.size_bytes)[0];
   if (file) selected = { connector, file };
  });
  if (selected) break;
 }
 if (!selected && !successfulBrowses) {
  await blocked('Import existing connector media', 'All bounded active-connector browse calls failed on the deployed API; no source object was available to import');
  return emptyConnectorImport(connectors[0]);
 }
 if (!selected) return notApplicable('Existing connector import', 'No supported object <=5MB in the bounded first25 objects of up to3 active import connectors');
 const { connector, file } = selected;
 state.connectorId = connector.connector_id; state.connectorSourcePath = file.path;
 const submit = action('Submit Import', { resource: 'import', operation: 'start', connectorId: id(connector.connector_id), indexId: id(state.indexId), additionalFields: { source_prefix: file.path, file_pattern: basename(file.path), recursive: false, import_mode_override: 'all' }, idempotencyKey: mutationKey('connector-import') }, credential);
 const get = action('Get Import', { resource: 'import', operation: 'get', jobId: "={{ $('Submit Import').first().json.job_id }}" }, credential);
 const files = action('Imported Files', { resource: 'import', operation: 'files', jobId: "={{ $('Submit Import').first().json.job_id }}" }, credential);
 await scenario('Import one small object from existing connector', polling('Existing connector import', submit, get, "={{ ['completed','failed','cancelled'].includes($json.status) }}", "={{ $json.status === 'completed' && $json.progress.imported > 0 }}", files), (execution) => {
  state.connectorImportId = output(execution, 'Submit Import')[0]?.json.job_id;
  const imported = output(execution, 'Imported Files'); assert.equal(imported.length, 1, 'Exact connector selection should import one object'); state.connectorVideoIds = imported.map((item) => item.json.video_id);
 });
 await emptyConnectorImport(connector);
}
async function emptyConnectorImport(connector) {
 const submit = action('Submit Empty Import', { resource: 'import', operation: 'start', connectorId: id(connector.connector_id), indexId: id(state.indexId), additionalFields: { source_prefix: `n8n-empty-acceptance/${main.runTag}/${state.attempt || 'initial'}/no-such-object`, file_pattern: 'sample.mp4', recursive: false, import_mode_override: 'all' }, idempotencyKey: mutationKey('empty-connector-import') }, credential);
 const get = action('Get Empty Import', { resource: 'import', operation: 'get', jobId: "={{ $('Submit Empty Import').first().json.job_id }}" }, credential);
 const final = action('Empty Import Outcome', { resource: 'import', operation: 'get', jobId: "={{ $('Submit Empty Import').first().json.job_id }}" }, credential);
 const terminal = "={{ ['completed','failed','cancelled'].includes($json.status) }}";
 await scenario('Existing connector bounded empty-prefix outcome', polling('Empty existing-connector import', submit, get, terminal, "={{ ['completed','failed'].includes($json.status) }}", final), (execution) => {
  state.connectorEmptyImportId = output(execution, 'Submit Empty Import')[0]?.json.job_id;
  state.connectorOutcome = output(execution, 'Empty Import Outcome')[0]?.json;
  assert(state.connectorOutcome); assert.equal(state.connectorOutcome.progress.imported, 0);
  assert(['completed', 'failed'].includes(state.connectorOutcome.status));
 });
 if (state.connectorOutcome?.status !== 'failed') return;
 const retry = action('Retry Empty Import', { resource: 'import', operation: 'retry', jobId: state.connectorEmptyImportId, idempotencyKey: mutationKey('retry-empty-connector-import') }, credential);
 await scenario('Reject unsupported connector-job retry with actionable error', workflow('Connector retry restriction', [retry]), (execution) => {
  const error = execution.data?.resultData?.error;
  state.connectorRetryOutcome = { message: error?.message, context: error?.context, httpCode: error?.httpCode };
  assert.equal(error?.context?.statusCode, 400); assert.match(error?.message || '', /requires an attachment job/);
  assert(error?.context?.requestId);
 }, { timeoutMs, expectedStatus: 'error' });
}
async function scopeCoverage() {
 Object.assign(main, JSON.parse(await readFile(resolve(local, 'live-resources.json'), 'utf8')));
 await one('SQL catalog with the required empty JSON body', { resource: 'search', operation: 'sqlCatalog', indexId: id(main.indexId), fullResponse: true }, (items) => assert(Array.isArray(items[0]?.json.tables)));
 await one('Agentic search with default session settings', { resource: 'search', operation: 'agentic', query: 'Briefly summarize this run using its available evidence.', additionalFields: { index_ids: JSON.stringify([main.indexId]), prompt_run_ids: JSON.stringify([main.runId]) }, idempotencyKey: mutationKey('default-session') }, (items) => {
  assert.equal(items[0]?.json.turn?.status, 'completed'); assert(items[0]?.json.turn?.assistant_message?.content);
 });
 const parameters = { resource: 'run', promptId: id(main.promptId), target: 'videos', mediaScope: 'index', indexId: id(main.indexId), videoIds: JSON.stringify([main.videoId]) };
 await one('Estimate specific media within an index', { ...parameters, operation: 'estimate' }, (items) => assert(items.length));
 const submit = action('Start Indexed Media', { ...parameters, operation: 'start', promptSource: 'saved', idempotencyKey: mutationKey('indexed-media-run') }, credential);
 const get = action('Get Indexed Run', { resource: 'run', operation: 'get', runId: id("={{ $('Start Indexed Media').first().json.run_id }}") }, credential);
 const final = action('Indexed Media Results', { resource: 'run', operation: 'results', runId: id("={{ $('Start Indexed Media').first().json.run_id }}"), view: 'unfiltered', resultLevel: 'segment', returnAll: true }, credential);
 await scenario('Process specific indexed media through native normalized fields', polling('Indexed specific-media run', submit, get, "={{ ['completed','completed_with_failures','failed','cancelled'].includes($json.status) }}", "={{ ['completed','completed_with_failures'].includes($json.status) }}", final), (execution) => {
  state.scopedRunId = output(execution, 'Start Indexed Media')[0]?.json.run_id;
  const results = output(execution, 'Indexed Media Results'); assert(results.length); assert(results.every((item) => item.json.video_id === main.videoId));
 });
}
async function retryCoverage() {
 for (const runId of [...new Set([main.runId, main.importRunId, state.imageRunId].filter(Boolean))]) {
  let candidate;
  await one(`Inspect own-run failure manifest ${runId}`, { resource: 'run', operation: 'failures', runId: id(runId) }, (items) => {
   for (const video of items[0]?.json.videos || []) for (const segment of video.segments || []) if (!candidate && segment.retryable !== false && !segment.projection_only) candidate = { runId, videoId: video.video_id, segmentId: segment.segment_id };
  });
  if (!candidate) continue;
  const submit = action('Retry Segment', { resource: 'run', operation: 'retrySegment', runId: id(candidate.runId), videoId: id(candidate.videoId), segmentId: candidate.segmentId, idempotencyKey: mutationKey(`segment-retry:${candidate.runId}`) }, credential);
  const get = action('Retry Status', { resource: 'run', operation: 'retryStatus', runId: id(candidate.runId), videoId: id(candidate.videoId), segmentId: candidate.segmentId, retryId: "={{ $('Retry Segment').first().json.retry_id }}" }, credential);
  const final = action('Run After Retry', { resource: 'run', operation: 'get', runId: id(candidate.runId) }, credential);
  await scenario('Retry a genuinely failed segment and inspect status', polling('Real failed-segment retry', submit, get, "={{ ['completed','failed'].includes($json.status) }}", "={{ $json.status === 'completed' }}", final), (execution) => { state.segmentRetryId = output(execution, 'Retry Segment')[0]?.json.retry_id; assert(state.segmentRetryId); });
  return;
 }
 await notApplicable('Failed-segment retry', 'All dedicated live runs had no eligible failed segment; fixture retry/status contract coverage remains recorded separately');
}
async function deletionCoverage() {
 if (state.promptId) await one('Delete unused disposable prompt', { resource: 'prompt', operation: 'delete', promptId: id(state.promptId), idempotencyKey: mutationKey('delete-prompt') }, (items) => assert(items[0]?.json.message));
 if (state.imageVideoId) {
  await one('Delete disposable image media', { resource: 'media', operation: 'delete', videoId: id(state.imageVideoId), idempotencyKey: mutationKey('delete-image') }, (items) => assert(items[0]?.json.status));
  await one('Inspect image deletion status', { resource: 'media', operation: 'deletionStatus', videoId: id(state.imageVideoId) }, (items) => assert(items[0]?.json.status));
 }
 if (state.indexId) {
  await one('Delete dedicated disposable index', { resource: 'index', operation: 'delete', indexId: id(state.indexId), idempotencyKey: mutationKey('delete-index') }, (items) => assert(items[0]?.json.status));
  await one('Inspect disposable-index deletion status', { resource: 'index', operation: 'deletionStatus', indexId: id(state.indexId) }, (items) => assert(items[0]?.json.status));
 }
}
// Continue independent families when one family cannot construct its workflow.
for (const [name, run] of [['setup', setup], ['image', imageCoverage], ['reasoning', reasoningCoverage], ['connector', connectorCoverage], ['retry', retryCoverage], ['scope', scopeCoverage], ['deletion', deletionCoverage]]) {
 if (!selectedFamilies.includes(name)) continue;
 try { await run(); }
 catch (error) { await blocked(`${name} test harness`, error.message); }
}
await persist();
process.exitCode = state.results.some((result) => ['failed', 'blocked'].includes(result.status)) ? 1 : 0;
