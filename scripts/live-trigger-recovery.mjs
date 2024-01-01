/**
 * Actual n8n publication persistence and recovery, using controlled API failures.
 * --restart crashes an in-progress publication; --active-restart restarts a
 * successfully published workflow and verifies signed delivery afterwards.
 * n8n 2.42.4 leases publication work for 120 seconds. A crash must wait for the
 * native lease to expire; /activate only records desired state and returns early.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadClient, output } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const crash = process.argv.includes('--restart');
const activeRestart = process.argv.includes('--active-restart');
const result = {
  name: activeRestart ? 'Published trigger survives an n8n restart and receives signed delivery'
    : crash ? 'Lost webhook-create response survives an n8n crash and native publication lease recovery'
      : 'Lost webhook-create response survives a failed activation',
  started: new Date().toISOString(), publicationSnapshots: [],
};
const control = async (path, body) => {
  const response = await fetch(`http://localhost:5679/__control/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return response.json();
};
const activate = async (workflow) => {
  const saved = await client.request(`/workflows/${workflow.id}`);
  return client.request(`/workflows/${workflow.id}/activate`, 'POST', { versionId: saved.versionId, name: 'Recovery acceptance', ...(saved.checksum ? { expectedChecksum: saved.checksum } : {}) });
};
const poll = async (description, inspect, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await inspect();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
let workflow;
let lastSnapshot;
async function publication(phase) {
  const current = await client.request(`/workflows/${workflow.id}`);
  const status = await client.request(`/workflows/${workflow.id}/publication-status`);
  const snapshot = { phase, desiredActive: current.active, desiredVersionId: current.activeVersionId, ...status,
    hasPersistedRegistration: !!current.staticData?.['node:VideoVector Trigger']?.registration?.id };
  const signature = JSON.stringify(snapshot);
  if (signature !== lastSnapshot) {
    result.publicationSnapshots.push({ at: new Date().toISOString(), ...snapshot });
    lastSnapshot = signature;
  }
  return { current, status };
}
async function waitPublished(phase, timeoutMs = 30000) {
  return poll('publication to settle and save registration', async () => {
    const { current, status } = await publication(phase);
    if (status.status === 'published' && !current.staticData?.['node:VideoVector Trigger']?.registration?.id) {
      throw new Error('n8n reports publication complete without persisted trigger registration; unpublish, wait for completion, and publish again');
    }
    return status.status === 'published' && current.staticData?.['node:VideoVector Trigger']?.registration?.id && current;
  }, timeoutMs);
}
async function deliver() {
  const list = async () => {
    const response = await client.request(`/executions?limit=20&filter=${encodeURIComponent(JSON.stringify({ workflowId: workflow.id }))}`);
    return (response.results ?? response).filter((item) => item.workflowId === workflow.id);
  };
  const before = new Set((await list()).map((item) => item.id));
  const hook = (await control('report')).resources.webhooks.find((item) => item.metadata?.n8n_workflow_id === workflow.id);
  assert.ok(hook, 'The published trigger must have a real subscription');
  const response = await control('deliver', { webhookId: hook.webhook_id, event: 'prompt_run.completed', data: { run_id: 'run-recovery' } });
  result.callbackStatus = response.status;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const execution = await poll('a signed callback execution', async () => (await list()).find((item) => !before.has(item.id)));
  const completed = await client.wait(execution.id, { timeoutMs: 30000 });
  result.executionId = execution.id;
  assert.equal(completed.status, 'success', completed.data?.resultData?.error?.message);
  const event = output(completed, 'Inspect Event')[0]?.json;
  assert.equal(event?.id, response.event.id);
  assert.equal(event?._delivery.webhook_id, hook.webhook_id);
}
try {
  await control('reset', { scenario: activeRestart ? 'published-trigger-restart' : 'lost-webhook-create-response', failures: activeRestart ? [] : [
    { method: 'POST', path: '/webhooks', occurrence: 1, status: 503, afterCommit: true },
    { method: 'POST', path: '/webhooks', occurrence: 2, status: 503, repeat: true },
    { method: 'GET', path: '/webhooks', occurrence: 1, status: 503, repeat: true },
  ] });
  const credential = client.state.fixtureCredential;
  workflow = await client.createWorkflow({ name: `VideoVector QA · ${activeRestart ? 'Published trigger restart' : 'Lost webhook create response'}`, nodes: [{
    id: randomUUID(), webhookId: randomUUID(), name: 'VideoVector Trigger',
    type: '@vectormethods/n8n-nodes-videovector.videoVectorTrigger', typeVersion: 1, position: [240, 220],
    parameters: { events: ['prompt_run.completed'], indexIds: [] }, credentials: { videoVectorApi: { id: credential.id, name: credential.name } },
  }, { id: randomUUID(), name: 'Inspect Event', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [520, 220], parameters: {} }],
  connections: { 'VideoVector Trigger': { main: [[{ node: 'Inspect Event', type: 'main', index: 0 }]] } } });
  result.workflowId = workflow.id;
  await activate(workflow);
  const first = await poll('the accepted remote creation', async () => {
    const report = await control('report');
    return report.resources.webhooks.length ? report : undefined;
  });
  assert.equal(first.resources.webhooks.length, 1);
  result.firstWebhookId = first.resources.webhooks[0].webhook_id;
  if (activeRestart) {
    await waitPublished('before-restart');
    await deliver();
    result.executionIdBeforeRestart = result.executionId;
  } else {
    await poll('the failed recovery attempt during the outage', async () => {
      const report = await control('report');
      return report.calls.filter((call) => ['POST', 'GET'].includes(call.method) && call.routePath === '/webhooks').length >= 2;
    });
    const { current } = await publication('outage');
    result.persistedRegistrationAfterFailure = !!current.staticData?.['node:VideoVector Trigger']?.registration;
  }
  if (crash || activeRestart) {
    result.restartStarted = new Date().toISOString();
    result.lifecycleCallsBeforeRestart = (await control('report')).calls.length;
    // One second deliberately interrupts in-flight work; normal published
    // restart uses Docker's normal graceful shutdown deadline.
    await promisify(execFile)('docker', ['restart', ...(crash ? ['--timeout', '1'] : []), 'videovector-n8n']);
    await poll('the n8n editor API after restart', async () => {
      try { await client.login(); return true; }
      catch { return false; }
    });
    result.restarted = true;
    await publication('after-restart');
  }
  await control('config', { failures: [] });
  if (!activeRestart) await activate(workflow);
  await waitPublished(crash ? 'recovering-native-publication-lease' : 'ready', crash ? 180000 : 30000);
  result.recoveredAt = new Date().toISOString();
  const second = await control('report');
  result.webhookIdsAfterRetry = second.resources.webhooks.map((hook) => hook.webhook_id);
  result.createKeys = second.calls.filter((call) => call.method === 'POST' && call.routePath === '/webhooks').map((call) => call.idempotencyKey);
  result.creates = second.effects.webhooks;
  result.replays = second.replays.length;
  assert.equal(second.resources.webhooks.length, 1, 'Recovery must leave exactly one actual subscription');
  assert.equal(new Set(result.createKeys).size, 1, 'Reconstructed native state must retain the same idempotent registration identity');
  result.recoveredOriginal = second.resources.webhooks[0].webhook_id === result.firstWebhookId;
  await deliver();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error.message;
} finally {
  if (workflow) {
    try {
      await control('config', { failures: [] });
      await client.request(`/test-webhook/${workflow.id}`, 'DELETE');
      const current = await client.request(`/workflows/${workflow.id}`);
      await client.request(`/workflows/${workflow.id}/deactivate`, 'POST', current.checksum ? { expectedChecksum: current.checksum } : {});
      await poll('native publication and subscription cleanup', async () => {
        const { status } = await publication('cleanup');
        return status.status === 'not_published' && !(await control('report')).resources.webhooks.some((hook) => hook.metadata?.n8n_workflow_id === workflow.id);
      }, crash ? 180000 : 30000);
    } catch (error) { result.cleanupError = error.message; }
    const report = await control('report');
    const leftovers = report.resources.webhooks.filter((hook) => hook.metadata?.n8n_workflow_id === workflow.id);
    result.leftoversAfterNativeCleanup = leftovers.map((hook) => hook.webhook_id);
    if (leftovers.length || result.cleanupError) result.status = 'failed';
    for (const hook of leftovers) {
      const cleanup = await fetch(`http://localhost:5679/api/v2/webhooks/${encodeURIComponent(hook.webhook_id)}`, { method: 'DELETE', headers: { 'x-api-key': 'fixture' } });
      if (![200, 404].includes(cleanup.status)) result.cleanupError = `Cleanup failed for ${hook.webhook_id}: ${cleanup.status}`;
    }
  }
}
await mkdir(resolve(root, '.reports'), { recursive: true });
await writeFile(resolve(root, `.reports/trigger-${activeRestart ? 'persistence' : crash ? 'restart' : 'recovery'}-discovery.json`), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.status === 'failed' || result.cleanupError ? 1 : 0;
