/** Standard n8n editor/API test driver. Secrets stay in the ignored local runtime directory. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseFlatted } from 'flatted';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = resolve(packageRoot, '../.local/n8n');
const stateFile = resolve(runtimeDir, 'runtime.json');
const reportsDir = resolve(packageRoot, '.reports');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export class N8nClient {
  constructor(state) { this.state = state; }
  async request(path, method = 'GET', body) {
    const response = await fetch(`${this.state.url}/rest${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.state.cookie ? { Cookie: this.state.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.state.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 200) }; }
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${parsed.message || parsed.error || response.statusText}`);
    return parsed.data ?? parsed;
  }
  async login() {
    await this.request('/login', 'POST', { emailOrLdapLoginId: this.state.email, password: this.state.password });
    await saveState(this.state);
  }
  async credential(name, type, data) {
    const existing = await this.request('/credentials');
    const found = existing.find((entry) => entry.name === name && entry.type === type);
    if (found) return found;
    return await this.request('/credentials', 'POST', { name, type, data });
  }
  async createWorkflow(workflow) {
    return await this.request('/workflows', 'POST', {
      name: workflow.name, nodes: workflow.nodes, connections: workflow.connections,
      settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', ...workflow.settings },
      ...(workflow.pinData ? { pinData: workflow.pinData } : {}),
    });
  }
  async run(workflow, trigger = 'Start') {
    return await this.request(`/workflows/${workflow.id}/run`, 'POST', { triggerToStartFrom: { name: trigger } });
  }
  async execution(id) {
    const execution = await this.request(`/executions/${id}`);
    if (typeof execution.data === 'string') execution.data = parseFlatted(execution.data);
    return execution;
  }
  async wait(id, { timeoutMs = 180000, acceptWaiting = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const execution = await this.execution(id);
      if (['success', 'error', 'canceled', 'crashed'].includes(execution.status) || (acceptWaiting && execution.status === 'waiting')) return execution;
      await sleep(1000);
    }
    throw new Error(`Execution ${id} did not finish within ${timeoutMs}ms`);
  }
}

async function saveState(state) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
export async function loadClient() {
  return new N8nClient(JSON.parse(await readFile(stateFile, 'utf8')));
}

export function action(name, parameters, credential, extras = {}) {
  return {
    id: randomUUID(), name, type: '@vectormethods/n8n-nodes-videovector.videoVector', typeVersion: 1,
    position: [520, 220], parameters,
    credentials: { videoVectorApi: { id: credential.id, name: credential.name } }, ...extras,
  };
}
export function workflow(name, nodes) {
  const start = { id: randomUUID(), name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 220], parameters: {} };
  const all = [start, ...nodes];
  const connections = {};
  for (let i = 0; i < all.length - 1; i++) connections[all[i].name] = { main: [[{ node: all[i + 1].name, type: 'main', index: 0 }]] };
  return { name: `VideoVector QA · ${name}`, nodes: all, connections };
}
export function itemsNode(items) {
  return { id: randomUUID(), name: 'Input Items', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 220],
    parameters: { mode: 'runOnceForAllItems', jsCode: `return ${JSON.stringify(items.map((json) => ({ json })))};` } };
}
export function output(execution, name) {
  return execution.data?.resultData?.runData?.[name]?.at(-1)?.data?.main?.[0] ?? [];
}
export async function runCase(client, name, definition, inspect, options) {
  const started = new Date().toISOString();
  let created;
  let run;
  try {
    created = await client.createWorkflow(definition);
    run = await client.run(created);
    const execution = await client.wait(run.executionId, options);
    if (inspect) await inspect(execution);
    else if (execution.status !== 'success') throw new Error(execution.data?.resultData?.error?.message || `Execution status ${execution.status}`);
    return { name, status: 'passed', started, workflowId: created.id, executionId: run.executionId, executionStatus: execution.status };
  } catch (error) {
    return { name, status: 'failed', started, workflowId: created?.id, executionId: run?.executionId, error: error.message };
  }
}

async function bootstrap() {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch { state = { url: 'http://localhost:5678', email: 'n8n-local@example.com', password: `Aa1!${randomBytes(24).toString('base64url')}` }; }
  await saveState(state);
  const client = new N8nClient(state);
  try { await client.login(); }
  catch {
    await client.request('/owner/setup', 'POST', { email: state.email, password: state.password, firstName: 'VideoVector', lastName: 'QA' });
  }
  state.fixtureCredential = await client.credential('VideoVector · Controlled fixtures', 'videoVectorApi', {
    apiKey: 'fixture', baseUrl: 'http://host.docker.internal:5679/api/v2',
  });
  let apiKey;
  try { apiKey = (await readFile(resolve(runtimeDir, 'api-key'), 'utf8')).trim(); } catch { /* Live credential can be added after owner setup. */ }
  if (apiKey) {
    state.liveCredential = await client.credential('VideoVector · Live API', 'videoVectorApi', { apiKey, baseUrl: 'https://api.vectormethods.com/api/v2' });
    state.httpCredential = await client.credential('VideoVector · HTTP API key', 'httpHeaderAuth', { name: 'X-API-Key', value: apiKey });
  }
  await saveState(state);
  process.stdout.write(JSON.stringify({ editor: state.url, owner: state.email, fixtureCredentialId: state.fixtureCredential.id,
    liveCredentialId: state.liveCredential?.id, credentialsFile: stateFile }) + '\n');
}

async function importExamples() {
  const client = await loadClient();
  await client.login();
  const results = [];
  for (const file of (await readdir(resolve(packageRoot, 'examples'))).filter((name) => name.endsWith('.json'))) {
    try {
      const example = JSON.parse(await readFile(resolve(packageRoot, 'examples', file), 'utf8'));
      for (const node of example.nodes) {
        if (node.type.startsWith('@vectormethods/n8n-nodes-videovector.') && client.state.liveCredential) {
          node.credentials = { videoVectorApi: { id: client.state.liveCredential.id, name: client.state.liveCredential.name } };
        }
        if (node.parameters?.genericAuthType === 'httpHeaderAuth' && client.state.httpCredential) {
          node.credentials = { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } };
        }
      }
      const imported = await client.createWorkflow({ ...example, name: `Example · ${example.name}` });
      results.push({ file, status: 'imported', workflowId: imported.id });
    } catch (error) { results.push({ file, status: 'failed', error: error.message }); }
  }
  await mkdir(reportsDir, { recursive: true });
  await writeFile(resolve(reportsDir, 'example-imports.json'), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exitCode = results.some((result) => result.status === 'failed') ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'bootstrap') await bootstrap();
  else if (command === 'import-examples') await importExamples();
  else throw new Error('Usage: node scripts/live-test.mjs bootstrap|import-examples');
}
