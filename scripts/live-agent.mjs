/** Exercise the shipped MCP agent with the authorized local Vertex model provider.
 * The model credential goes directly from its configured service-account file into
 * n8n's encrypted credential store. Reports contain no credential or tool payloads.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, itemsNode, output } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = { name: 'Shipped MCP agent invokes a live tool through a supported model provider',
  started: new Date().toISOString(), status: 'passed', endpoint: 'https://api.vectormethods.com/mcp' };
try {
  const client = await loadClient(); await client.login();
  assert(client.state.httpCredential, 'Store the live Header Auth credential in n8n first');
  const env = { ...parseEnv(await readFile(resolve(root, '../.env'), 'utf8')), ...process.env };
  assert(env.CHAT_AGENT_VERTEX_CREDENTIALS_PATH, 'Configure an authorized Vertex service account');
  const account = JSON.parse(await readFile(resolve(root, '..', env.CHAT_AGENT_VERTEX_CREDENTIALS_PATH), 'utf8'));
  assert.equal(account.type, 'service_account');
  const region = env.CHAT_AGENT_VERTEX_LOCATION || 'global';
  const model = env.CHAT_AGENT_MODEL_NAME || 'gemini-3.5-flash';
  const modelCredential = await client.credential('VideoVector QA · Vertex chat model', 'googleApi', {
    region, email: account.client_email, privateKey: account.private_key, inpersonate: false, httpNode: false,
  });
  const definition = JSON.parse(await readFile(resolve(root, 'examples/mcp-agent.json'), 'utf8'));
  definition.name = 'VideoVector QA · Live MCP agent';
  // A fixed chat input makes acceptance reproducible; the agent/tool connections
  // are the same as the shipped Chat Trigger example.
  const trigger = definition.nodes.find((node) => node.name === 'Chat Trigger');
  Object.assign(trigger, { name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} });
  const input = itemsNode([{ chatInput: 'Call the list_indexes tool once with include_defaults true. Return only a sentence with the total number of indexes. Do not create, update, or delete anything.' }]);
  definition.nodes.push(input);
  delete definition.connections['Chat Trigger'];
  definition.connections.Start = { main: [[{ node: input.name, type: 'main', index: 0 }]] };
  definition.connections[input.name] = { main: [[{ node: 'VideoVector Agent', type: 'main', index: 0 }]] };
  const llm = definition.nodes.find((node) => node.name === 'Chat Model');
  Object.assign(llm, { type: '@n8n/n8n-nodes-langchain.lmChatGoogleVertex', typeVersion: 1,
    parameters: { projectId: { __rl: true, mode: 'id', value: env.CHAT_AGENT_VERTEX_PROJECT || account.project_id }, modelName: model, location: region, options: { maxOutputTokens: 2048, temperature: 0 } },
    credentials: { googleApi: { id: modelCredential.id, name: modelCredential.name } } });
  const tool = definition.nodes.find((node) => node.name === 'VideoVector MCP');
  tool.parameters.include = 'selected'; tool.parameters.includeTools = ['list_indexes'];
  tool.credentials = { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } };
  definition.nodes.find((node) => node.name === 'VideoVector Agent').parameters.options.returnIntermediateSteps = true;
  const workflow = await client.createWorkflow(definition); result.workflowId = workflow.id;
  const executionId = (await client.run(workflow)).executionId; result.executionId = executionId;
  const execution = await client.wait(executionId, { timeoutMs: 180000 });
  result.executionStatus = execution.status;
  assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
  const answer = output(execution, 'VideoVector Agent')[0]?.json;
  assert(typeof answer?.output === 'string' && answer.output.trim(), 'Agent must return an answer');
  const steps = answer.intermediateSteps || [];
  assert(steps.some((step) => step.action?.tool === 'VideoVector_MCP_list_indexes'), 'Agent must actually call the hosted MCP tool');
  result.output = { modelProvider: 'Google Vertex Chat Model', model, toolCalls: steps.map((step) => step.action?.tool), hasAnswer: true };
} catch (error) { result.status = 'failed'; result.error = error.message; }
await mkdir(resolve(root, '.reports'), { recursive: true });
await writeFile(resolve(root, '.reports/live-agent.json'), JSON.stringify({ at: new Date().toISOString(), cases: [result] }, null, 2));
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : 1;
