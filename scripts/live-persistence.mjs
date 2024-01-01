/** Persisted Wait/restart acceptance using the shipped upload workflow and controlled API.
 * Run prepare, restart the official container, then finish. Keep the fixture alive.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { action, loadClient, output } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = resolve(root, '../.local/n8n/persistence.json');
const reportFile = resolve(root, '.reports/live-persistence.json');
const client = await loadClient();
await client.login();
const control = async (path, body) => {
 const response = await fetch(`http://localhost:5679/__control/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
 });
 assert(response.ok, `Fixture ${path}: ${response.status}`);
 return response.json();
};
const link = (node) => ({ main: [[{ node, type: 'main', index: 0 }]] });
let state;
if (process.argv[2] === 'prepare') {
 await control('reset', { scenario: 'persisted-wait-restart', statusSequence: ['processing', 'completed'], download: { filename: 'results.json', mimeType: 'application/json', base64: Buffer.from('{"summary":"restart acceptance"}\n').toString('base64') } });
 const definition = JSON.parse(await readFile(resolve(root, 'examples/native-upload-process-results.json'), 'utf8'));
 definition.name = 'VideoVector QA · Persisted upload, restart, paginated results and export';
 definition.nodes.find((node) => node.name === 'Manual Trigger').name = 'Start';
 definition.connections.Start = definition.connections['Manual Trigger'];
 delete definition.connections['Manual Trigger'];
 for (const assignment of definition.nodes.find((node) => node.name === 'Configure').parameters.assignments.assignments) {
  if (assignment.name === 'promptId') assignment.value = 'prompt-fixture';
  if (assignment.name === 'mediaUrl') assignment.value = 'http://host.docker.internal:5679/sample.mp4';
 }
 for (const node of definition.nodes) if (node.type.startsWith('@vectormethods/')) {
  node.credentials = { videoVectorApi: { id: client.state.fixtureCredential.id, name: client.state.fixtureCredential.name } };
 }
 const create = action('Create Export', { resource: 'export', operation: 'create', exportSource: 'run', runId: { __rl: true, mode: 'id', value: "={{ $('Start Run').first().json.run_id }}" } }, client.state.fixtureCredential, { executeOnce: true });
 const get = action('Get Export', { resource: 'export', operation: 'get', exportId: '={{ $json.export_id }}' }, client.state.fixtureCredential);
 const download = action('Download Export', { resource: 'export', operation: 'download', exportId: '={{ $json.export_id }}', outputBinaryProperty: 'data' }, client.state.fixtureCredential);
 definition.nodes.push(create, get, download);
 definition.connections['Get Results'] = link('Create Export');
 definition.connections['Create Export'] = link('Get Export');
 definition.connections['Get Export'] = link('Download Export');
 const created = await client.createWorkflow(definition);
 const started = await client.run(created);
 const execution = await client.wait(started.executionId, { acceptWaiting: true });
 assert.equal(execution.status, 'waiting', execution.data?.resultData?.error?.message);
 assert(output(execution, 'Fetch Media')[0]?.binary?.data?.id, 'Source binary must use persistent filesystem storage');
 state = { startedAt: new Date().toISOString(), environment: 'official n8n Docker2.42.4; controlled HTTP API', workflowId: created.id, executionId: started.executionId, runId: output(execution, 'Start Run')[0].json.run_id, initialStatus: execution.status, waitingNode: execution.data.resultData.lastNodeExecuted };
 await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
 console.log(JSON.stringify({ ...state, readyForRestart: true }));
} else if (process.argv[2] === 'finish') {
 state = JSON.parse(await readFile(stateFile, 'utf8'));
 try {
  const execution = await client.wait(state.executionId, { timeoutMs: 180000 });
  assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
  const rows = output(execution, 'Get Results');
  assert.deepEqual(rows.map((item) => item.json.segment_id), ['segment-1', 'segment-2', 'segment-3'], 'All three fixture result pages must resume after restart');
  assert(rows.every((item) => item.json._videovector.run_id === state.runId));
  const binary = output(execution, 'Download Export')[0]?.binary?.data;
  assert(binary?.id, 'Export download must use persistent binary storage');
  assert.equal(binary.fileName, 'results.json');
  assert.equal(binary.mimeType, 'application/json');
  const report = await control('report');
  assert.equal(report.effects.media, 1, 'Restart must not duplicate upload');
  assert.equal(report.effects.runs, 1, 'Restart must not duplicate run submission');
  assert.equal(report.effects.exports, 1, 'Paginated results should create one export');
  assert(report.downloads.every((entry) => !entry.apiKeyPresent && !entry.authorizationPresent));
  Object.assign(state, { status: 'passed', finalStatus: execution.status, resultCount: rows.length, export: { fileName: binary.fileName, mimeType: binary.mimeType, fileSize: binary.fileSize }, effects: report.effects, downloads: report.downloads });
 } catch (error) { Object.assign(state, { status: 'failed', error: error.message }); }
 await writeFile(reportFile, JSON.stringify(state, null, 2));
 console.log(JSON.stringify(state));
 process.exitCode = state.status === 'passed' ? 0 : 1;
} else throw new Error('Usage: node scripts/live-persistence.mjs prepare|finish');
