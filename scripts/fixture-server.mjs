/**
 * Controlled-response API for real n8n execution tests, never live-service evidence.
 *
 * Run: node scripts/fixture-server.mjs [port] (default 5679; bind 0.0.0.0).
 * Credentials: API key `fixture`, base URL http://host.docker.internal:5679/api/v2.
 * `fixture-readonly` rejects mutations; every other non-fixture key is unauthorized.
 *
 * POST /__control/reset config: resets all calls/resources and installs config.
 * POST /__control/config config: merges config without clearing resources.
 * GET /__control/report: sanitized calls, idempotency replays, created resources,
 *                       upload hashes/filenames, download auth-leak observations.
 * POST /__control/deliver {webhookId,event?,data?,invalidSignature?}: signs and sends
 *                       a real HTTP callback to that registered n8n webhook URL.
 *
 * Config fields:
 *   failures: [{method:'POST',path:'/workflow/process',occurrence:2,status:503,
 *               body?:{...},headers?:{...},repeat?:false,afterCommit?:false}]
 *   statusSequence: ['processing','completed'] (last status repeats per run)
 *   selection: 'available' | 'empty' | 'unavailable'
 *   resultPages: {unfiltered: [[row1],[row2],[row3]], filtered: [[row1]]}
 *   searchPages: [[row1],[row2]]
 *   download: {base64, filename, mimeType}
 * Path in failures can be relative to /api/v2 or include /api/v2; query excluded.
 * report.calls.path includes /api/v2; routePath omits it. counts uses routePath.
 * occurrence counts matching requests including failed attempts and replays.
 * Default results deliberately finish the filtered stream before the unfiltered
 * stream so real node execution tests expose accidentally restarted cursors.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const row = (id) => ({ video_id: 'video-fixture', segment_id: `segment-${id}`, result: { title: `Fixture ${id}` } });
const defaults = () => ({
  scenario: 'controlled-responses', failures: [], statusSequence: ['processing', 'completed'],
  selection: 'available', resultPages: { unfiltered: [[row(1)], [row(2)], [row(3)]], filtered: [[row(1)]] },
  searchPages: [[{ ...row(1), score: 0.9 }], [{ ...row(2), score: 0.8 }]],
});
const digest = (data) => createHash('sha256').update(data).digest('hex');
const withoutSecret = ({ secret: _secret, ...rest }) => rest;
const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !/^(secret|apiKey|api_key|authorization|password)$/i.test(name)).map(([name, item]) => [name, redact(item)]));
  return value;
};

export function createFixtureServer(initialConfig = {}) {
  const state = {};
  const reset = (config = {}) => Object.assign(state, {
    config: { ...defaults(), ...config }, calls: [], counts: {}, resources: { indexes: [], media: [], runs: [], webhooks: [], prompts: [], exports: [], imports: [] },
    effects: {}, receipts: new Map(), replays: [], appliedFailures: new Set(), statusReads: {}, uploads: [], downloads: [],
  });
  reset(initialConfig);
  const report = () => ({
    scenario: state.config.scenario, calls: state.calls, counts: state.counts,
    effects: state.effects, replays: state.replays, uploads: state.uploads, downloads: state.downloads,
    resources: Object.fromEntries(Object.entries(state.resources).map(([name, values]) => [name, values.map(withoutSecret)])),
  });
  const create = (type, body, prefix) => {
    state.effects[type] = (state.effects[type] ?? 0) + 1;
    const value = { ...body, [`${prefix}_id`]: `${prefix}-${state.effects[type]}` };
    state.resources[type].push(value);
    return value;
  };
  const page = (pages, cursor, stream = 'page') => {
    const offset = cursor ? Number(cursor.slice(cursor.lastIndexOf(':') + 1)) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= Math.max(pages.length, 1)) return { error: 'invalid_cursor' };
    const hasMore = offset + 1 < pages.length;
    return { data: pages[offset] ?? [], pagination: { has_more: hasMore, next_cursor: hasMore ? `${stream}:${offset + 1}` : null, total: pages.flat().length } };
  };
  const advanceStatus = (id) => {
    const count = state.statusReads[id] ?? 0;
    state.statusReads[id] = count + 1;
    const sequence = state.config.statusSequence;
    return sequence[Math.min(count, sequence.length - 1)] ?? 'completed';
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = {};
    if (raw.length && String(request.headers['content-type']).includes('application/json')) {
      try { body = JSON.parse(raw.toString('utf8')); }
      catch { response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_json"}'); return; }
    }
    const json = (status, value, extraHeaders = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `fixture-request-${state.calls.length}`, ...extraHeaders });
      response.end(status === 204 ? undefined : JSON.stringify(value));
    };
    const fail = (status, code, message) => json(status, { error: { code, message }, request_id: `fixture-request-${state.calls.length}` });
    try {
      if (pathname === '/sample.mp4' && request.method === 'GET') {
        try {
          const bytes = await readFile(new URL('../../.local/n8n/fixtures/sample.mp4', import.meta.url));
          response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length, 'content-disposition': 'attachment; filename="sample.mp4"' }).end(bytes);
        } catch { fail(404, 'fixture_asset_missing', 'Create .local/n8n/fixtures/sample.mp4 before running live binary workflows'); }
        return;
      }
      if (pathname === '/__control/reset' && request.method === 'POST') { reset(body); json(200, { reset: true }); return; }
      if (pathname === '/__control/config' && request.method === 'POST') { Object.assign(state.config, body); json(200, { configured: true }); return; }
      if (pathname === '/__control/report' && request.method === 'GET') { json(200, report()); return; }
      if (pathname === '/__control/deliver' && request.method === 'POST') {
        const hook = state.resources.webhooks.find((item) => item.webhook_id === body.webhookId);
        if (!hook) { fail(404, 'resource_webhook_not_found', 'Fixture subscription does not exist'); return; }
        const payload = { id: `evt-fixture-${Date.now()}`, event: body.event ?? hook.events[0], data: body.data ?? { run_id: 'run-1' }, api_version: '2024-01', created_at: new Date().toISOString() };
        const serialized = JSON.stringify(payload);
        const signature = body.invalidSignature ? '0'.repeat(64) : createHmac('sha256', hook.secret).update(serialized).digest('hex');
        const delivered = await fetch(hook.url, { method: 'POST', redirect: 'manual', headers: {
          'content-type': 'application/json', 'x-webhook-signature': `sha256=${signature}`, 'x-webhook-id': hook.webhook_id,
          'x-delivery-id': payload.id, 'idempotency-key': payload.id, 'ngrok-skip-browser-warning': 'true',
        }, body: serialized, signal: AbortSignal.timeout(15000) });
        json(200, { status: delivered.status, body: await delivered.text(), event: payload });
        return;
      }
      if (pathname.startsWith('/__download/')) {
        state.downloads.push({ path: pathname, apiKeyPresent: !!request.headers['x-api-key'], authorizationPresent: !!request.headers.authorization });
        if (url.searchParams.get('signature') !== 'fixture-download') { fail(403, 'signature_invalid', 'Invalid fixture download signature'); return; }
        const download = state.config.download ?? {};
        const bytes = download.base64 ? Buffer.from(download.base64, 'base64') : Buffer.from('VideoVector fixture binary\n');
        response.writeHead(200, { 'content-type': download.mimeType ?? 'application/octet-stream', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${download.filename ?? 'fixture.bin'}"` }).end(bytes);
        return;
      }
      if (!pathname.startsWith('/api/v2/')) { fail(404, 'fixture_route_unknown', `No fixture route ${pathname}`); return; }
      const path = pathname.slice('/api/v2'.length);
      const method = request.method;
      const identity = `${method} ${path}`;
      const occurrence = state.counts[identity] = (state.counts[identity] ?? 0) + 1;
      const key = request.headers['idempotency-key'];
      const call = { method, path: pathname, routePath: path, query: Object.fromEntries(url.searchParams), idempotencyKey: key ?? null, key: key ?? null, occurrence, bytes: raw.length, body: redact(body) };
      state.calls.push(call);
      const apiKey = request.headers['x-api-key'];
      if (path !== '/webhooks/events' && !['fixture', 'fixture-key', 'fixture-readonly'].includes(apiKey)) { fail(401, 'authentication_invalid_api_key', 'The fixture API key is invalid'); return; }
      if (apiKey === 'fixture-readonly' && !['GET', 'HEAD'].includes(method)) { fail(403, 'authorization_insufficient_scope', 'This operation requires write or admin scope'); return; }
      for (const [index, rule] of state.config.failures.entries()) {
        if (!rule.afterCommit && (!state.appliedFailures.has(index) || rule.repeat) && method === rule.method && (path === rule.path || pathname === rule.path) && occurrence >= (rule.occurrence ?? 1)) {
          state.appliedFailures.add(index);
          json(rule.status ?? 503, rule.body ?? { error: { code: 'fixture_injected_failure', message: 'Controlled failure for n8n acceptance' } }, rule.headers);
          return;
        }
      }
      if (path === '/auth/validate' && method === 'GET') { json(204); return; }
      // Compare content for JSON requests; native multipart gets a new boundary on
      // each retry, so compare the decoded fields and file bytes below instead.
      let upload;
      if (path === '/workflow/upload' && method === 'POST') {
        const form = await new Request('http://fixture/upload', { method: 'POST', body: raw, headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') { fail(422, 'fixture_upload_missing_file', 'A multipart file is required'); return; }
        const bytes = Buffer.from(await file.arrayBuffer());
        upload = { filename: file.name, mimeType: file.type, bytes: bytes.length, sha256: digest(bytes), fields: Object.fromEntries([...form].filter(([name]) => name !== 'file')) };
        call.body = upload;
      }
      const receiptId = key && !['GET', 'HEAD', 'DELETE'].includes(method) ? `${identity} ${key}` : undefined;
      const payloadHash = digest(JSON.stringify(upload ?? body));
      const previous = receiptId ? state.receipts.get(receiptId) : undefined;
      // Webhook creation is SERVICE-owned: the row, not a generic response
      // receipt, is authoritative. Deleting it permits recreation under the
      // same key-scoped ID with a fresh secret (matching the deployed API).
      const deletedWebhook = previous && path === '/webhooks' && !state.resources.webhooks.some((hook) => hook.webhook_id === previous.body.webhook_id);
      if (previous && !deletedWebhook) {
        if (previous.hash !== payloadHash) { fail(409, 'idempotency_request_mismatch', 'The idempotency key was reused with different request content'); return; }
        state.replays.push({ method, path, key, occurrence });
        json(previous.status, previous.body);
        return;
      }
      const success = (value, status = 200) => {
        if (receiptId) state.receipts.set(receiptId, { hash: payloadHash, body: value, status });
        for (const [index, rule] of state.config.failures.entries()) {
          if (rule.afterCommit && (!state.appliedFailures.has(index) || rule.repeat) && method === rule.method && (path === rule.path || pathname === rule.path) && occurrence >= (rule.occurrence ?? 1)) {
            state.appliedFailures.add(index);
            json(rule.status ?? 503, rule.body ?? { error: { code: 'fixture_response_lost', message: 'The resource was created, but its response was lost' } }, rule.headers);
            return;
          }
        }
        json(status, value);
      };
      const downloadUrl = (id) => `${url.origin}/__download/${encodeURIComponent(id)}?signature=fixture-download`;
      let match;
      if (path === '/indexes' && method === 'POST') { success(create('indexes', { ...body, video_count: 0 }, 'index'), 201); return; }
      if (path === '/indexes' && method === 'GET') { success(state.resources.indexes); return; }
      if ((match = path.match(/^\/indexes\/([^/]+)$/))) {
        if (method === 'DELETE') { state.resources.indexes = state.resources.indexes.filter((item) => item.index_id !== match[1]); success({ index_id: match[1], deletion_id: `deletion-${match[1]}`, status: 'deleted' }); return; }
        success(state.resources.indexes.find((item) => item.index_id === match[1]) ?? { index_id: match[1], name: 'Fixture index', video_count: 1 }); return;
      }
      if (path === '/workflow/upload' && method === 'POST') {
        state.uploads.push(upload);
        const video = create('media', { index_id: upload.fields.index_id ?? 'index-fixture', title: upload.filename, filename: upload.filename, status: 'ready', media_type: 'video', message: 'Fixture upload complete', video_uri: 'fixture://media' }, 'video');
        success({ video, destination: { type: 'index', index_id: video.index_id, index_created: false } }, 201); return;
      }
      if (path === '/workflow/define' && method === 'POST') {
        const prompt = create('prompts', { name: 'Fixture extraction', ...body, status: 'ready' }, 'prompt');
        success({ prompt_id: prompt.prompt_id, saved: true, prompt, definition: { name: prompt.name, prompt_text: body.instruction, json_schema: { type: 'object', properties: { title: { type: 'string' } } } } }, 201); return;
      }
      if (path === '/prompts' && method === 'POST') { success(create('prompts', body, 'prompt'), 201); return; }
      if (path === '/prompts' && method === 'GET') { success({ prompts: state.resources.prompts }); return; }
      if ((match = path.match(/^\/prompts\/([^/]+)$/))) { success(state.resources.prompts.find((item) => item.prompt_id === match[1]) ?? { prompt_id: match[1], name: 'Fixture prompt' }); return; }
      if (path === '/workflow/process' && method === 'POST') {
        const run = create('runs', { ...body, status: 'queued' }, 'run');
        success({ run_id: run.run_id, run, prompt: { prompt_id: body.prompt_id ?? 'prompt-fixture', name: 'Fixture extraction' }, status_url: `/api/v2/prompt-runs/${run.run_id}`, results_url: `/api/v2/workflow/runs/${run.run_id}/results`, prompt_created_inline: !body.prompt_id }, 202); return;
      }
      if (path === '/prompt-runs/estimate' && method === 'POST') { success({ estimated_credits: 1, total_segments: 1, total_videos: 1 }); return; }
      if ((match = path.match(/^\/prompt-runs\/([^/]+)$/)) && method === 'GET') {
        const status = advanceStatus(match[1]);
        success({ ...(state.resources.runs.find((item) => item.run_id === match[1]) ?? {}), run_id: match[1], status, progress: { completed: 1, total: 1 }, failed_segments: status === 'partial_completed' ? 1 : 0 }); return;
      }
      if ((match = path.match(/^\/prompt-runs\/([^/]+)\/cancel$/)) && method === 'POST') { success({ run_id: match[1], status: 'cancelled' }); return; }
      if (path.endsWith('/failed-segments')) { success({ failed_segments: [{ video_id: 'video-fixture', segment_id: 'segment-failed', error: 'Fixture processing failure' }] }); return; }
      if (path.endsWith('/retry') && method === 'POST') { success({ retry_id: 'retry-fixture', status: 'queued' }); return; }
      if (path.includes('/retries/')) { success({ retry_id: 'retry-fixture', status: 'completed' }); return; }
      if ((match = path.match(/^\/workflow\/runs\/([^/]+)\/results$/))) {
        const view = url.searchParams.get('view') ?? 'unfiltered';
        const selectedCount = state.config.selection === 'empty' ? 0 : 1;
        const result = { run_id: match[1], status: state.config.statusSequence.at(-1), result_level: url.searchParams.get('result_level') ?? 'segment', selection_summary: { status: state.config.selection === 'unavailable' ? 'pending' : 'ready', selected_media_count: selectedCount, selected_video_count: selectedCount, selected_segment_count: selectedCount } };
        for (const stream of ['filtered', 'unfiltered']) {
          if (view !== 'both' && view !== stream) continue;
          result[stream] = stream === 'filtered' && state.config.selection === 'unavailable' ? null : page(stream === 'filtered' && state.config.selection === 'empty' ? [[]] : state.config.resultPages[stream], url.searchParams.get(`${stream}_cursor`), stream);
        }
        success(result); return;
      }
      if (path === '/workflow/search' && method === 'POST' || path === '/workflow/search/page' && method === 'GET') {
        success({ ...page(state.config.searchPages, url.searchParams.get('cursor'), 'search'), snapshot_id: 'fixture-search-snapshot', warnings: ['Controlled fixture response'], candidate_limit: 100 }); return;
      }
      if (path.endsWith('/image-search') || path.endsWith('/multimodal-search')) { success({ results: state.config.searchPages.flat(), total: state.config.searchPages.flat().length }); return; }
      if (path === '/workflow/media-grants' && method === 'POST') { success({ video_id: body.video_id, url: downloadUrl(body.video_id), filename: state.config.download?.filename ?? 'fixture.bin', mime_type: state.config.download?.mimeType ?? 'application/octet-stream' }); return; }
      if ((path === '/workflow/attachments' || path === '/import-jobs') && method === 'POST') { success(create('imports', { ...body, status: 'completed' }, 'job'), 202); return; }
      if (path === '/import-jobs' && method === 'GET') { success(state.resources.imports); return; }
      if ((match = path.match(/^\/import-jobs\/([^/]+)$/))) { success({ job_id: match[1], status: advanceStatus(match[1]), video_ids: ['video-fixture'], progress: { completed: 1, total: 1 }, failed_files: [], skipped_files: [] }); return; }
      if (path === '/videos/batch' && method === 'POST') { success((body.video_ids ?? []).map((video_id) => ({ video_id, status: 'ready', filename: 'fixture.bin' }))); return; }
      if ((match = path.match(/^\/exports\/([^/]+)\/download-url$/)) && method === 'POST') { success({ export_id: match[1], status: 'completed', download_url: downloadUrl(match[1]), expires_in: 900 }); return; }
      if (/^\/exports\/(index|prompt-run)\//.test(path) && method === 'POST') { success(create('exports', { ...body, status: 'completed' }, 'export'), 202); return; }
      if (path === '/exports' && method === 'GET') { success(state.resources.exports); return; }
      if ((match = path.match(/^\/exports\/([^/]+)(?:\/download)?$/))) { success({ export_id: match[1], status: 'completed', download_url: downloadUrl(match[1]), url: downloadUrl(match[1]), filename: state.config.download?.filename ?? 'fixture.bin' }); return; }
      if (path === '/webhooks/events' && method === 'GET') { success(['export.ready', 'prompt_run.completed', 'prompt_run.failed', 'prompt_run.partial_completed', 'media.created']); return; }
      if (path === '/webhooks' && method === 'POST') {
        const hook = create('webhooks', { ...body, status: 'active', failure_count: 0 }, 'webhook');
        if (deletedWebhook) hook.webhook_id = previous.body.webhook_id;
        hook.secret = `fixture-signing-${hook.webhook_id}-${state.effects.webhooks}`;
        success(hook, 201); return;
      }
      if (path === '/webhooks' && method === 'GET') { success(state.resources.webhooks.map(withoutSecret)); return; }
      if ((match = path.match(/^\/webhooks\/([^/]+)$/))) {
        const hook = state.resources.webhooks.find((item) => item.webhook_id === match[1]);
        if (!hook) { fail(404, 'resource_webhook_not_found', 'Fixture subscription does not exist'); return; }
        if (method === 'DELETE') { state.resources.webhooks = state.resources.webhooks.filter((item) => item !== hook); success({ status: 'deleted' }); return; }
        if (method === 'PATCH') Object.assign(hook, body);
        success(withoutSecret(hook)); return;
      }
      if (path.endsWith('/videos') || path.endsWith('/segments') || path.endsWith('/prompt-runs') && path !== '/prompt-runs') { success(page([[row(1)], [row(2)]], url.searchParams.get('cursor'))); return; }
      if (path === '/prompt-runs' && method === 'GET') { success(state.resources.runs); return; }
      if (path.endsWith('/deletion')) { success({ deletion_id: 'fixture-deletion', status: 'deleted' }); return; }
      if ((match = path.match(/^\/videos\/([^/]+)$/))) { success({ video_id: match[1], status: method === 'DELETE' ? 'deleted' : 'ready', filename: 'fixture.bin' }); return; }
      if (path === '/connectors' && method === 'GET') { success([{ connector_id: 'connector-fixture', name: 'Fixture connector' }]); return; }
      fail(404, 'fixture_route_unknown', `No fixture route ${method} ${path}`);
    } catch (error) {
      if (!response.headersSent) fail(500, 'fixture_server_error', error instanceof Error ? error.message : String(error));
      else response.end();
    }
  });
  return { server, state, reset, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createFixtureServer();
  const port = Number(process.argv[2] ?? 5679);
  server.listen(port, '0.0.0.0', () => process.stdout.write(`VideoVector controlled fixture API: http://localhost:${port}/api/v2\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
