/** Execute the shipped Cloud-compatible HTTP workflow on existing live QA media. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, output, runCase } from './live-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient(); await client.login();
const state = JSON.parse(await readFile(resolve(root, '../.local/n8n/live-resources.json'), 'utf8'));
assert(client.state.httpCredential && state.promptId && state.videoId && state.indexId);
const definition = JSON.parse(await readFile(resolve(root, 'examples/http-process-results.json'), 'utf8'));
definition.name = 'VideoVector QA · Live built-in HTTP workflow';
const configure = definition.nodes.find((node) => node.name === 'Configure');
for (const field of configure.parameters.assignments.assignments) {
  if (['promptId', 'videoId', 'indexId'].includes(field.name)) field.value = state[field.name];
}
for (const node of definition.nodes) if (node.parameters.genericAuthType === 'httpHeaderAuth') {
  node.credentials = { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } };
}
definition.nodes.find((node) => node.name === 'Manual Trigger').name = 'Start';
definition.connections.Start = definition.connections['Manual Trigger']; delete definition.connections['Manual Trigger'];
const result = await runCase(client, 'Shipped HTTP process, persisted Wait, and paginated results against deployed API', definition, (execution) => {
  assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
  assert(output(execution, 'Start Run')[0]?.json.run_id);
  assert(output(execution, 'Result Items').length, 'HTTP workflow must return extraction rows');
  assert(output(execution, 'Configure')[0]?.json.requestKey, 'Submission identity must survive polling');
}, { timeoutMs: 600000 });
await mkdir(resolve(root, '.reports'), { recursive: true });
await writeFile(resolve(root, '.reports/live-http.json'), JSON.stringify({ at: new Date().toISOString(), source: 'shipped HTTP workflow; deployed VideoVector API', cases: [result] }, null, 2));
console.log(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : 1;
