import { createHmac } from 'crypto';
import type { IDataObject, IHookFunctions, ILoadOptionsFunctions, IWebhookFunctions } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoVectorTrigger, verifySignature } from '../nodes/VideoVectorTrigger/VideoVectorTrigger.node';
import { apiRequest } from '../nodes/VideoVector/transport';

vi.mock('../nodes/VideoVector/transport', async (importOriginal) => ({
	...await importOriginal<typeof import('../nodes/VideoVector/transport')>(), apiRequest: vi.fn(),
}));

const api = vi.mocked(apiRequest);
const trigger = new VideoVectorTrigger();
const lifecycle = trigger.webhookMethods.default;

function hookContext(
	staticData: IDataObject = {},
	parameters: IDataObject = { events: ['prompt_run.completed'], indexIds: [] },
	url = 'https://n8n.example.com/webhook/workflow-1/webhook',
) {
	return {
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => url,
		getNodeParameter: (name: string, fallback?: unknown) => parameters[name] ?? fallback,
		getWorkflow: () => ({ id: 'workflow-1', name: 'VideoVector automation' }),
		getNode: () => ({ id: 'node-1', name: 'VideoVector Trigger', type: 'videoVectorTrigger', typeVersion: 1, position: [0, 0], parameters }),
	} as unknown as IHookFunctions;
}

function createResponse(body: IDataObject, id = 'whk_1') {
	return { ...body, webhook_id: id, secret: `secret-${id}`, status: 'active' };
}

function signedContext(options: {
	body?: IDataObject;
	rawBody?: Buffer;
	secret?: string;
	headers?: IDataObject;
	staticData?: IDataObject;
} = {}) {
	const body = options.body ?? { id: 'evt-1', event: 'prompt_run.completed', data: { run_id: 'run-1' }, created_at: '2026-10-07T00:00:00Z', api_version: '2024-01' };
	const raw = options.rawBody ?? Buffer.from(JSON.stringify(body));
	const secret = options.secret ?? 'secret-whk_1';
	const response = { status: vi.fn(), json: vi.fn() };
	response.status.mockReturnValue(response);
	response.json.mockReturnValue(response);
	const headers = {
		'x-webhook-id': 'whk_1',
		'x-webhook-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
		'x-delivery-id': 'delivery-1',
		'idempotency-key': 'attempt-1',
		'x-delivery-attempt-id': 'attempt-1',
		...options.headers,
	};
	return {
		body,
		response,
		context: {
			getWorkflowStaticData: () => options.staticData ?? { registration: { id: 'whk_1', secret: 'secret-whk_1' } },
			getRequestObject: () => ({ rawBody: raw }),
			getHeaderData: () => headers,
			getBodyData: () => body,
			getResponseObject: () => response,
		} as unknown as IWebhookFunctions,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('VideoVector Trigger discovery', () => {
	it('loads the authoritative event catalog without copying a static event list', async () => {
		api.mockResolvedValueOnce(['prompt_run.completed', 'export.ready']);
		expect(await trigger.methods.loadOptions.getEvents.call({} as ILoadOptionsFunctions)).toEqual([
			{ name: 'export.ready', value: 'export.ready' },
			{ name: 'prompt_run.completed', value: 'prompt_run.completed' },
		]);
		expect(api).toHaveBeenCalledWith('GET', '/webhooks/events');
	});

	it('loads owned indexes without shared demos', async () => {
		api.mockResolvedValueOnce([{ index_id: 'index-1', name: 'Team library' }]);
		expect(await trigger.methods.loadOptions.getIndexes.call({} as ILoadOptionsFunctions)).toEqual([
			{ name: 'Team library', value: 'index-1' },
		]);
		expect(api).toHaveBeenCalledWith('GET', '/indexes', undefined, { include_defaults: false });
	});
});

describe('VideoVector Trigger subscription lifecycle', () => {
	it('creates a subscription with sorted filters and stores its signing secret outside output', async () => {
		const data: IDataObject = {};
		const context = hookContext(data, { events: ['prompt_run.completed', 'export.ready', 'export.ready'], indexIds: ['index-2', 'index-1'] });
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		expect(await lifecycle.create.call(context)).toBe(true);
		expect(api).toHaveBeenCalledWith('POST', '/webhooks', expect.objectContaining({
			url: 'https://n8n.example.com/webhook/workflow-1/webhook',
			events: ['export.ready', 'prompt_run.completed'],
			index_ids: ['index-1', 'index-2'],
		}), undefined, expect.stringMatching(/^n8n-webhook-/));
		expect(data.registration).toMatchObject({ id: 'whk_1', secret: 'secret-whk_1' });
	});

	it('passes no index restriction when the filter is empty', async () => {
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		await lifecycle.create.call(hookContext());
		expect(api.mock.calls[0][2]?.index_ids).toBeNull();
	});

	it.each([
		['http://localhost:5678/webhook/test', { events: ['export.ready'] }, 'HTTPS'],
		['https://n8n.example.com/webhook/test', { events: [] }, 'at least one event'],
	])('rejects invalid configuration before remote creation (%s)', async (url, params, message) => {
		await expect(lifecycle.create.call(hookContext({}, params, url))).rejects.toThrow(message);
		expect(api).not.toHaveBeenCalled();
	});

	it('reuses a healthy matching subscription after restart without creating another', async () => {
		const data: IDataObject = {};
		const context = hookContext(data);
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		await lifecycle.create.call(context);
		const state = data.registration as IDataObject;
		api.mockResolvedValueOnce(createResponse(state.body as IDataObject));
		expect(await lifecycle.checkExists.call(hookContext(JSON.parse(JSON.stringify(data))))).toBe(true);
		expect(api.mock.calls.map(([method]) => method)).toEqual(['POST', 'GET']);
	});

	it('replays the same request and key after a lost create response', async () => {
		const data: IDataObject = {};
		const context = hookContext(data);
		api.mockRejectedValueOnce(new Error('socket disconnected'));
		await expect(lifecycle.create.call(context)).rejects.toThrow('socket disconnected');
		const firstCall = api.mock.calls[0];
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		expect(await lifecycle.checkExists.call(context)).toBe(false);
		await lifecycle.create.call(context);
		expect(api.mock.calls[1]).toEqual(firstCall);
		expect(data.registration).toMatchObject({ id: 'whk_1', secret: 'secret-whk_1' });
	});

	it('reconstructs the same initial request key after n8n loses unsaved pending static data', async () => {
		api.mockRejectedValueOnce(new Error('response lost after remote commit'));
		await expect(lifecycle.create.call(hookContext({}))).rejects.toThrow('response lost');
		const original = api.mock.calls[0];
		const afterRestart: IDataObject = {};
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		await lifecycle.create.call(hookContext(afterRestart));
		expect(api.mock.calls[1]).toEqual(original);
		expect(afterRestart).toMatchObject({ registration: { id: 'whk_1', secret: 'secret-whk_1' } });
	});

	it('clears rejected registrations but retains uncertain errors for idempotent recovery', async () => {
		const data: IDataObject = {};
		api.mockRejectedValueOnce(Object.assign(new Error('Invalid key'), { httpCode: '401' }));
		await expect(lifecycle.create.call(hookContext(data))).rejects.toThrow('Invalid key');
		expect(data.registration).toBeUndefined();
	});

	it('recovers an uncertain create before cleanup so a subscription is not orphaned', async () => {
		const data: IDataObject = {};
		const context = hookContext(data);
		api.mockRejectedValueOnce(new Error('timeout'));
		await expect(lifecycle.create.call(context)).rejects.toThrow('timeout');
		api.mockResolvedValueOnce([createResponse(api.mock.calls[0][2] as IDataObject)]);
		api.mockResolvedValueOnce({ status: 'deleted' });
		await lifecycle.delete.call(context);
		expect(api.mock.calls.map(([method]) => method)).toEqual(['POST', 'GET', 'DELETE']);
		expect(data.registration).toBeUndefined();
	});

	it('cleans an accepted creation with no persisted registration, scoped to workflow, node, and callback', async () => {
		const data: IDataObject = {};
		const identity = { n8n_workflow_id: 'workflow-1', n8n_node_id: 'node-1' };
		const callback = 'https://n8n.example.com/webhook/workflow-1/webhook';
		api.mockResolvedValueOnce([
			{ webhook_id: 'orphan', url: callback, metadata: identity },
			{ webhook_id: 'another-workflow', url: callback, metadata: { ...identity, n8n_workflow_id: 'workflow-2' } },
			{ webhook_id: 'another-node', url: callback, metadata: { ...identity, n8n_node_id: 'node-2' } },
			{ webhook_id: 'test-peer', url: 'https://n8n.example.com/webhook-test/workflow-1/webhook', metadata: identity },
			{ webhook_id: 'unrelated', url: callback, metadata: {} },
		]);
		api.mockResolvedValueOnce({ status: 'deleted' });
		expect(await lifecycle.delete.call(hookContext(data))).toBe(true);
		expect(api.mock.calls).toEqual([['GET', '/webhooks'], ['DELETE', '/webhooks/orphan']]);
		expect(data).toEqual({});
	});

	it('does not create a subscription when cleanup has no matching remote registration', async () => {
		api.mockResolvedValueOnce([]);
		expect(await lifecycle.delete.call(hookContext({}))).toBe(true);
		expect(api.mock.calls).toEqual([['GET', '/webhooks']]);
	});

	it('reuses the canonical row identity after deactivation and stores the fresh signing secret', async () => {
		const data: IDataObject = {};
		const context = hookContext(data);
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		await lifecycle.create.call(context);
		const originalKey = api.mock.calls[0][4];
		api.mockRejectedValueOnce({ httpCode: '404' });
		expect(await lifecycle.delete.call(context)).toBe(true);
		expect(data.registration).toBeUndefined();
		api.mockImplementationOnce(async (_method, _path, body) => ({ ...createResponse(body as IDataObject), secret: 'freshly-created-secret' }));
		const afterRestart: IDataObject = JSON.parse(JSON.stringify(data));
		await lifecycle.create.call(hookContext(afterRestart));
		expect(api.mock.calls[2][4]).toBe(originalKey);
		expect(afterRestart.registration).toMatchObject({ id: 'whk_1', secret: 'freshly-created-secret' });
	});

	it('clears externally deleted subscription state before recreating the canonical row', async () => {
		const data: IDataObject = { registration: { id: 'missing', secret: 'old', key: 'old-key', body: {}, fingerprint: 'old' } };
		api.mockRejectedValueOnce({ httpCode: '404' });
		expect(await lifecycle.checkExists.call(hookContext(data))).toBe(false);
		expect(data.registration).toBeUndefined();
	});

	it('replaces changed subscriptions after deleting the previous registration', async () => {
		const data: IDataObject = {};
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject));
		await lifecycle.create.call(hookContext(data));
		const oldState = data.registration as IDataObject;
		api.mockResolvedValueOnce(createResponse(oldState.body as IDataObject));
		api.mockResolvedValueOnce({ status: 'deleted' });
		const changed = hookContext(data, { events: ['export.ready'], indexIds: ['index-2'] });
		expect(await lifecycle.checkExists.call(changed)).toBe(false);
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject, 'whk_2'));
		await lifecycle.create.call(changed);
		expect(api.mock.calls.map(([method]) => method)).toEqual(['POST', 'GET', 'DELETE', 'POST']);
		expect(api.mock.calls[3][4]).not.toBe(api.mock.calls[0][4]);
	});

	it('surfaces cleanup authorization errors and retains the registration for retry', async () => {
		const data: IDataObject = { registration: { id: 'whk_1', secret: 'keep', key: 'key', body: {}, fingerprint: 'hash' } };
		api.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { httpCode: '403' }));
		await expect(lifecycle.delete.call(hookContext(data))).rejects.toMatchObject({
			message: 'VideoVector could not remove the webhook subscription',
			description: expect.stringContaining('admin scope'),
		});
		expect(data.registration).toMatchObject({ id: 'whk_1', secret: 'keep' });
	});

	it('does not turn service failures into a missing subscription or successful cleanup', async () => {
		const data: IDataObject = { registration: { id: 'whk_1', secret: 'keep', key: 'key', body: {}, fingerprint: 'hash' } };
		api.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { httpCode: '503' }));
		await expect(lifecycle.checkExists.call(hookContext(data))).rejects.toThrow('Unavailable');
		api.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { httpCode: '503' }));
		await expect(lifecycle.delete.call(hookContext(data))).rejects.toThrow('Unavailable');
		expect(data.registration).toMatchObject({ id: 'whk_1' });
	});

	it('keeps production and test registrations in n8n-provided isolated static data', async () => {
		const production: IDataObject = {};
		const test: IDataObject = {};
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject, 'production'));
		await lifecycle.create.call(hookContext(production));
		api.mockImplementationOnce(async (_method, _path, body) => createResponse(body as IDataObject, 'test'));
		await lifecycle.create.call(hookContext(test, undefined, 'https://n8n.example.com/webhook-test/workflow-1/webhook'));
		api.mockResolvedValueOnce({ status: 'deleted' });
		await lifecycle.delete.call(hookContext(test));
		expect(test.registration).toBeUndefined();
		expect(production.registration).toMatchObject({ id: 'production', secret: 'secret-production' });
		expect(api.mock.calls[2][1]).toBe('/webhooks/test');
	});
});

describe('VideoVector Trigger delivery authentication', () => {
	it('validates exact wire bytes, including spacing and Unicode, and preserves the envelope and delivery identities', async () => {
		const rawBody = Buffer.from('{ "data": {"title": "café"}, "event": "export.ready", "id": "evt-1" }');
		const fixture = signedContext({ rawBody, body: JSON.parse(rawBody.toString()) });
		const result = await trigger.webhook.call(fixture.context);
		expect(result.webhookResponse).toEqual({ received: true });
		expect(result.workflowData?.[0]?.[0].json).toEqual({
			...fixture.body,
			_delivery: { webhook_id: 'whk_1', delivery_id: 'delivery-1', idempotency_key: 'attempt-1', attempt_id: 'attempt-1' },
		});
		expect(JSON.stringify(result)).not.toContain('secret-whk_1');
		expect(fixture.response.status).not.toHaveBeenCalled();
		expect(api).not.toHaveBeenCalled();
	});

	it('accepts signed backend test events without a delivery ID', async () => {
		const fixture = signedContext({ body: { id: 'evt_test_1', event: 'test', data: { message: 'test' } }, headers: { 'x-delivery-id': undefined, 'idempotency-key': undefined, 'x-delivery-attempt-id': undefined } });
		const result = await trigger.webhook.call(fixture.context);
		expect(result.workflowData?.[0]?.[0].json).toMatchObject({ event: 'test', _delivery: { delivery_id: null, attempt_id: null } });
	});

	it.each([
		{ 'x-webhook-signature': undefined },
		{ 'x-webhook-signature': 'sha256=00' },
		{ 'x-webhook-signature': `sha256=${'0'.repeat(64)}` },
		{ 'x-webhook-signature': ['sha256=00', 'sha256=11'] },
		{ 'x-webhook-id': 'another-subscription' },
	])('rejects invalid signatures and subscription IDs without starting a workflow (%j)', async (headers) => {
		const fixture = signedContext({ headers });
		expect(await trigger.webhook.call(fixture.context)).toEqual({ noWebhookResponse: true });
		expect(fixture.response.status).toHaveBeenCalledWith(401);
	});

	it('never accepts an unsigned callback when static signing state is absent', async () => {
		const fixture = signedContext({ staticData: {} });
		expect(await trigger.webhook.call(fixture.context)).toEqual({ noWebhookResponse: true });
		expect(fixture.response.status).toHaveBeenCalledWith(401);
	});

	it('rejects tampering and missing raw bytes instead of reconstructing signed JSON', () => {
		const bytes = Buffer.from('{"event":"export.ready"}');
		const signature = `sha256=${createHmac('sha256', 'secret').update(bytes).digest('hex')}`;
		expect(verifySignature(bytes, signature, 'secret')).toBe(true);
		expect(verifySignature(Buffer.from('{ "event": "export.ready" }'), signature, 'secret')).toBe(false);
		expect(verifySignature(undefined, signature, 'secret')).toBe(false);
	});

	it('does not add an in-node deduplication store', async () => {
		const fixture = signedContext();
		const first = await trigger.webhook.call(fixture.context);
		const redelivery = await trigger.webhook.call(fixture.context);
		expect(redelivery.workflowData).toEqual(first.workflowData);
	});
});
