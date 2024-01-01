/**
 * Actual n8n editor lifecycle + HTTPS callback acceptance. Run after installation:
 *   node scripts/live-trigger.mjs
 * Requires live-test.mjs bootstrap, fixture-server.mjs, and public N8N_WEBHOOK_URL.
 * Runs fixture cases first, then deployed-API cases when a live credential exists.
 * Do not run alongside live-cases.mjs: both deliberately reset fixture state.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, output } from './live-test.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const cases = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function poll(description, inspect, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspect();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function record(name, evidence, inspect) {
  const entry = { name, started: new Date().toISOString(), ...evidence };
  try {
    const result = await inspect(entry);
    cases.push({ ...entry, status: 'passed' });
    process.stdout.write(`${name}: passed\n`);
    return result;
  } catch (error) {
    cases.push({ ...entry, status: 'failed', error: error.message });
    process.stdout.write(`${name}: failed\n`);
    return undefined;
  }
}
async function control(path, body) {
  const response = await fetch(`http://localhost:5679/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return response.json();
}
const fixtureBackend = {
  name: 'Controlled callback', credential: client.state.fixtureCredential,
  async list() { return (await control('report')).resources.webhooks; },
  async deliver(hook, invalidSignature = false) { return control('deliver', { webhookId: hook.webhook_id, event: hook.events[0], data: { run_id: 'run-fixture', marker: randomUUID() }, invalidSignature }); },
  async remove(id) {
    const response = await fetch(`http://localhost:5679/api/v2/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-api-key': 'fixture' } });
    if (![200, 404].includes(response.status)) throw new Error(`Fixture emergency cleanup returned ${response.status}`);
  },
};

function definition(name, credential) {
  const trigger = {
    id: randomUUID(), webhookId: randomUUID(), name: 'VideoVector Trigger',
    type: '@vectormethods/n8n-nodes-videovector.videoVectorTrigger', typeVersion: 1,
    position: [240, 200], parameters: { events: ['prompt_run.completed'], indexIds: [] },
    credentials: { videoVectorApi: { id: credential.id, name: credential.name } },
  };
  return {
    name: `VideoVector QA · ${name}`,
    nodes: [trigger, { id: randomUUID(), name: 'Inspect Event', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [520, 200], parameters: {} }],
    connections: { 'VideoVector Trigger': { main: [[{ node: 'Inspect Event', type: 'main', index: 0 }]] } },
  };
}
async function activate(workflow) {
  const current = await client.request(`/workflows/${workflow.id}`);
  return client.request(`/workflows/${workflow.id}/activate`, 'POST', {
    versionId: current.versionId, name: 'VideoVector acceptance',
    ...(current.checksum ? { expectedChecksum: current.checksum } : {}),
  });
}
async function deactivate(workflow) {
  const current = await client.request(`/workflows/${workflow.id}`);
  return client.request(`/workflows/${workflow.id}/deactivate`, 'POST', current.checksum ? { expectedChecksum: current.checksum } : {});
}
async function ownedHooks(backend, workflow) {
  return (await backend.list()).filter((hook) => hook.metadata?.n8n_workflow_id === workflow.id);
}
async function hookFor(backend, workflow, test = false) {
  return poll(`${test ? 'test' : 'production'} subscription`, async () => (await ownedHooks(backend, workflow)).find((hook) => hook.url.includes('/webhook-test/') === test));
}
async function executions(workflowId) {
  const result = await client.request(`/executions?limit=20&filter=${encodeURIComponent(JSON.stringify({ workflowId }))}`);
  return (result.results ?? result).filter((item) => item.workflowId === workflowId);
}
async function deliverAndInspect(backend, workflow, hook, evidence) {
  const before = new Set((await executions(workflow.id)).map((item) => item.id));
  const delivered = await backend.deliver(hook);
  evidence.webhookId = hook.webhook_id;
  evidence.callbackStatus = delivered.status;
  assert.ok(delivered.status >= 200 && delivered.status < 300, `Callback returned ${delivered.status}: ${JSON.stringify(delivered.body)}`);
  const execution = await poll('a webhook execution', async () => (await executions(workflow.id)).find((item) => !before.has(item.id)));
  const completed = await client.wait(execution.id, { timeoutMs: 30000 });
  evidence.executionId = execution.id;
  assert.equal(completed.status, 'success', completed.data?.resultData?.error?.message);
  const event = output(completed, 'Inspect Event')[0]?.json;
  assert.ok(event?.id, 'The canonical event envelope must reach downstream nodes');
  assert.equal(event._delivery.webhook_id, hook.webhook_id);
  if (delivered.event) assert.equal(event.id, delivered.event.id);
  assert.equal(event.secret, undefined);
  return completed;
}
async function cleanup(backend, workflow) {
  if (!workflow) return;
  await record(`${backend.name}: deactivate and clean subscriptions`, { workflowId: workflow.id }, async (evidence) => {
    // Native test lifecycle cleanup is independent of production activation.
    await client.request(`/test-webhook/${workflow.id}`, 'DELETE');
    const existing = await ownedHooks(backend, workflow);
    evidence.webhookIds = existing.map((hook) => hook.webhook_id);
    await deactivate(workflow);
    await poll('subscription cleanup', async () => (await ownedHooks(backend, workflow)).length === 0);
  });
  // A failed product cleanup remains a failure above. Prevent the test harness
  // from leaving externally active subscriptions behind after collecting it.
  let leftovers;
  try { leftovers = await ownedHooks(backend, workflow); }
  catch (error) {
    cases.push({ name: `${backend.name}: inspect remaining subscriptions`, status: 'failed', workflowId: workflow.id, error: error.message });
    return;
  }
  for (const hook of leftovers) {
    await record(`${backend.name}: cleanup leftover subscription`, { workflowId: workflow.id, webhookId: hook.webhook_id, harnessCleanup: true }, async () => backend.remove(hook.webhook_id));
  }
}

await control('reset', { scenario: 'trigger-lifecycle' });
let production;
try {
  production = await client.createWorkflow(definition('Signed callbacks and isolation', fixtureBackend.credential));
  await record('Controlled callback: activate subscription', { workflowId: production.id }, async (evidence) => {
    await activate(production);
    const hook = await hookFor(fixtureBackend, production);
    evidence.webhookId = hook.webhook_id;
    assert.ok(hook.url.startsWith('https://'), 'Use the real public HTTPS ingress');
  });
  await record('Controlled callback: signed production delivery', { workflowId: production.id }, async (evidence) => deliverAndInspect(fixtureBackend, production, await hookFor(fixtureBackend, production), evidence));
  await record('Controlled callback: tampered signature is rejected', { workflowId: production.id }, async (evidence) => {
    const hook = await hookFor(fixtureBackend, production);
    const before = (await executions(production.id)).map((item) => item.id);
    const rejected = await fixtureBackend.deliver(hook, true);
    evidence.webhookId = hook.webhook_id;
    evidence.callbackStatus = rejected.status;
    assert.equal(rejected.status, 401);
    await sleep(1000);
    assert.deepEqual((await executions(production.id)).map((item) => item.id), before, 'Rejected requests must not create workflow executions');
  });
  await record('Controlled callback: simultaneous test and production isolation', { workflowId: production.id }, async (evidence) => {
    const productionHook = await hookFor(fixtureBackend, production);
    const run = await client.run(production, 'VideoVector Trigger');
    assert.equal(run.waitingForWebhook, true);
    const testHook = await hookFor(fixtureBackend, production, true);
    assert.notEqual(testHook.webhook_id, productionHook.webhook_id);
    evidence.productionWebhookId = productionHook.webhook_id;
    evidence.testWebhookId = testHook.webhook_id;
    await deliverAndInspect(fixtureBackend, production, testHook, evidence);
    await poll('test subscription cleanup', async () => !(await ownedHooks(fixtureBackend, production)).some((hook) => hook.webhook_id === testHook.webhook_id));
    assert.ok((await ownedHooks(fixtureBackend, production)).some((hook) => hook.webhook_id === productionHook.webhook_id));
    const secondTest = await client.run(production, 'VideoVector Trigger');
    assert.equal(secondTest.waitingForWebhook, true);
    const secondTestHook = await hookFor(fixtureBackend, production, true);
    const repeatedEvidence = {};
    await deliverAndInspect(fixtureBackend, production, secondTestHook, repeatedEvidence);
    evidence.repeatedTestExecutionId = repeatedEvidence.executionId;
    await poll('repeated test subscription cleanup', async () => !(await ownedHooks(fixtureBackend, production)).some((hook) => hook.webhook_id === secondTestHook.webhook_id));
    const productionEvidence = {};
    await deliverAndInspect(fixtureBackend, production, productionHook, productionEvidence);
    evidence.productionExecutionId = productionEvidence.executionId;
  });
} catch (error) {
  cases.push({ name: 'Controlled callback: workflow setup', status: 'failed', workflowId: production?.id, error: error.message });
} finally { await cleanup(fixtureBackend, production); }

let changed;
try {
  changed = await client.createWorkflow(definition('Trigger configuration changes', fixtureBackend.credential));
  await record('Controlled callback: replacing a published trigger removes its old subscription', { workflowId: changed.id }, async (evidence) => {
    await activate(changed);
    const original = await hookFor(fixtureBackend, changed);
    const current = await client.request(`/workflows/${changed.id}`);
    const nodes = current.nodes.map((node) => node.name === 'VideoVector Trigger' ? { ...node, parameters: { ...node.parameters, events: ['export.ready'] } } : node);
    changed = await client.request(`/workflows/${changed.id}`, 'PATCH', { nodes, connections: current.connections, ...(current.checksum ? { expectedChecksum: current.checksum } : {}) });
    await activate(changed);
    const replacement = await poll('updated event subscription', async () => (await ownedHooks(fixtureBackend, changed)).find((hook) => hook.events.includes('export.ready')));
    evidence.previousWebhookId = original.webhook_id;
    evidence.replacementWebhookId = replacement.webhook_id;
    assert.notEqual(replacement.webhook_id, original.webhook_id);
    assert.equal((await ownedHooks(fixtureBackend, changed)).length, 1);
    await deliverAndInspect(fixtureBackend, changed, replacement, evidence);
  });
} catch (error) {
  cases.push({ name: 'Controlled callback: change workflow setup', status: 'failed', workflowId: changed?.id, error: error.message });
} finally { await cleanup(fixtureBackend, changed); }

if (client.state.liveCredential) {
  let liveWorkflow;
  let liveBackend;
  try {
    const key = (await readFile(resolve(packageRoot, '../.local/n8n/api-key'), 'utf8')).trim();
    const api = async (path, method = 'GET') => {
      const response = await fetch(`https://api.vectormethods.com/api/v2${path}`, { method, headers: { 'x-api-key': key, ...(method === 'POST' ? { 'idempotency-key': `n8n-trigger-test-${randomUUID()}` } : {}) } });
      const body = await response.json();
      if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`Live trigger API ${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
      return body;
    };
    liveBackend = {
      name: 'Deployed API callback', credential: client.state.liveCredential,
      list: () => api('/webhooks'),
      remove: (id) => api(`/webhooks/${encodeURIComponent(id)}`, 'DELETE'),
      async deliver(hook) { const result = await api(`/webhooks/${encodeURIComponent(hook.webhook_id)}/test`, 'POST'); return { status: result.status_code, body: result }; },
    };
    liveWorkflow = await client.createWorkflow(definition('Deployed signed webhook', liveBackend.credential));
    await record('Deployed API callback: activate, receive signed test, preserve envelope', { workflowId: liveWorkflow.id }, async (evidence) => {
      await activate(liveWorkflow);
      await deliverAndInspect(liveBackend, liveWorkflow, await hookFor(liveBackend, liveWorkflow), evidence);
    });
  } catch (error) {
    cases.push({ name: 'Deployed API callback: setup', status: 'failed', workflowId: liveWorkflow?.id, error: error.message });
  } finally { if (liveBackend) await cleanup(liveBackend, liveWorkflow); }
}

await mkdir(resolve(packageRoot, '.reports'), { recursive: true });
await writeFile(resolve(packageRoot, '.reports/trigger-discovery.json'), JSON.stringify({ at: new Date().toISOString(), cases }, null, 2));
process.stdout.write(JSON.stringify({ passed: cases.filter((entry) => entry.status === 'passed').length, failed: cases.filter((entry) => entry.status === 'failed').length }) + '\n');
process.exitCode = cases.some((entry) => entry.status === 'failed') ? 1 : 0;
