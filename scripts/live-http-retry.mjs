/** Exercise the shipped HTTP template in the real n8n engine.
 * Uses only local fixture credentials. Run while this harness owns fixture resets.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, output } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const credential = await client.credential('VideoVector · HTTP controlled fixtures', 'httpHeaderAuth', {
  name: 'X-API-Key', value: 'fixture',
});
const template = JSON.parse((await readFile(resolve(root, 'examples/http-process-results.json'), 'utf8'))
  .replaceAll('https://api.vectormethods.com/api/v2', 'http://host.docker.internal:5679/api/v2'));
const cases = [];
const control = async (path, body) => {
  const response = await fetch(`http://localhost:5679/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `Fixture control ${response.status}`);
  return response.json();
};
async function scenario(name, test) {
  const result = { name, started: new Date().toISOString(), status: 'passed' };
  try { await test(result); }
  catch (error) { Object.assign(result, { status: 'failed', error: error.message }); }
  cases.push(result);
  await mkdir(resolve(root, '.reports'), { recursive: true });
  await writeFile(resolve(root, '.reports/live-http-retry.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'shipped HTTP template; real n8n engine; controlled fixture API', cases,
  }, null, 2));
  console.log(JSON.stringify(result));
}
function definition(name, automaticRetry = false) {
  const workflow = structuredClone(template);
  workflow.name = `VideoVector QA · ${name}`;
  for (const node of workflow.nodes) {
    if (node.parameters?.genericAuthType === 'httpHeaderAuth') {
      node.credentials = { httpHeaderAuth: { id: credential.id, name: credential.name } };
    }
    if (node.name === 'Configure') {
      for (const field of node.parameters.assignments.assignments) {
        if (field.name === 'promptId') field.value = 'prompt-fixture';
        if (field.name === 'videoId') field.value = 'video-fixture';
      }
    }
    if (node.name === 'Start Run' && automaticRetry) {
      Object.assign(node, { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 });
    }
  }
  return workflow;
}
const configuredKey = (execution) => output(execution, 'Configure')[0]?.json.requestKey;
function complete(execution) {
  assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
  assert(output(execution, 'Result Items').length > 0, 'The resumed HTTP workflow must deliver its result items');
}
async function reset(name) {
  await control('reset', {
    scenario: name, statusSequence: ['completed'],
    failures: [{ method: 'POST', path: '/workflow/process', occurrence: 1, status: 503, afterCommit: true }],
  });
}
async function evidence(result) {
  const report = await control('report');
  const calls = report.calls.filter((call) => call.method === 'POST' && call.routePath === '/workflow/process');
  result.calls = calls.map(({ occurrence, idempotencyKey, body }) => ({ occurrence, idempotencyKey, body }));
  result.effects = report.effects;
  result.replays = report.replays;
  return { report, calls };
}

await scenario('HTTP Retry Execution reuses the accepted submission; fresh execution creates a new run', async (result) => {
  await reset(result.name);
  const workflow = await client.createWorkflow(definition(result.name));
  result.workflowId = workflow.id;
  const run = await client.run(workflow, 'Manual Trigger');
  result.executionId = run.executionId;
  const first = await client.wait(run.executionId);
  assert.equal(first.status, 'error', 'The first accepted submission loses its response');
  const originalKey = configuredKey(first);
  assert(originalKey, 'Configure must save the submission key before Start Run');
  assert.equal((await control('report')).effects.runs, 1, 'The fixture must accept the original request');

  const retry = await client.request(`/executions/${run.executionId}/retry`, 'POST', { loadWorkflow: false });
  result.retryExecutionId = retry.id;
  result.retryOf = retry.retryOf;
  assert.notEqual(String(retry.id), String(run.executionId), 'Retry Execution uses a different execution ID');
  const retried = await client.wait(retry.id);
  complete(retried);
  assert.equal(configuredKey(retried), originalKey, 'The original Configure output survives execution retry');
  let observed = await evidence(result);
  assert.equal(observed.calls.length, 2);
  assert.equal(observed.calls[0].idempotencyKey, originalKey);
  assert.equal(observed.calls[1].idempotencyKey, originalKey);
  assert.equal(observed.report.effects.runs, 1, 'Retry must recover the accepted run without creating another');
  assert.equal(output(retried, 'Start Run')[0].json.run_id, 'run-1');

  const fresh = await client.run(workflow, 'Manual Trigger');
  result.freshExecutionId = fresh.executionId;
  const next = await client.wait(fresh.executionId);
  complete(next);
  assert.notEqual(configuredKey(next), originalKey, 'A fresh execution must submit a distinct operation');
  observed = await evidence(result);
  assert.equal(observed.calls.length, 3);
  assert.equal(observed.calls[2].idempotencyKey, configuredKey(next));
  assert.equal(observed.report.effects.runs, 2);
});

await scenario('HTTP Retry On Fail recovers a lost submission response with the saved key', async (result) => {
  await reset(result.name);
  const workflow = await client.createWorkflow(definition(result.name, true));
  result.workflowId = workflow.id;
  const run = await client.run(workflow, 'Manual Trigger');
  result.executionId = run.executionId;
  const execution = await client.wait(run.executionId);
  complete(execution);
  const { report, calls } = await evidence(result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, configuredKey(execution));
  assert.equal(calls[1].idempotencyKey, configuredKey(execution));
  assert.equal(report.effects.runs, 1);
});

process.exitCode = cases.some((result) => result.status !== 'passed') ? 1 : 0;
