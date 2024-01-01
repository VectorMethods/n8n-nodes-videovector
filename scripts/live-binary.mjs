/** Real n8n binary-manager and import-outcome discovery against controlled API responses.
 * Fixture scenarios prove consumer behavior, not deployed backend behavior.
 * Run only while no other harness owns the shared fixture reset endpoint.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, action, workflow, output, runCase } from './live-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await loadClient();
await client.login();
const credential = client.state.fixtureCredential;
assert(credential, 'Bootstrap the controlled fixture credential first');
const sample = await readFile(resolve(root, '../.local/n8n/fixtures/sample.mp4'));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const sampleDigest = digest(sample);
const id = (value) => ({ __rl: true, mode: 'id', value });
const cases = [];
const control = async (path, body) => {
  const response = await fetch(`http://localhost:5679/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return response.json();
};
const native = (name, parameters) => action(name, {
  additionalFields: {}, fullResponse: false, idempotencyKey: '', ...parameters,
}, credential);
const upload = () => native('Upload Media', { resource: 'media', operation: 'upload', binaryProperty: 'data', destination: 'playground' });
const requireSuccess = (execution) => assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message || `Execution ${execution.id}: ${execution.status}`);
const binaryMetadata = (item) => item?.binary?.data && ({
  fileName: item.binary.data.fileName, mimeType: item.binary.data.mimeType,
  fileSize: item.binary.data.fileSize, fileExtension: item.binary.data.fileExtension,
  stored: !!item.binary.data.id,
});
async function save() {
  await mkdir(resolve(root, '.reports'), { recursive: true });
  await writeFile(resolve(root, '.reports/live-binary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), environment: 'official n8n Docker; controlled fixture API; filesystem binary manager',
    sample: { bytes: sample.length, sha256: sampleDigest },
    totals: { passed: cases.filter((entry) => entry.status === 'passed').length, failed: cases.filter((entry) => entry.status === 'failed').length }, cases,
  }, null, 2));
}
async function scenario(name, config, definition, inspect) {
  let evidence = {};
  try {
    await control('reset', { scenario: name, ...config });
    const result = await runCase(client, name, definition, async (execution) => {
      await inspect(execution, evidence);
    });
    const report = await control('report');
    cases.push({ ...result, evidence: { ...evidence, uploads: report.uploads, downloads: report.downloads,
      effects: report.effects, calls: report.calls.map(({ method, path, occurrence, bytes }) => ({ method, path, occurrence, bytes })) } });
  } catch (error) {
    cases.push({ name, status: 'failed', phase: 'harness', error: error.message, evidence });
  }
  await save();
  process.stdout.write(`${name}: ${cases.at(-1).status}${cases.at(-1).error ? ` — ${cases.at(-1).error}` : ''}\n`);
}
const fetchMedia = {
  id: randomUUID(), name: 'Fetch Media', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [240, 220],
  parameters: { url: 'http://host.docker.internal:5679/sample.mp4', options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } },
};
await scenario('Stored mp4 upload preserves bytes and filename', {}, workflow('Stored mp4 upload', [fetchMedia, upload()]), async (execution, evidence) => {
  evidence.source = binaryMetadata(output(execution, 'Fetch Media')[0]);
  requireSuccess(execution);
  assert(evidence.source?.stored, 'HTTP Request must use the n8n filesystem binary manager');
  const report = await control('report');
  assert.equal(report.uploads.length, 1);
  assert.equal(report.uploads[0].sha256, sampleDigest);
  assert.equal(report.uploads[0].bytes, sample.length);
  assert.equal(report.uploads[0].filename, 'sample.mp4');
  assert.equal(report.uploads[0].mimeType, 'video/mp4');
  assert(output(execution, 'Upload Media')[0]?.json.video?.video_id);
});
const inline = {
  id: randomUUID(), name: 'Inline Media', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 220],
  parameters: { mode: 'runOnceForAllItems', jsCode: `return [{json:{source:'inline fixture'},binary:{data:{data:${JSON.stringify(sample.toString('base64'))},mimeType:'video/mp4',fileName:'inline.mp4',fileExtension:'mp4'}}}];` },
};
await scenario('Inline mp4 upload preserves bytes and MIME type', {}, workflow('Inline mp4 upload', [inline, upload()]), async (execution, evidence) => {
  evidence.source = binaryMetadata(output(execution, 'Inline Media')[0]);
  requireSuccess(execution);
  assert.equal(evidence.source?.stored, false, 'Code source should exercise inline base64');
  const report = await control('report');
  assert.equal(report.uploads.length, 1);
  assert.equal(report.uploads[0].sha256, sampleDigest);
  assert.equal(report.uploads[0].filename, 'inline.mp4');
  assert.equal(report.uploads[0].mimeType, 'video/mp4');
});
for (const resource of ['media', 'export']) {
  const filename = resource === 'media' ? 'downloaded.mp4' : 'extracted.json';
  const mimeType = resource === 'media' ? 'video/mp4' : 'application/json';
  const payload = resource === 'media' ? sample : Buffer.from('{"summary":"controlled export bytes"}\n');
  const parameters = { resource, operation: 'download', outputBinaryProperty: 'data',
    ...(resource === 'media' ? { videoId: id('video-fixture') } : { exportId: 'export-fixture' }) };
  await scenario(`${resource} download stores bytes without leaking API credentials`, {
    download: { base64: payload.toString('base64'), filename, mimeType },
  }, workflow(`${resource} download and byte verification`, [native('Download', parameters), upload()]), async (execution, evidence) => {
    evidence.download = binaryMetadata(output(execution, 'Download')[0]);
    evidence.identity = output(execution, 'Download')[0]?.json;
    requireSuccess(execution);
    assert(evidence.download?.stored, 'Download must use managed binary storage');
    assert.equal(evidence.download.fileName, filename);
    assert.equal(evidence.download.mimeType, mimeType);
    const report = await control('report');
    assert.equal(report.downloads.length, 1);
    assert.equal(report.downloads[0].apiKeyPresent, false);
    assert.equal(report.downloads[0].authorizationPresent, false);
    assert.equal(report.uploads[0].sha256, digest(payload));
    assert.equal(report.uploads[0].bytes, payload.length);
    assert.equal(report.uploads[0].filename, filename);
  });
}
const partialImport = {
  job_id: 'job-1', status: 'completed', source_kind: 'attachments', video_ids: ['video-fixture'],
  progress: { total_files: 2, imported: 1, failed: 1, skipped: 0, bytes_transferred: sample.length },
  failed_files: [{ path: 'failed.mp4', error: 'Controlled source unavailable' }], skipped_files: [],
};
const failedImport = {
  ...partialImport, status: 'failed', video_ids: [], error_message: 'All sources failed',
  progress: { total_files: 2, imported: 0, failed: 2, skipped: 0, bytes_transferred: 0 },
};
const importResponse = (body) => ({ failures: [{ method: 'GET', path: '/import-jobs/job-1', status: 200, body, repeat: true }] });
await scenario('Partial import files retain successful media and failure details', importResponse(partialImport), workflow('Partial import files', [native('Imported Files', { resource: 'import', operation: 'files', jobId: 'job-1' })]), async (execution, evidence) => {
  requireSuccess(execution);
  const items = output(execution, 'Imported Files');
  evidence.items = items.map((item) => item.json);
  assert.equal(items.length, 1);
  assert.equal(items[0].json.video_id, 'video-fixture');
  assert.equal(items[0].json._videovector.job_id, 'job-1');
  assert.equal(items[0].json._videovector.progress.failed, 1);
  assert.deepEqual(items[0].json._videovector.failed_files, partialImport.failed_files);
});
await scenario('Failed import full response preserves identity and source failures', importResponse(failedImport), workflow('Failed import details', [native('Import Details', { resource: 'import', operation: 'files', jobId: 'job-1', fullResponse: true })]), async (execution, evidence) => {
  requireSuccess(execution);
  evidence.job = output(execution, 'Import Details')[0]?.json;
  assert.deepEqual(evidence.job, failedImport);
  const report = await control('report');
  assert.equal(report.counts['POST /videos/batch'], undefined);
});
for (const [label, job, expected] of [['partial', partialImport, 'success'], ['failed', failedImport, 'error']]) {
  const definition = JSON.parse(await readFile(resolve(root, 'examples/native-url-import-process-results.json'), 'utf8'));
  definition.name = `VideoVector QA · Native URL template ${label} import`;
  definition.nodes.find((node) => node.name === 'Manual Trigger').name = 'Start';
  definition.connections.Start = definition.connections['Manual Trigger']; delete definition.connections['Manual Trigger'];
  for (const node of definition.nodes) {
    if (node.type.startsWith('@vectormethods/n8n-nodes-videovector.')) node.credentials = { videoVectorApi: { id: credential.id, name: credential.name } };
    if (node.name === 'Configure') for (const assignment of node.parameters.assignments.assignments) {
      if (assignment.name === 'promptId') assignment.value = 'prompt-fixture';
      if (assignment.name === 'mediaUrl') assignment.value = 'https://example.com/controlled-fixture.mp4';
    }
  }
  await scenario(`Native URL template handles ${label} import`, { ...importResponse(job), statusSequence: ['completed'] }, definition, async (execution, evidence) => {
    evidence.import = output(execution, 'Import Media')[0]?.json;
    evidence.branch = output(execution, 'Import Partial Completion')[0]?.json?.import_outcome;
    evidence.error = execution.data?.resultData?.error?.message;
    assert.equal(execution.status, expected, evidence.error || `Unexpected ${label} import status`);
    const report = await control('report');
    if (label === 'partial') {
      assert(evidence.branch?.includes('partial'));
      const submit = report.calls.find((call) => call.method === 'POST' && call.routePath === '/workflow/process');
      assert.deepEqual(submit.body.video_ids, partialImport.video_ids);
      assert(output(execution, 'Get Results').length > 0);
    } else {
      assert.match(evidence.error, /job-1/);
      assert.equal(report.counts['POST /workflow/process'], undefined, 'Failed import must not start a run');
    }
  });
}
await save();
console.log(JSON.stringify({ passed: cases.filter((entry) => entry.status === 'passed').length, failed: cases.filter((entry) => entry.status === 'failed').length }));
process.exitCode = cases.some((entry) => entry.status === 'failed') ? 1 : 0;
