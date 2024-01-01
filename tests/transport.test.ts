import { describe, expect, it, vi } from 'vitest';
import { NodeApiError, NodeOperationError, type IExecuteFunctions, type JsonObject } from 'n8n-workflow';
import { apiRequest, downloadBinary, nodeError, operationKey, uploadBinary } from '../nodes/VideoVector/transport';

function context(options: { context?: Record<string, unknown>; executionId?: string; runIndex?: number; override?: string } = {}) {
  const state = options.context || {};
  const authenticated = vi.fn().mockResolvedValue({ run_id: 'run-1' });
  const anonymous = vi.fn().mockResolvedValue({ body: 'stream', headers: { 'content-type': 'video/mp4' } });
  const prepare = vi.fn().mockResolvedValue({ data: 'binary', mimeType: 'video/mp4' });
  const value = {
    getCredentials: vi.fn().mockResolvedValue({ apiKey: 'secret', baseUrl: 'https://api.vectormethods.com/api/v2/' }),
    getNode: () => ({ id: 'node-1', name: 'VideoVector', type: 'videoVector', typeVersion: 1, position: [0, 0], parameters: {} }),
    getNodeParameter: () => options.override || '',
    getContext: () => state,
    getExecutionId: () => options.executionId || 'execution-1',
    getWorkflowDataProxy: () => ({ $runIndex: options.runIndex || 0 }),
    helpers: { httpRequestWithAuthentication: authenticated, httpRequest: anonymous, prepareBinaryData: prepare,
      assertBinaryData: vi.fn(), getBinaryStream: vi.fn() },
  };
  return { value: value as unknown as IExecuteFunctions, raw: value, state, authenticated, anonymous, prepare };
}

describe('logical operation identity', () => {
  it('survives Retry On Fail and a new execution ID with retained retry context', () => {
    const first = context();
    const key = operationKey.call(first.value, 0, 'run.start');
    expect(operationKey.call(first.value, 0, 'run.start')).toBe(key);
    const retry = context({ context: first.state, executionId: 'execution-retry' });
    expect(operationKey.call(retry.value, 0, 'run.start')).toBe(key);
  });
  it('distinguishes items, loop iterations, substeps, and fresh executions', () => {
    const first = context();
    const keys = [operationKey.call(first.value, 0, 'run.start'), operationKey.call(first.value, 1, 'run.start'),
      operationKey.call(first.value, 0, 'run.start', 'second'),
      operationKey.call(context({ runIndex: 1 }).value, 0, 'run.start'),
      operationKey.call(context({ executionId: 'fresh' }).value, 0, 'run.start')];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('lets external identity survive workflow and item reordering', () => {
    const key = operationKey.call(context({ override: 'source-event-123' }).value, 0, 'run.start');
    expect(operationKey.call(context({ override: 'source-event-123', executionId: 'different' }).value, 3, 'run.start')).toBe(key);
  });
});

describe('HTTP boundary', () => {
  it('uses native credentials, a relative API path, and the exact supplied idempotency key', async () => {
    const ctx = context();
    await apiRequest.call(ctx.value, 'POST', '/workflow/process', { prompt_id: 'p' }, undefined, 'operation-1');
    expect(ctx.authenticated).toHaveBeenCalledWith('videoVectorApi', expect.objectContaining({
      url: 'https://api.vectormethods.com/api/v2/workflow/process', body: { prompt_id: 'p' },
      headers: { Accept: 'application/json', 'Idempotency-Key': 'operation-1' }, disableFollowRedirect: true,
    }));
  });
  it('rejects an absolute URL before credential forwarding', async () => {
    const ctx = context();
    await expect(apiRequest.call(ctx.value, 'GET', 'https://other.example')).rejects.toThrow();
    expect(ctx.authenticated).not.toHaveBeenCalled();
  });
  it('preserves required empty JSON bodies through the native helper without adding bodies to other requests', async () => {
    const ctx = context();
    await apiRequest.call(ctx.value, 'POST', '/search/sql/index-1/catalog', {});
    await apiRequest.call(ctx.value, 'POST', '/chat/sessions', {}, undefined, 'session-key');
    await apiRequest.call(ctx.value, 'POST', '/exports/export-1/download-url');
    const requests = ctx.authenticated.mock.calls.map((call) => call[1]);
    for (const request of requests.slice(0, 2)) {
      // The native helper sends strings, but omits empty object data.
      expect(typeof request.body).toBe('string');
      expect(JSON.parse(request.body)).toEqual({});
      expect(request.headers['Content-Type']).toBe('application/json');
    }
    expect(requests[1].headers['Idempotency-Key']).toBe('session-key');
    expect(requests[2].body).toBeUndefined();
    expect(requests[2].headers['Content-Type']).toBeUndefined();
  });
  it('preserves useful API errors without retaining the credential-bearing request', async () => {
    const ctx = context();
    ctx.authenticated.mockRejectedValue({ response: { status: 429, data: { message: 'Rate limited', code: 'rate_limit' },
      headers: { 'x-request-id': 'request-1', 'retry-after': '10' } }, config: { headers: { 'X-API-Key': 'secret' } } });
    try { await apiRequest.call(ctx.value, 'GET', '/indexes'); throw new Error('Expected error'); }
    catch (error) {
      expect(String(error)).toContain('Rate limited');
      expect(JSON.stringify(error)).toContain('request-1');
      expect(JSON.stringify(error)).not.toContain('secret');
    }
  });
  it.each([401, 403, 429])('preserves structured diagnostics from native wrapped HTTP %i errors', async (status) => {
    const ctx = context();
    const raw = Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data: JSON.stringify({ error: { message: 'Use a key with write scope', code: 'insufficient_scope' } }),
        headers: { 'x-request-id': 'req-live-shape', 'retry-after': '12' } },
      config: { headers: { 'X-API-Key': 'never-serialize-this' } },
    });
    ctx.authenticated.mockRejectedValue(new NodeApiError(ctx.value.getNode(), raw as unknown as JsonObject));
    const failure = await apiRequest.call(ctx.value, 'POST', '/indexes', { name: 'Test' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeApiError);
    expect(failure).toMatchObject({ message: 'Use a key with write scope', httpCode: String(status),
      context: { code: 'insufficient_scope', requestId: 'req-live-shape', retryAfter: '12', statusCode: status } });
    expect(JSON.stringify(failure)).not.toContain('never-serialize-this');
  });
  it('preserves normalized errors and their context when adding the failed item', () => {
    const ctx = context();
    const original = new NodeApiError(ctx.value.getNode(), { message: 'Scope required' }, { message: 'Scope required', httpCode: '403' });
    original.context = { code: 'insufficient_scope', requestId: 'req-1' };
    expect(nodeError(ctx.value, original, 2)).toBe(original);
    expect(original.context).toEqual({ code: 'insufficient_scope', requestId: 'req-1', itemIndex: 2 });
    expect(nodeError(ctx.value, new Error('Invalid input'), 1)).toBeInstanceOf(NodeOperationError);
  });
  it('uses unauthenticated streaming for signed downloads', async () => {
    const ctx = context();
    await downloadBinary.call(ctx.value, 'https://storage.example/signed', 'clip.mp4');
    expect(ctx.authenticated).not.toHaveBeenCalled();
    expect(ctx.anonymous).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'stream', sendCredentialsOnCrossOriginRedirect: false }));
    expect(ctx.prepare).toHaveBeenCalledWith('stream', 'clip.mp4', 'video/mp4');
  });
  it('preserves the server download filename from Content-Disposition', async () => {
    const ctx = context();
    ctx.anonymous.mockResolvedValue({ body: 'stream', headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="export.json"' } });
    await downloadBinary.call(ctx.value, 'https://storage.example/signed');
    expect(ctx.prepare).toHaveBeenCalledWith('stream', 'export.json', 'application/json');
  });
});

describe('binary upload', () => {
  it('streams stored binary data and reopens it on each attempt', async () => {
    const ctx = context();
    ctx.raw.helpers.assertBinaryData.mockReturnValue({ id: 'filesystem:1', data: 'filesystem', fileName: 'clip.mov', mimeType: 'video/quicktime' });
    const stream = { pipe: vi.fn(), path: '/private/binary' };
    ctx.raw.helpers.getBinaryStream.mockResolvedValue(stream);
    await uploadBinary.call(ctx.value, 0, 'data', { index_id: 'index-1' }, 'stable-key');
    await uploadBinary.call(ctx.value, 0, 'data', { index_id: 'index-1' }, 'stable-key');
    expect(ctx.raw.helpers.getBinaryStream).toHaveBeenCalledTimes(2);
    expect(stream.path).toBe('/private/binary');
    expect(ctx.authenticated.mock.calls[0][1].body).toEqual({ file: expect.objectContaining({ name: 'clip.mov' }), index_id: 'index-1' });
  });
  it('preserves filename and MIME with native multipart for inline bytes', async () => {
    const ctx = context();
    ctx.raw.helpers.assertBinaryData.mockReturnValue({ data: Buffer.from('video').toString('base64'), fileName: 'clip.mp4', mimeType: 'video/mp4' });
    await uploadBinary.call(ctx.value, 0, 'data', { title: 'Clip' }, 'stable-key');
    const options = ctx.authenticated.mock.calls[0][1];
    expect(options.headers['Content-Type']).toBeUndefined();
    const file = options.body.get('file');
    expect(file.name).toBe('clip.mp4');
    expect(file.type).toBe('video/mp4');
    expect(await file.text()).toBe('video');
    expect(options.body.get('title')).toBe('Clip');
  });
});
