import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeApiError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData } from 'n8n-workflow';

vi.mock('../nodes/VideoVector/transport', async (importOriginal) => ({ ...(await importOriginal<typeof import('../nodes/VideoVector/transport')>()), apiRequest: vi.fn(), operationKey: vi.fn((_index, operation, suffix) => `key:${operation}:${suffix ?? ''}`), uploadBinary: vi.fn(), downloadBinary: vi.fn() }));
import { apiRequest, downloadBinary, operationKey, uploadBinary } from '../nodes/VideoVector/transport';
import { VideoVector } from '../nodes/VideoVector/VideoVector.node';
import { executeOperation } from '../nodes/VideoVector/operations';
import { operationNames, properties } from '../nodes/VideoVector/descriptions';

function context(parameters: IDataObject, overrides: Partial<IExecuteFunctions> = {}, input: INodeExecutionData[] = [{ json: {} }]): IExecuteFunctions {
 return {
  getNodeParameter: (name: string, index: number, fallback?: unknown) => {
   const value = parameters[name];
   return typeof value === 'function' ? value(index) : value ?? fallback;
  },
  getInputData: () => input,
  getNode: () => ({ id: 'test-node', name: 'VideoVector', type: '@vectormethods/n8n-nodes-videovector.videoVector', typeVersion: 1, position: [0, 0], parameters }),
  continueOnFail: () => false,
  helpers: { getBinaryDataBuffer: vi.fn().mockResolvedValue(Buffer.from('query image')) },
  ...overrides,
 } as unknown as IExecuteFunctions;
}
const id = (value: string) => ({ mode: 'id', value });
const page = (data: IDataObject[], cursor: string | null = null) => ({ data, pagination: { limit: 50, has_more: !!cursor, next_cursor: cursor } });
const api = vi.mocked(apiRequest);
beforeEach(() => { vi.clearAllMocks(); api.mockResolvedValue({ id: 'created' }); });

describe('Every action uses a canonical backend endpoint', () => {
 const cases: Array<[string, string, IDataObject, string, string, unknown?]> = [
  ['index', 'create', { name: 'Automated library' }, 'POST', '/indexes', { name: 'Automated library' }],
  ['index', 'get', {}, 'GET', '/indexes/index%2Fa'], ['index', 'list', {}, 'GET', '/indexes', undefined],
  ['index', 'delete', {}, 'DELETE', '/indexes/index%2Fa'], ['index', 'deletionStatus', {}, 'GET', '/indexes/index%2Fa/deletion'],
  ['media', 'importUrls', { destination: 'index', files: [{ download_url: 'https://example.com/video.mp4', file_id: 'source-1' }] }, 'POST', '/workflow/attachments', { index_id: 'index/a', files: [{ download_url: 'https://example.com/video.mp4', file_id: 'source-1' }] }],
  ['media', 'get', {}, 'GET', '/videos/video%2Fa'], ['media', 'list', { destination: 'index' }, 'GET', '/indexes/index%2Fa/videos'],
  ['media', 'segments', {}, 'GET', '/videos/video%2Fa/segments'], ['media', 'delete', {}, 'DELETE', '/videos/video%2Fa'], ['media', 'deletionStatus', {}, 'GET', '/videos/video%2Fa/deletion'],
  ['prompt', 'define', { instruction: 'Describe every scene' }, 'POST', '/workflow/define', { instruction: 'Describe every scene' }],
  ['prompt', 'create', { name: 'Scene extraction', promptText: 'Describe the scene', jsonSchema: { type: 'object' } }, 'POST', '/prompts', { name: 'Scene extraction', prompt_text: 'Describe the scene', json_schema: { type: 'object' } }],
  ['prompt', 'get', {}, 'GET', '/prompts/prompt%2Fa'], ['prompt', 'list', {}, 'GET', '/prompts'],
  ['prompt', 'update', { additionalFields: { description: 'Changed' } }, 'PUT', '/prompts/prompt%2Fa', { description: 'Changed' }], ['prompt', 'delete', {}, 'DELETE', '/prompts/prompt%2Fa'],
  ['run', 'start', { target: 'index', promptSource: 'saved' }, 'POST', '/workflow/process', { prompt_id: 'prompt/a', index_id: 'index/a' }],
  ['run', 'estimate', { target: 'videos', videoIds: '["v1","v2"]' }, 'POST', '/prompt-runs/estimate', { prompt_id: 'prompt/a', target: { type: 'videos', video_ids: ['v1', 'v2'] } }],
  ['run', 'get', {}, 'GET', '/prompt-runs/run%2Fa'], ['run', 'list', { listScope: 'all' }, 'GET', '/prompt-runs'],
  ['run', 'results', { view: 'unfiltered', fullResponse: true }, 'GET', '/workflow/runs/run%2Fa/results'],
  ['run', 'cancel', {}, 'POST', '/prompt-runs/run%2Fa/cancel'], ['run', 'failures', {}, 'GET', '/prompt-runs/run%2Fa/failed-segments'],
  ['run', 'retrySegment', {}, 'POST', '/prompt-runs/run%2Fa/videos/video%2Fa/segments/segment%2Fa/retry'],
  ['run', 'retryStatus', {}, 'GET', '/prompt-runs/run%2Fa/videos/video%2Fa/segments/segment%2Fa/retries/retry%2Fa'],
  ['search', 'semantic', { query: 'red car', searchScope: 'index' }, 'POST', '/workflow/search', { index_id: 'index/a', query: 'red car', result_level: 'segment', limit: 50 }],
  ['search', 'condition', { filters: [{ field: 'count', value: 3 }], searchScope: 'runs', runIds: '["r1"]' }, 'POST', '/workflow/search', { prompt_run_ids: ['r1'], filters: [{ field: 'count', value: 3 }], result_level: 'segment', limit: 50 }],
  ['search', 'image', {}, 'POST', '/indexes/index%2Fa/image-search'], ['search', 'multimodal', { query: 'car' }, 'POST', '/indexes/index%2Fa/multimodal-search'],
  ['search', 'sqlCatalog', {}, 'POST', '/search/sql/index%2Fa/catalog'], ['search', 'sqlGenerate', { instruction: 'Count scenes' }, 'POST', '/search/sql/index%2Fa/generate', { instruction: 'Count scenes' }],
  ['search', 'sqlExecute', { query: 'SELECT * FROM scenes', fullResponse: true }, 'POST', '/search/sql/index%2Fa', { query: 'SELECT * FROM scenes' }],
  ['search', 'agentic', { query: 'What happened?', additionalFields: { session_id: 'session/a' } }, 'POST', '/chat/sessions/session%2Fa/turns', { message: 'What happened?', scope: {} }],
  ['import', 'start', {}, 'POST', '/import-jobs', { connector_id: 'connector/a', index_id: 'index/a' }],
  ['import', 'get', {}, 'GET', '/import-jobs/job%2Fa'], ['import', 'list', {}, 'GET', '/import-jobs'],
  ['import', 'files', { fullResponse: true }, 'GET', '/import-jobs/job%2Fa'],
  ['import', 'cancel', {}, 'POST', '/import-jobs/job%2Fa/cancel'], ['import', 'retry', {}, 'POST', '/import-jobs/job%2Fa/retry'],
  ['export', 'create', { exportSource: 'index' }, 'POST', '/exports/index/index%2Fa', {}], ['export', 'get', {}, 'GET', '/exports/export%2Fa'], ['export', 'list', {}, 'GET', '/exports'],
 ];
 it.each(cases)('%s.%s', async (resource, operation, params, method, path, body) => {
  api.mockResolvedValue({ ...page([]), prompts: [], tables: [], unfiltered: page([]) });
  const ctx = context({ resource, operation, indexId: id('index/a'), promptId: id('prompt/a'), videoId: id('video/a'), runId: id('run/a'), connectorId: id('connector/a'), segmentId: 'segment/a', retryId: 'retry/a', jobId: 'job/a', exportId: 'export/a', ...params });
  await executeOperation(ctx, 0);
  expect(api.mock.calls[0].slice(0, 2)).toEqual([method, path]);
  if (body !== undefined) expect(api.mock.calls[0][2]).toEqual(body);
 });
 it('has contract cases or dedicated binary tests for every advertised operation', () => {
  const covered = new Set(cases.map(([resource, operation]) => `${resource}.${operation}`).concat(['media.upload', 'media.download', 'export.download']));
  expect(Object.entries(operationNames).flatMap(([resource, operations]) => operations.map(([operation]) => `${resource}.${operation}`).filter((name) => !covered.has(name)))).toEqual([]);
 });
});

describe('Execution behavior', () => {
 it('preserves default processing settings by omitting all optional overrides', async () => {
  await executeOperation(context({ resource: 'run', operation: 'start', promptSource: 'instruction', instruction: 'Describe the video', target: 'playground' }), 0);
  expect(api.mock.calls[0][2]).toEqual({ prompt_instruction: 'Describe the video' });
 });
 it('sends explicit false processing settings and schema JSON unchanged', async () => {
  await executeOperation(context({ resource: 'run', operation: 'start', promptId: id('p'), target: 'videos', videoIds: ['v'], additionalFields: { enable_transcription: false, enable_image_embedding: false } }), 0);
  expect(api.mock.calls[0][2]).toEqual({ prompt_id: 'p', video_ids: ['v'], enable_transcription: false, enable_image_embedding: false });
 });
 it('evaluates parameters for each input and pairs every list result', async () => {
  api.mockResolvedValue([{ index_id: 'a' }, { index_id: 'b' }]);
  const output = await new VideoVector().execute.call(context({ resource: 'index', operation: 'list' }, {}, [{ json: { source: 1 } }, { json: { source: 2 } }]));
  expect(output[0].map((row) => row.pairedItem)).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }, { item: 1 }]);
 });
 it('continues failed input items while retaining their source and error metadata', async () => {
  const failure = new NodeApiError(context({}).getNode(), { message: 'Rate limited' }, { message: 'Rate limited', httpCode: '429' });
  Object.assign(failure.context, { code: 'rate_limit_exceeded', requestId: 'req-1', retryAfter: '2' });
  api.mockRejectedValueOnce(failure).mockResolvedValueOnce({ index_id: 'ok' });
  const output = await new VideoVector().execute.call(context({ resource: 'index', operation: 'get', indexId: id('i') }, { continueOnFail: () => true }, [{ json: { source: 1 } }, { json: { source: 2 } }]));
  expect(output[0][0]).toMatchObject({ json: { source: 1, error: 'Rate limited', code: 'rate_limit_exceeded', requestId: 'req-1', retryAfter: '2', details: { requestId: 'req-1' } }, pairedItem: { item: 0 } });
  expect(output[0][1]).toMatchObject({ json: { index_id: 'ok' }, pairedItem: { item: 1 } });
 });
 it('creates an agent session and turn with distinct stable keys', async () => {
  api.mockResolvedValueOnce({ session_id: 's' }).mockResolvedValueOnce({ turn: { status: 'completed' } });
  await executeOperation(context({ resource: 'search', operation: 'agentic', query: 'Summarize the evidence' }), 0);
  expect(api.mock.calls.map((call) => [call[1], call[4]])).toEqual([['/chat/sessions', 'key:search.agentic:session'], ['/chat/sessions/s/turns', 'key:search.agentic:turn']]);
 });
 it('imports media details with bounded batch requests', async () => {
  api.mockResolvedValueOnce({ job_id: 'j', status: 'completed', progress: { imported: 101 }, video_ids: Array.from({ length: 101 }, (_, i) => `v${i}`), failed_files: [] }).mockResolvedValueOnce([{ video_id: 'v0' }]).mockResolvedValueOnce([{ video_id: 'v100' }]);
  const output = await executeOperation(context({ resource: 'import', operation: 'files', jobId: 'j' }), 0);
  expect(api.mock.calls[1][1]).toBe('/videos/batch');
  expect((api.mock.calls[1][2]?.video_ids as string[]).length).toBe(100);
  expect(api.mock.calls[2][2]).toEqual({ video_ids: ['v100'] });
  expect(output[0].json._videovector).toMatchObject({ job_id: 'j', status: 'completed' });
 });
});

describe('Pagination and selection', () => {
 it('uses independent run-result cursors and never replays an exhausted stream', async () => {
  api.mockResolvedValueOnce({ run_id: 'r', filtered: page([{ segment_id: 'f1' }], 'filtered-next'), unfiltered: page([{ segment_id: 'u1' }]), selection_summary: { status: 'completed' } }).mockResolvedValueOnce({ run_id: 'r', filtered: page([{ segment_id: 'f2' }]), unfiltered: null });
  const output = await executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view: 'both', returnAll: true }), 0);
  expect(api.mock.calls[1][3]).toEqual({ result_level: 'segment', view: 'filtered', limit: 50, filtered_cursor: 'filtered-next' });
  expect(output.map((row) => row.json.segment_id)).toEqual(['f1', 'u1', 'f2']);
 });
 it('does not silently treat unavailable selection as zero matches', async () => {
  api.mockResolvedValue({ run_id: 'r', filtered: null, selection_summary: { status: 'pending' } });
  await expect(executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view: 'filtered' }), 0)).rejects.toThrow('Selected results are unavailable');
  const full = await executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view: 'filtered', fullResponse: true }), 0);
  expect(full[0].json).toMatchObject({ filtered: null, selection_summary: { status: 'pending' } });
 });
 it('returns no items for a valid zero-match result', async () => {
  api.mockResolvedValue({ run_id: 'r', filtered: page([]), selection_summary: { status: 'completed' } });
  expect(await executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view: 'filtered' }), 0)).toEqual([]);
 });
 it('preserves complete search snapshot warnings and window limits', async () => {
  api.mockResolvedValueOnce({ ...page([{ segment_id: 's1' }], 'next'), warnings: ['Result window limited'], pagination: { ...page([], 'next').pagination, truncated: true, result_window: 200 } }).mockResolvedValueOnce({ ...page([{ segment_id: 's2' }]), warnings: ['Result window limited'] });
  const result = await executeOperation(context({ resource: 'search', operation: 'semantic', query: 'scene', searchScope: 'playground', fullResponse: true, returnAll: true }), 0);
  expect(api.mock.calls[1]).toMatchObject(['GET', '/workflow/search/page', undefined, { cursor: 'next' }]);
  expect(result[0].json.pagination).toMatchObject({ result_window: 200, truncated: true });
  expect(result[0].json.warnings).toEqual(['Result window limited']);
 });
 it('only offers Return All on endpoints with actual cursor pagination', () => {
  const returns = properties.filter((property) => property.name === 'returnAll');
  expect(returns).toHaveLength(4);
  expect(returns.some((property) => property.displayOptions?.show?.resource?.includes('export'))).toBe(false);
 });
});

describe('Binary contract', () => {
 it('uploads the configured binary property with destination and stable operation identity', async () => {
  vi.mocked(uploadBinary).mockResolvedValue({ video: { video_id: 'v' }, destination: { type: 'index' } });
  const output = await executeOperation(context({ resource: 'media', operation: 'upload', binaryProperty: 'clip', destination: 'newIndex', indexName: 'Library', additionalFields: { title: 'A clip' } }), 0);
  expect(uploadBinary).toHaveBeenCalledWith(0, 'clip', { index_name: 'Library', title: 'A clip' }, 'key:media.upload:');
  expect(output[0].pairedItem).toEqual({ item: 0 });
  expect(operationKey).toHaveBeenCalledWith(0, 'media.upload', undefined);
 });
 it('mints media capability and passes only its URL to binary download', async () => {
  api.mockResolvedValue({ url: 'https://media.example/signed', filename: 'clip.mp4', mime_type: 'video/mp4' });
  vi.mocked(downloadBinary).mockResolvedValue({ data: 'binary-id', mimeType: 'video/mp4' });
  const output = await executeOperation(context({ resource: 'media', operation: 'download', videoId: id('v'), additionalFields: { run_id: 'r', segment_id: 's' }, outputBinaryProperty: 'clip' }), 0);
  expect(api.mock.calls[0]).toEqual(['POST', '/workflow/media-grants', { video_id: 'v', run_id: 'r', segment_id: 's', intent: 'download' }]);
  expect(downloadBinary).toHaveBeenCalledWith('https://media.example/signed', 'clip.mp4', 'video/mp4');
  expect(output[0].binary?.clip.mimeType).toBe('video/mp4');
 });
 it('mints export capability without a mutation key and preserves binary output', async () => {
  api.mockResolvedValue({ download_url: 'https://api.example/exports/e/download?token=opaque', status: 'completed' });
  vi.mocked(downloadBinary).mockResolvedValue({ data: 'binary-id', mimeType: 'application/zip' });
  const output = await executeOperation(context({ resource: 'export', operation: 'download', exportId: 'e' }), 0);
  expect(api.mock.calls[0]).toEqual(['POST', '/exports/e/download-url']);
  expect(downloadBinary).toHaveBeenCalledWith('https://api.example/exports/e/download?token=opaque');
  expect(output[0].pairedItem).toEqual({ item: 0 });
 });
 it('retains SQL row context alongside result columns', async () => {
  api.mockResolvedValue({ rows: [{ count: 4 }], row_context: [{ run_id: 'r' }], truncated: true, applied_result_limit: 1 });
  const output = await executeOperation(context({ resource: 'search', operation: 'sqlExecute', query: 'SELECT count(*)', indexId: id('i') }), 0);
  expect(output[0].json).toEqual({ count: 4, _videovector: { row_context: { run_id: 'r' }, truncated: true, applied_result_limit: 1 } });
 });
});


describe('Batched discovery regressions', () => {
 it.each(['image', 'multimodal'])('uses a paid-search receipt for %s retries', async (operation) => {
  api.mockResolvedValue([]);
  const ctx = context({ resource: 'search', operation, indexId: id('i'), query: 'scene', binaryProperty: 'data', limit: 10 });
  await executeOperation(ctx, 0); await executeOperation(ctx, 0);
  expect(api.mock.calls[0][4]).toBe(`key:search.${operation}:`);
  expect(api.mock.calls[1][4]).toBe(api.mock.calls[0][4]);
  const keyField = properties.find((property) => property.name === 'idempotencyKey');
  expect(keyField?.displayOptions?.show?.operation).toContain(operation);
 });
 it.each(['unfiltered', 'both'])('reports pending extraction for %s row output', async (view) => {
  api.mockResolvedValue({ run_id: 'r', status: 'processing', filtered: null, unfiltered: null, selection_summary: { status: 'pending' } });
  await expect(executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view }), 0)).rejects.toThrow('Extraction results are unavailable');
  const full = await executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view, fullResponse: true }), 0);
  expect(full[0].json).toMatchObject({ status: 'processing', unfiltered: null });
 });
 it('preserves legitimate empty unfiltered results after completion', async () => {
  api.mockResolvedValue({ run_id: 'r', status: 'completed', unfiltered: page([]) });
  expect(await executeOperation(context({ resource: 'run', operation: 'results', runId: id('r'), view: 'unfiltered' }), 0)).toEqual([]);
 });
 it('allows clearing a saved prompt description without sending blank unrelated fields', async () => {
  await executeOperation(context({ resource: 'prompt', operation: 'update', promptId: id('p'), additionalFields: { description: '', name: '' } }), 0);
  expect(api.mock.calls[0][2]).toEqual({ description: '' });
 });
 it('preserves the original binary on native error items', async () => {
  api.mockRejectedValue(new Error('Upload failed'));
  const binary = { data: { data: 'YQ==', fileName: 'source.txt', mimeType: 'text/plain' } };
  const result = await new VideoVector().execute.call(context({ resource: 'index', operation: 'create', name: 'n' }, { continueOnFail: () => true }, [{ json: { source: 'first' }, binary }]));
  expect(result[0][0].binary).toBe(binary);
  expect(result[0][0].error).toBeUndefined();
  expect(result[0][0].json.error).toBe('Upload failed');
  expect(result[0][0].pairedItem).toEqual({ item: 0 });
 });
 it('browses indexed media with pagination and leaves execution target IDs independent', async () => {
  api.mockResolvedValue(page([{ video_id: 'v', title: 'Scene' }], 'page2'));
  const ctx = { getNodeParameter: (name: string, fallback: unknown) => name === 'browseIndexId' ? id('i/scope') : fallback } as ILoadOptionsFunctions;
  const result = await new VideoVector().methods.listSearch.listMedia.call(ctx, 'scene', 'page1');
  expect(api.mock.calls[0]).toEqual(['GET', '/indexes/i%2Fscope/videos', undefined, { cursor: 'page1', limit: 100 }]);
  expect(result).toEqual({ results: [{ name: 'Scene', value: 'v', description: 'v' }], paginationToken: 'page2' });
 });
 it('keeps default media browsing on playground without an index choice', async () => {
  api.mockResolvedValue(page([]));
  const ctx = { getNodeParameter: (_name: string, fallback: unknown) => fallback } as ILoadOptionsFunctions;
  await new VideoVector().methods.listSearch.listMedia.call(ctx);
  expect(api.mock.calls[0][1]).toBe('/playground/videos');
 });
});


describe('Native n8n error-envelope regressions', () => {
 it('uses the n8n error envelope for a later failed item without replacing JSON', async () => {
  const failure = new NodeApiError(context({}).getNode(), { message: 'Write scope is required' }, { message: 'Write scope is required', httpCode: '403' });
  Object.assign(failure.context, { code: 'authorization_insufficient_scope', requestId: 'req-2', statusCode: 403 });
  api.mockResolvedValueOnce({ index_id: 'ok' }).mockRejectedValueOnce(failure);
  const binary = { data: { data: 'YQ==', fileName: 'source.txt', mimeType: 'text/plain' } };
  const ctx = context({ resource: 'index', operation: 'create', name: 'n' }, { continueOnFail: () => true }, [{ json: { label: 'First' } }, { json: { label: 'Second' }, binary }]);
  const node = ctx.getNode();
  ctx.getNode = () => ({ ...node, onError: 'continueErrorOutput' });
  const result = await new VideoVector().execute.call(ctx);
  expect(result[0][0]).toMatchObject({ json: { index_id: 'ok' }, pairedItem: { item: 0 } });
  const failed = result[0][1];
  expect(failed.error).toBeUndefined();
  expect(Object.keys(failed.json).every((key) => ['error', 'message', 'details'].includes(key))).toBe(true);
  expect(failed.json).toMatchObject({ error: 'Write scope is required', details: { code: 'authorization_insufficient_scope', requestId: 'req-2', statusCode: '403', itemIndex: 1 } });
  expect(failed.pairedItem).toEqual({ item: 1 });
  expect(failed.binary).toBe(binary);
 });
 it('keeps source fields and structured diagnostics on the regular output', async () => {
  const failure = new NodeApiError(context({}).getNode(), { message: 'Rate limited' }, { message: 'Rate limited', httpCode: '429' });
  Object.assign(failure.context, { code: 'rate_limit_exceeded', requestId: 'req-3', retryAfter: '2' });
  api.mockRejectedValue(failure);
  const ctx = context({ resource: 'index', operation: 'list' }, { continueOnFail: () => true }, [{ json: { customerId: 'customer-1' } }]);
  const node = ctx.getNode(); ctx.getNode = () => ({ ...node, onError: 'continueRegularOutput' });
  const result = await new VideoVector().execute.call(ctx);
  expect(result[0][0].error).toBeUndefined();
  expect(result[0][0].json).toMatchObject({ customerId: 'customer-1', error: 'Rate limited', code: 'rate_limit_exceeded', statusCode: '429', requestId: 'req-3', retryAfter: '2' });
 });
});
