/** Execute the shipped standalone MCP example against the hosted read-only tool.
 * Requires the existing live Header Auth credential from live-test.mjs bootstrap.
 * Does not use a model credential, create media, or reset the shared API fixture.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, output } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = {
  name: 'Shipped standalone MCP example lists indexes without a model',
  started: new Date().toISOString(), status: 'passed',
  endpoint: 'https://api.vectormethods.com/mcp', tool: 'list_indexes',
};
try {
  const client = await loadClient();
  await client.login();
  const credential = client.state.httpCredential;
  assert(credential, 'Bootstrap an authorized live Header Auth credential before MCP acceptance');
  const definition = JSON.parse(await readFile(resolve(root, 'examples/mcp-list-indexes.json'), 'utf8'));
  definition.name = `VideoVector QA · ${definition.name}`;
  const node = definition.nodes.find((entry) => entry.type === '@n8n/n8n-nodes-langchain.mcpClient');
  assert.equal(node.parameters.tool.value, result.tool);
  assert.equal(node.parameters.endpointUrl, result.endpoint);
  assert(!definition.nodes.some((entry) => entry.type.includes('lmChat') || entry.type.endsWith('.agent')));
  node.credentials = { httpHeaderAuth: { id: credential.id, name: credential.name } };
  const workflow = await client.createWorkflow(definition);
  result.workflowId = workflow.id;
  const run = await client.run(workflow, 'Manual Trigger');
  result.executionId = run.executionId;
  const execution = await client.wait(run.executionId);
  result.executionStatus = execution.status;
  assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
  const items = output(execution, node.name);
  assert.equal(items.length, 1);
  const data = items[0].json.structuredContent;
  assert(data && Number.isInteger(data.total_indexes), 'MCP must preserve canonical structuredContent');
  assert(Array.isArray(data.user_indexes));
  assert(Array.isArray(data.default_indexes));
  assert.equal(data.total_indexes, data.user_indexes.length + data.default_indexes.length);
  assert.equal(items[0].pairedItem.item, 0, 'MCP must retain the source item link');
  // Keep resource names and IDs out of the acceptance report.
  result.output = { totalIndexes: data.total_indexes, userIndexes: data.user_indexes.length,
    defaultIndexes: data.default_indexes.length, structuredContent: true, pairedItem: 0 };
} catch (error) {
  Object.assign(result, { status: 'failed', error: error.message });
}
await mkdir(resolve(root, '.reports'), { recursive: true });
await writeFile(resolve(root, '.reports/live-mcp.json'), JSON.stringify({
  at: new Date().toISOString(), source: 'shipped example; official n8n MCP Client; deployed VideoVector MCP', cases: [result],
}, null, 2));
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : 1;
