/**
 * Actual n8n editor lifecycle + HTTPS callback acceptance. Run after installation:
 *   node scripts/live-trigger.mjs
 * Requires live-test.mjs bootstrap, fixture-server.mjs, and public N8N_WEBHOOK_URL.
 * Runs fixture cases first, then deployed-API cases when a live credential exists.
 * --live-only skips controlled fixtures; --restart-only runs the published
 * restart case (coordinate the container restart with other live workflows).
 * N8N_RESTART_WAIT_EXECUTION_ID optionally verifies a shared execution is waiting
 * immediately before interruption and records its durable-wait metadata.
 * Do not run alongside live-cases.mjs: both deliberately reset fixture state.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, output } from './live-test.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const cases = [];
const liveOnly = process.argv.includes('--live-only');
const restartOnly = process.argv.includes('--restart-only');
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

async function runLifecycle(backend) {
  let production;
  try {
    production = await client.createWorkflow(definition('Signed callbacks and isolation', backend.credential));
    await record(`${backend.name}: activate subscription`, { workflowId: production.id }, async (evidence) => {
      await activate(production);
      const hook = await hookFor(backend, production);
      evidence.webhookId = hook.webhook_id;
      assert.ok(hook.url.startsWith('https://'), 'Use the real public HTTPS ingress');
    });
    await record(`${backend.name}: signed production delivery`, { workflowId: production.id }, async (evidence) => deliverAndInspect(backend, production, await hookFor(backend, production), evidence));
    if (restartOnly) {
      await record(`${backend.name}: published trigger survives restart and signed delivery`, { workflowId: production.id }, async (evidence) => {
        const before = await hookFor(backend, production);
        await poll('completed trigger publication', async () => (await client.request(`/workflows/${production.id}/publication-status`)).status === 'published');
        const saved = await client.request(`/workflows/${production.id}`);
        assert.equal(saved.staticData?.['node:VideoVector Trigger']?.registration?.id, before.webhook_id);
        if (process.env.N8N_RESTART_WAIT_EXECUTION_ID) {
          const waiting = await client.execution(process.env.N8N_RESTART_WAIT_EXECUTION_ID);
          evidence.sharedWaitingExecution = {
            capturedAt: new Date().toISOString(), executionId: waiting.id,
            status: waiting.status, waitTill: waiting.waitTill,
          };
          assert.equal(waiting.status, 'waiting', 'The shared execution must still be waiting immediately before restart');
        }
        evidence.restartStarted = new Date().toISOString();
        await promisify(execFile)('docker', ['restart', 'videovector-n8n']);
        await poll('n8n editor readiness after restart', async () => {
          try { await client.login(); return true; } catch { return false; }
        });
        const restored = await client.request(`/workflows/${production.id}`);
        assert.equal(restored.staticData?.['node:VideoVector Trigger']?.registration?.id, before.webhook_id);
        evidence.publication = await client.request(`/workflows/${production.id}/publication-status`);
        assert.equal(evidence.publication.status, 'published');
        assert.equal((await ownedHooks(backend, production)).length, 1);
        await deliverAndInspect(backend, production, before, evidence);
      });
      return;
    }
    await record(`${backend.name}: tampered signature is rejected`, { workflowId: production.id }, async (evidence) => {
      const hook = await hookFor(backend, production);
      const before = (await executions(production.id)).map((item) => item.id);
      const rejected = await backend.deliver(hook, true);
      evidence.webhookId = hook.webhook_id;
      evidence.callbackStatus = rejected.status;
      assert.equal(rejected.status, 401);
      await sleep(1000);
      assert.deepEqual((await executions(production.id)).map((item) => item.id), before, 'Rejected requests must not create workflow executions');
    });
    await record(`${backend.name}: simultaneous test and production isolation`, { workflowId: production.id }, async (evidence) => {
      const productionHook = await hookFor(backend, production);
      const run = await client.run(production, 'VideoVector Trigger');
      assert.equal(run.waitingForWebhook, true);
      const testHook = await hookFor(backend, production, true);
      assert.notEqual(testHook.webhook_id, productionHook.webhook_id);
      evidence.productionWebhookId = productionHook.webhook_id;
      evidence.testWebhookId = testHook.webhook_id;
      await deliverAndInspect(backend, production, testHook, evidence);
      await poll('test subscription cleanup', async () => !(await ownedHooks(backend, production)).some((hook) => hook.webhook_id === testHook.webhook_id));
      assert.ok((await ownedHooks(backend, production)).some((hook) => hook.webhook_id === productionHook.webhook_id));
      const secondTest = await client.run(production, 'VideoVector Trigger');
      assert.equal(secondTest.waitingForWebhook, true);
      const secondTestHook = await hookFor(backend, production, true);
      const repeatedEvidence = {};
      await deliverAndInspect(backend, production, secondTestHook, repeatedEvidence);
      evidence.repeatedTestExecutionId = repeatedEvidence.executionId;
      await poll('repeated test subscription cleanup', async () => !(await ownedHooks(backend, production)).some((hook) => hook.webhook_id === secondTestHook.webhook_id));
      const productionEvidence = {};
      await deliverAndInspect(backend, production, productionHook, productionEvidence);
      evidence.productionExecutionId = productionEvidence.executionId;
    });
  } catch (error) {
    cases.push({ name: `${backend.name}: workflow setup`, status: 'failed', workflowId: production?.id, error: error.message });
  } finally { await cleanup(backend, production); }

  let changed;
  try {
    changed = await client.createWorkflow(definition('Trigger configuration changes', backend.credential));
    await record(`${backend.name}: replacing a published trigger removes its old subscription`, { workflowId: changed.id }, async (evidence) => {
      await activate(changed);
      const original = await hookFor(backend, changed);
      const current = await client.request(`/workflows/${changed.id}`);
      const nodes = current.nodes.map((node) => node.name === 'VideoVector Trigger' ? { ...node, parameters: { ...node.parameters, events: ['export.ready'] } } : node);
      changed = await client.request(`/workflows/${changed.id}`, 'PATCH', { nodes, connections: current.connections, ...(current.checksum ? { expectedChecksum: current.checksum } : {}) });
      await activate(changed);
      const replacement = await poll('updated event subscription', async () => (await ownedHooks(backend, changed)).find((hook) => hook.events.includes('export.ready')));
      evidence.previousWebhookId = original.webhook_id;
      evidence.replacementWebhookId = replacement.webhook_id;
      assert.notEqual(replacement.webhook_id, original.webhook_id);
      assert.equal((await ownedHooks(backend, changed)).length, 1);
      await deliverAndInspect(backend, changed, replacement, evidence);
    });
  } catch (error) {
    cases.push({ name: `${backend.name}: change workflow setup`, status: 'failed', workflowId: changed?.id, error: error.message });
  } finally { await cleanup(backend, changed); }

}

if (!liveOnly) {
  await control('reset', { scenario: 'trigger-lifecycle' });
  await runLifecycle(fixtureBackend);
}

if (client.state.liveCredential) {
  try {
    assert.ok(client.state.httpCredential, 'Configure the authorized n8n HTTP credential before running deployed trigger checks');
    // Management calls execute inside n8n so the API key remains in its existing
    // credential store. A single dedicated draft workflow is reused for calls.
    const driver = await client.createWorkflow({
      name: 'VideoVector QA · Deployed webhook test driver',
      nodes: [
        { id: randomUUID(), name: 'Request', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 200], parameters: {} },
        { id: randomUUID(), name: 'Webhook API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [300, 200],
          parameters: {
            method: '={{ $json.method }}', url: "={{ 'https://api.vectormethods.com/api/v2' + $json.path }}",
            authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
            sendHeaders: true, headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.requestKey }}' }] },
            options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
          }, credentials: { httpHeaderAuth: { id: client.state.httpCredential.id, name: client.state.httpCredential.name } } },
      ], connections: { Request: { main: [[{ node: 'Webhook API', type: 'main', index: 0 }]] } },
    });
    const managementCalls = [];
    const api = async (path, method = 'GET') => {
      await client.request(`/workflows/${driver.id}`, 'PATCH', { pinData: { Request: [{ json: { path, method, requestKey: `n8n-trigger-test-${randomUUID()}` } }] } });
      const run = await client.run(driver, 'Request');
      const execution = await client.wait(run.executionId, { timeoutMs: 45000 });
      assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
      const response = output(execution, 'Webhook API')[0]?.json;
      const status = Number(response?.statusCode);
      managementCalls.push({ method, path, executionId: run.executionId, status });
      if (!(status >= 200 && status < 300) && !(method === 'DELETE' && status === 404)) {
        throw new Error(`Live trigger API ${method} ${path}: ${status} ${response?.body?.message ?? response?.body?.error?.message ?? ''}`);
      }
      return response.body;
    };
    const liveBackend = {
      name: 'Deployed API callback', credential: client.state.liveCredential,
      list: () => api('/webhooks'),
      remove: (id) => api(`/webhooks/${encodeURIComponent(id)}`, 'DELETE'),
      async deliver(hook, invalidSignature = false) {
        if (invalidSignature) {
          // Send only a deliberate invalid signature to this dedicated callback;
          // API credentials and real signing secrets never leave their owner.
          const response = await fetch(hook.url, { method: 'POST', headers: {
            'content-type': 'application/json', 'x-webhook-id': hook.webhook_id,
            'x-webhook-signature': `sha256=${'0'.repeat(64)}`,
          }, body: '{}' });
          return { status: response.status };
        }
        const result = await api(`/webhooks/${encodeURIComponent(hook.webhook_id)}/test`, 'POST');
        return { status: result.status_code, body: result };
      },
    };
    const supported = await api('/webhooks/events');
    assert.ok(supported.includes('prompt_run.completed'));
    assert.ok(supported.includes('export.ready'));
    const existing = await liveBackend.list();
    await runLifecycle(liveBackend);
    await writeFile(resolve(packageRoot, `.reports/deployed-trigger${restartOnly ? '-persistence' : ''}-management.json`), JSON.stringify({ workflowId: driver.id, calls: managementCalls }, null, 2));
    await record('Deployed API callback: existing subscriptions are unchanged', { existingSubscriptionCount: existing.length }, async () => {
      const after = await liveBackend.list();
      for (const before of existing) {
        const current = after.find((hook) => hook.webhook_id === before.webhook_id);
        assert.ok(current, `Existing subscription ${before.webhook_id} was unexpectedly removed`);
        assert.deepEqual({ url: current.url, events: current.events, index_ids: current.index_ids, metadata: current.metadata },
          { url: before.url, events: before.events, index_ids: before.index_ids, metadata: before.metadata });
      }
    });
  } catch (error) {
    cases.push({ name: 'Deployed API callback: setup', status: 'failed', error: error.message });
  }
} else if (liveOnly) {
  cases.push({ name: 'Deployed API callback: live credential is configured', status: 'failed', error: 'Run the authorized live credential setup before this suite.' });
}

await mkdir(resolve(packageRoot, '.reports'), { recursive: true });
await writeFile(resolve(packageRoot, `.reports/${liveOnly ? (restartOnly ? 'deployed-trigger-persistence' : 'deployed-trigger') : 'trigger-discovery'}.json`), JSON.stringify({ at: new Date().toISOString(), cases }, null, 2));
process.stdout.write(JSON.stringify({ passed: cases.filter((entry) => entry.status === 'passed').length, failed: cases.filter((entry) => entry.status === 'failed').length }) + '\n');
process.exitCode = cases.some((entry) => entry.status === 'failed') ? 1 : 0;
