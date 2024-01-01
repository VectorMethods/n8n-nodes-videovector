import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const directory = new URL('../examples/', import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
for (const required of ['native-upload-process-results.json', 'native-url-import-process-results.json', 'http-process-results.json', 'mcp-agent.json', 'mcp-list-indexes.json']) {
  assert(files.includes(required), `Missing shipped example ${required}`);
}
for (const file of files) {
  const raw = await readFile(new URL(file, directory), 'utf8');
  const workflow = JSON.parse(raw);
  assert.equal(workflow.active, false, `${file}: examples must import inactive`);
  assert(Array.isArray(workflow.nodes) && workflow.nodes.length > 1, `${file}: missing nodes`);
  const names = new Set(workflow.nodes.map((node) => node.name));
  assert.equal(names.size, workflow.nodes.length, `${file}: duplicate node names`);
  for (const node of workflow.nodes) {
    assert(!node.credentials, `${file}: no credential bindings or secrets in examples`);
    if (node.type === 'n8n-nodes-base.wait') {
      assert.equal(node.parameters.amount, 65);
      assert.equal(node.parameters.unit, 'seconds');
    }
  }
  for (const [name, channels] of Object.entries(workflow.connections)) {
    assert(names.has(name), `${file}: dangling connection source ${name}`);
    for (const branches of Object.values(channels)) for (const branch of branches) for (const edge of branch) {
      assert(names.has(edge.node), `${file}: dangling connection target ${edge.node}`);
    }
  }
  assert(!/sk_live_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9_.-]{20,}/.test(raw), `${file}: credential material`);
  if (['native-upload-process-results.json', 'native-url-import-process-results.json', 'http-process-results.json'].includes(file)) {
    for (const required of ['Configure', 'Start Run', 'Get Run', 'Run Complete?', 'Partial Results?', 'Run Failure', 'Run Timeout', 'Wait for Run', 'Get Results']) {
      assert(names.has(required), `${file}: missing lifecycle node ${required}`);
    }
    assert(raw.includes('24 * 60 * 60 * 1000'), `${file}: bounded 24-hour deadline required`);
    assert(raw.includes('completed_with_failures'), `${file}: partial completion required`);
  }
  if (file === 'http-process-results.json') {
    const configure = workflow.nodes.find((node) => node.name === 'Configure');
    const requestKey = configure.parameters.assignments.assignments.find((field) => field.name === 'requestKey');
    assert.equal(requestKey?.value, "={{ 'n8n:' + $execution.id + ':start-run' }}", `${file}: persist original submission identity before the HTTP request`);
    const submit = workflow.nodes.find((node) => node.name === 'Start Run');
    const header = submit.parameters.headerParameters.parameters.find((field) => field.name.toLowerCase() === 'idempotency-key');
    assert.equal(header?.value, "={{ $('Configure').first().json.requestKey }}", `${file}: Retry Execution must reuse the saved submission identity`);
  }
  if (file === 'mcp-list-indexes.json') {
    assert.equal(workflow.nodes.length, 2, `${file}: standalone MCP requires only a trigger and MCP Client`);
    const client = workflow.nodes.find((node) => node.type === '@n8n/n8n-nodes-langchain.mcpClient');
    assert(client, `${file}: use the built-in standalone MCP Client`);
    assert.equal(client.typeVersion, 1.1);
    assert.equal(client.parameters.endpointUrl, 'https://api.vectormethods.com/mcp');
    assert.equal(client.parameters.authentication, 'headerAuth');
    assert.equal(client.parameters.serverTransport, 'httpStreamable');
    assert.equal(client.parameters.tool.value, 'list_indexes');
    assert.equal(client.parameters.inputMode, 'json');
    assert.equal(client.parameters.jsonInput, '={{ {include_defaults: true} }}');
  }
  if (file === 'mcp-agent.json') {
    assert(workflow.nodes.some((node) => node.type === '@n8n/n8n-nodes-langchain.mcpClientTool'));
    assert(workflow.nodes.some((node) => node.type === '@n8n/n8n-nodes-langchain.lmChatOpenAi'), `${file}: agent template retains its explicit model connection`);
  }
}
console.log(`Validated ${files.length} importable workflow examples`);
