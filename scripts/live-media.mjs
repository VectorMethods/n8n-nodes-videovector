/** Live deployed-API acceptance through the installed package in the standard n8n editor.
 * prepare stops at a durable Wait so the operator can restart the container.
 * finish inspects resumption, then continues independent read/search/import/export scenarios.
 * API credentials are resolved only by n8n; this driver never reads their secret values.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadClient, action, workflow, output, runCase } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '../.local/n8n');
const resourceFile = resolve(local, 'live-resources.json');
const reportFile = resolve(root, '.reports/live-media.json');
const id = (value) => ({ __rl: true, mode: 'id', value });
const link = (node) => ({ main: [[{ node, type: 'main', index: 0 }]] });
const timeoutMs = Number(process.argv[3] || 600000);
const client = await loadClient();
await client.login();
if (!client.state.liveCredential) throw new Error('Bootstrap a live VideoVector credential in n8n first');
const credential = client.state.liveCredential;
let state;
try { state = JSON.parse(await readFile(resourceFile, 'utf8')); }
catch { state = { runTag: new Date().toISOString().replace(/[:.]/g, '-'), results: [] }; }
state.results ??= [];

async function persist() {
 await mkdir(local, { recursive: true, mode: 0o700 });
 await mkdir(dirname(reportFile), { recursive: true });
 await writeFile(resourceFile, JSON.stringify(state, null, 2), { mode: 0o600 });
 await writeFile(reportFile, JSON.stringify({ generatedAt: new Date().toISOString(), environment: 'official n8n Docker editor, deployed VideoVector API', runTag: state.runTag, resources: { indexId: state.indexId, promptId: state.promptId, videoId: state.videoId, runId: state.runId, importJobId: state.importJobId, exportId: state.exportId }, results: state.results }, null, 2));
}
function success(execution) {
 assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message || `Execution ${execution.id}: ${execution.status}`);
}
function first(execution, name) {
 const items = output(execution, name);
 assert(items.length, `Node ${name} returned no output`);
 return items[0];
}
async function scenario(name, definition, inspect, options) {
 const result = await runCase(client, name, definition, inspect, options);
 state.results.push({ ...result, mode: process.argv[2], evidence: result.executionId ? `${client.state.url}/workflow/${result.workflowId}/executions/${result.executionId}` : undefined });
 await persist();
 console.log(JSON.stringify(result));
 return result;
}
async function missing(name, reason) {
 const result = { name, status: 'blocked', error: reason, started: new Date().toISOString(), mode: process.argv[2] };
 state.results.push(result); await persist(); console.log(JSON.stringify(result));
}
async function one(name, parameters, inspect, options) {
 return scenario(name, workflow(name, [action('Action', parameters, credential)]), async (execution) => { success(execution); if (inspect) await inspect(output(execution, 'Action'), execution); }, options);
}
async function template(file, name) {
 const definition = JSON.parse(await readFile(resolve(root, 'examples', file), 'utf8'));
 definition.name = `VideoVector QA · ${name} · ${state.runTag}`;
 const configure = definition.nodes.find((node) => node.name === 'Configure');
 for (const assignment of configure.parameters.assignments.assignments) {
  if (assignment.name === 'promptId') assignment.value = state.promptId;
  if (assignment.name === 'mediaUrl') assignment.value = 'http://host.docker.internal:5679/sample.mp4';
 }
 for (const node of definition.nodes) if (node.type.startsWith('@vectormethods/n8n-nodes-videovector.')) {
  node.credentials = { videoVectorApi: { id: credential.id, name: credential.name } };
 }
 return definition;
}
async function independentReads() {
 for (const resource of ['index', 'prompt', 'run', 'import', 'export']) {
  await one(`Live ${resource} list`, { resource, operation: 'list', ...(resource === 'run' ? { listScope: 'all' } : {}), limit: 10, fullResponse: true });
 }
}
async function prepare() {
 await independentReads();
 await one('Create dedicated live index', { resource: 'index', operation: 'create', name: `n8n live ${state.runTag}`, idempotencyKey: `${state.runTag}:index` }, (items) => {
  assert(items[0]?.json.index_id, 'Index response must include index_id'); state.indexId = items[0].json.index_id;
 });
 await one('Create extraction prompt from schema', { resource: 'prompt', operation: 'create', name: `n8n live ${state.runTag}`.slice(0, 100), promptText: 'Describe the visible scene in one concise sentence. Return the summary field.', jsonSchema: '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}', additionalFields: { execution_config: '{"video_segmentation_type":"fixed","audio_segmentation_type":"fixed","video_segment_duration":10,"audio_segment_duration":10,"enable_transcription":false,"enable_image_embedding":false}' }, idempotencyKey: `${state.runTag}:prompt` }, (items) => {
  assert(items[0]?.json.prompt_id, 'Prompt response must include prompt_id'); state.promptId = items[0].json.prompt_id;
 });
 await one('Define prompt from plain language', { resource: 'prompt', operation: 'define', instruction: 'Describe the visible scene in a short text field called summary.', additionalFields: { save: false }, idempotencyKey: `${state.runTag}:define` }, (items) => assert(items[0]?.json.definition, 'Definition response missing'));
 if (state.indexId) await one('Read dedicated index', { resource: 'index', operation: 'get', indexId: id(state.indexId) });
 if (state.promptId) await one('Read saved prompt', { resource: 'prompt', operation: 'get', promptId: id(state.promptId) });
 if (!state.indexId || !state.promptId) return missing('Upload and process template', 'Dedicated index or saved prompt creation failed; independent reads were still exercised');
 const definition = await template('native-upload-process-results.json', 'Binary upload, process and restart');
 const upload = definition.nodes.find((node) => node.name === 'Upload Media');
 Object.assign(upload.parameters, { destination: 'index', indexId: id(state.indexId), idempotencyKey: `${state.runTag}:upload` });
 definition.nodes.find((node) => node.name === 'Start Run').parameters.idempotencyKey = `${state.runTag}:run`;
 const wait = { id: randomUUID(), name: 'Persistence Check', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [900, -150], parameters: { resume: 'timeInterval', amount: 65, unit: 'seconds' } };
 definition.nodes.push(wait);
 definition.connections['Start Run'] = link('Persistence Check');
 definition.connections['Persistence Check'] = link('Get Run');
 // The native template starts with Manual Trigger; runCase uses Start consistently.
 definition.nodes.find((node) => node.name === 'Manual Trigger').name = 'Start';
 definition.connections.Start = definition.connections['Manual Trigger']; delete definition.connections['Manual Trigger'];
 const result = await scenario('Binary upload and durable first Wait', definition, (execution) => {
  const uploadResult = output(execution, 'Upload Media')[0]?.json;
  const runResult = output(execution, 'Start Run')[0]?.json;
  if (uploadResult?.video?.video_id) state.videoId = uploadResult.video.video_id;
  if (runResult?.run_id) state.runId = runResult.run_id;
  assert.equal(execution.status, 'waiting', execution.data?.resultData?.error?.message || 'Expected persisted Wait state');
  assert(state.videoId && state.runId, 'Upload and processing identifiers must survive the wait');
 }, { acceptWaiting: true, timeoutMs: 180000 });
 state.binaryWorkflowId = result.workflowId; state.binaryExecutionId = result.executionId;
 await persist();
 console.log(JSON.stringify({ readyForRestart: result.executionStatus === 'waiting', executionId: state.binaryExecutionId, workflowId: state.binaryWorkflowId, runId: state.runId, instruction: 'Restart the official n8n container now, then invoke live-media.mjs finish' }));
}
async function resumeBinary() {
 if (!state.binaryExecutionId) return missing('Resume binary workflow after restart', 'prepare did not create an execution');
 const result = { name: 'Resume binary workflow after restart', started: new Date().toISOString(), workflowId: state.binaryWorkflowId, executionId: state.binaryExecutionId, mode: 'finish' };
 try {
  const execution = await client.wait(state.binaryExecutionId, { timeoutMs });
  success(execution);
  const extracted = output(execution, 'Get Results');
  assert(extracted.length, 'Completed run must provide extraction rows');
  assert(extracted[0].json._videovector?.run_id === state.runId, 'Result item must preserve run identity');
  state.resultCount = extracted.length;
  Object.assign(result, { status: 'passed', executionStatus: execution.status, resultCount: extracted.length });
 } catch (error) { Object.assign(result, { status: 'failed', error: error.message }); }
 state.results.push(result); await persist(); console.log(JSON.stringify(result));
}
function ifNode(name, expression) {
 return { id: randomUUID(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [760, 220], parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: randomUUID(), leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } };
}
async function exportRun() {
 if (!state.runId) return missing('Export and download processed results', 'No uploaded-media run exists');
 const create = action('Create Export', { resource: 'export', operation: 'create', exportSource: 'run', runId: id(state.runId), idempotencyKey: `${state.runTag}:export` }, credential);
 const get = action('Get Export', { resource: 'export', operation: 'get', exportId: "={{ $('Create Export').first().json.export_id }}" }, credential);
 const download = action('Download Export', { resource: 'export', operation: 'download', exportId: "={{ $('Create Export').first().json.export_id }}", outputBinaryProperty: 'data' }, credential);
 const complete = ifNode('Export Complete?', "={{ $json.status === 'completed' }}");
 const failed = ifNode('Export Failed?', "={{ $json.status === 'failed' }}");
 const deadline = ifNode('Export Deadline?', "={{ Date.now() >= Date.parse($('Deadline').first().json.deadline) }}");
 const config = { id: randomUUID(), name: 'Deadline', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 220], parameters: { assignments: { assignments: [{ id: 'deadline', name: 'deadline', value: '={{ new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }}', type: 'string' }] }, includeOtherFields: true, options: {} } };
 const wait = { id: randomUUID(), name: 'Wait for Export', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1200, 420], parameters: { resume: 'timeInterval', amount: 65, unit: 'seconds' } };
 const failure = { id: randomUUID(), name: 'Export Failure', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [1200, 0], parameters: { errorMessage: "={{ 'Export ' + $('Create Export').first().json.export_id + ': ' + JSON.stringify($json) }}" } };
 const definition = workflow('Live run export and binary download', [config, create, get, complete, download, failed, deadline, wait, failure]);
 definition.connections['Export Complete?'] = { main: [[{ node: 'Download Export', type: 'main', index: 0 }], [{ node: 'Export Failed?', type: 'main', index: 0 }]] };
 definition.connections['Export Failed?'] = { main: [[{ node: 'Export Failure', type: 'main', index: 0 }], [{ node: 'Export Deadline?', type: 'main', index: 0 }]] };
 definition.connections['Export Deadline?'] = { main: [[{ node: 'Export Failure', type: 'main', index: 0 }], [{ node: 'Wait for Export', type: 'main', index: 0 }]] };
 definition.connections['Wait for Export'] = link('Get Export'); delete definition.connections['Download Export'];
 await scenario('Export and binary download', definition, (execution) => {
  state.exportId = output(execution, 'Create Export')[0]?.json.export_id;
  success(execution); const downloadItem = first(execution, 'Download Export');
  assert(downloadItem.binary?.data, 'Export must produce an n8n binary field');
  assert(downloadItem.binary.data.fileName, 'Export binary must retain a filename');
  state.exportBinary = { fileName: downloadItem.binary.data.fileName, mimeType: downloadItem.binary.data.mimeType, fileSize: downloadItem.binary.data.fileSize };
 }, { timeoutMs });
}
async function urlImport() {
 if (!state.videoId || !state.promptId || !state.indexId || !client.state.httpCredential) return missing('URL import template', 'Uploaded media, index, prompt, or n8n HTTP credential is unavailable');
 const definition = await template('native-url-import-process-results.json', 'URL import and extraction');
 const grant = { id: randomUUID(), name: 'Mint Media URL', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [300, -100], parameters: { method: 'POST', url: 'https://api.vectormethods.com/api/v2/workflow/media-grants', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: JSON.stringify({ video_id: state.videoId, intent: 'download' }), options: {} }, credentials: { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } } };
 definition.nodes.push(grant);
 const submit = definition.nodes.find((node) => node.name === 'Submit Import');
 Object.assign(submit.parameters, { destination: 'index', indexId: id(state.indexId), files: "={{ JSON.stringify([{ download_url: $('Mint Media URL').first().json.url, file_id: 'n8n-original-media', file_name: 'sample.mp4', mime_type: 'video/mp4' }]) }}" });
 definition.connections.Configure = link('Mint Media URL'); definition.connections['Mint Media URL'] = link('Submit Import');
 definition.nodes.find((node) => node.name === 'Manual Trigger').name = 'Start';
 definition.connections.Start = definition.connections['Manual Trigger']; delete definition.connections['Manual Trigger'];
 await scenario('URL import, processing and extraction template', definition, (execution) => {
  state.importJobId = output(execution, 'Submit Import')[0]?.json.job_id;
  state.importRunId = output(execution, 'Start Run')[0]?.json.run_id;
  success(execution);
  assert(output(execution, 'Get Results').length, 'URL-imported media must produce extraction results');
 }, { timeoutMs });
 if (state.importJobId) await one('Inspect imported files', { resource: 'import', operation: 'files', jobId: state.importJobId }, (items) => assert(items.length));
}
async function finish() {
 await resumeBinary();
 if (state.videoId) {
  await one('Read uploaded media', { resource: 'media', operation: 'get', videoId: id(state.videoId) });
  await one('Download uploaded media', { resource: 'media', operation: 'download', videoId: id(state.videoId) }, (items) => assert(items[0]?.binary?.data, 'Media download binary missing'));
  await one('List run segments', { resource: 'media', operation: 'segments', videoId: id(state.videoId), additionalFields: { run_id: state.runId }, returnAll: true });
 }
 if (state.runId) {
  await one('Get both extraction streams', { resource: 'run', operation: 'results', runId: id(state.runId), view: 'both', resultLevel: 'segment', returnAll: true, fullResponse: true }, (items) => {
   assert(items.some((entry) => entry.json.unfiltered?.data?.length), 'Unfiltered results missing');
   assert(items.every((entry) => 'selection_summary' in entry.json), 'Selection status must be retained');
  });
  await one('Inspect run failure manifest', { resource: 'run', operation: 'failures', runId: id(state.runId) });
  await one('Semantic search with snapshot pages', { resource: 'search', operation: 'semantic', searchScope: 'runs', runIds: JSON.stringify([state.runId]), query: 'Describe the visible scene', resultLevel: 'segment', returnAll: true, fullResponse: true }, (items) => assert(items[0]?.json.pagination, 'Search pagination envelope missing'));
  await one('Condition search with zero or more matches', { resource: 'search', operation: 'condition', searchScope: 'runs', runIds: JSON.stringify([state.runId]), filters: '[{"field":"summary","operator":"contains","value":"scene"}]', resultLevel: 'segment', returnAll: true, fullResponse: true }, (items) => assert(items[0]?.json.pagination));
 }
 if (state.indexId) {
  await one('Paginate index media', { resource: 'media', operation: 'list', destination: 'index', indexId: id(state.indexId), returnAll: true });
  await one('Paginate index runs', { resource: 'run', operation: 'list', listScope: 'index', indexId: id(state.indexId), returnAll: true });
  await one('Read SQL catalog', { resource: 'search', operation: 'sqlCatalog', indexId: id(state.indexId), fullResponse: true }, (items) => { state.sqlQuery = items[0]?.json.tables?.[0]?.default_query; });
  if (state.sqlQuery) await one('Execute SQL catalog query', { resource: 'search', operation: 'sqlExecute', indexId: id(state.indexId), query: state.sqlQuery, fullResponse: true }, (items) => assert(Array.isArray(items[0]?.json.rows)));
 }
 await exportRun();
 await urlImport();
 await persist();
}
const mode = process.argv[2];
if (mode === 'prepare') await prepare();
else if (mode === 'finish') await finish();
else throw new Error('Usage: node scripts/live-media.mjs prepare|finish [timeoutMs]');
process.exitCode = state.results.filter((result) => result.mode === mode).some((result) => result.status !== 'passed') ? 1 : 0;
