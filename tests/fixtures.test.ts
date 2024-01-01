import { createHash, createHmac } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// This dev-only HTTP fixture runs controlled responses against the real n8n
// engine. Live VideoVector happy paths use the deployed API separately.
// @ts-expect-error The dependency-free fixture server is intentionally native ESM JavaScript.
import { createFixtureServer } from '../scripts/fixture-server.mjs';

const fixture = createFixtureServer();
let origin: string;
async function call(path: string, options: { method?: string; body?: unknown; key?: string; apiKey?: string } = {}) {
	return await fetch(`${origin}/api/v2${path}`, {
		method: options.method ?? 'GET',
		headers: { 'X-API-Key': options.apiKey ?? 'fixture', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}) },
		...(options.body ? { body: JSON.stringify(options.body) } : {}),
	});
}

beforeAll(async () => {
	await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${fixture.server.address().port}`;
});
beforeEach(() => fixture.reset());
afterAll(async () => {
	fixture.server.closeAllConnections();
	await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => error ? reject(error) : resolve()));
});

describe('controlled API fixture service', () => {
	it('tests credentials without changing resources and rejects invalid credentials/scopes', async () => {
		expect((await call('/auth/validate')).status).toBe(204);
		expect((await call('/auth/validate', { apiKey: 'invalid' })).status).toBe(401);
		expect((await call('/indexes', { method: 'POST', body: { name: 'test' }, apiKey: 'fixture-readonly' })).status).toBe(403);
		expect(fixture.report().effects).toEqual({});
	});

	it('records per-input retries and deduplicates successful creation after a later item fails', async () => {
		fixture.reset({ failures: [{ method: 'POST', path: '/workflow/process', occurrence: 2, status: 503 }] });
		const first = { method: 'POST', body: { prompt_id: 'prompt-first' }, key: 'first-item-key' };
		const second = { method: 'POST', body: { prompt_id: 'prompt-second' }, key: 'second-item-key' };
		const created = await (await call('/workflow/process', first)).json();
		expect((await call('/workflow/process', second)).status).toBe(503);
		expect(await (await call('/workflow/process', first)).json()).toEqual(created);
		expect((await call('/workflow/process', second)).status).toBe(202);
		expect(fixture.report()).toMatchObject({ effects: { runs: 2 }, replays: [{ key: first.key }] });
		expect(fixture.report().counts['POST /workflow/process']).toBe(4);
		expect((await call('/workflow/process', { ...first, body: { prompt_id: 'changed' } })).status).toBe(409);
	});

	it('advances independent run status sequences and stops at their terminal result', async () => {
		fixture.reset({ statusSequence: ['processing', 'partial_completed'] });
		expect(await (await call('/prompt-runs/a')).json()).toMatchObject({ status: 'processing' });
		expect(await (await call('/prompt-runs/a')).json()).toMatchObject({ status: 'partial_completed' });
		expect(await (await call('/prompt-runs/a')).json()).toMatchObject({ status: 'partial_completed' });
		expect(await (await call('/prompt-runs/b')).json()).toMatchObject({ status: 'processing' });
	});

	it('can lose a creation response after committing the resource for lifecycle recovery tests', async () => {
		fixture.reset({ failures: [{ method: 'POST', path: '/webhooks', occurrence: 1, status: 503, afterCommit: true }] });
		const request = { method: 'POST', body: { name: 'Webhook', url: 'https://n8n.example.com/webhook/recovery', events: ['export.ready'] }, key: 'recovery-key' };
		expect((await call('/webhooks', request)).status).toBe(503);
		expect(fixture.report().effects.webhooks).toBe(1);
		expect((await call('/webhooks', request)).status).toBe(201);
		expect(fixture.report().effects.webhooks).toBe(1);
		expect(fixture.report().replays).toHaveLength(1);
	});

	it('exposes independently exhausted result cursors and unavailable versus empty selection', async () => {
		const initial = await (await call('/workflow/runs/run-1/results?view=both')).json();
		expect(initial.filtered.pagination.has_more).toBe(false);
		expect(initial.unfiltered.pagination).toMatchObject({ has_more: true, next_cursor: 'unfiltered:1' });
		const next = await (await call('/workflow/runs/run-1/results?view=unfiltered&unfiltered_cursor=unfiltered:1')).json();
		expect(next.unfiltered.data[0].segment_id).toBe('segment-2');
		expect(next.filtered).toBeUndefined();
		fixture.state.config.selection = 'unavailable';
		expect(await (await call('/workflow/runs/run-1/results?view=filtered')).json()).toMatchObject({ filtered: null });
		fixture.state.config.selection = 'empty';
		expect(await (await call('/workflow/runs/run-1/results?view=filtered')).json()).toMatchObject({ filtered: { data: [] } });
	});

	it('captures bytes/filename/MIME and deduplicates multipart retries despite changed boundaries', async () => {
		const bytes = Buffer.from('fixture media bytes');
		const upload = async () => {
			const form = new FormData();
			form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'original.mp4');
			form.append('index_id', 'index-one');
			return await fetch(`${origin}/api/v2/workflow/upload`, { method: 'POST', body: form, headers: { 'x-api-key': 'fixture', 'idempotency-key': 'upload-key' } });
		};
		const first = await (await upload()).json();
		expect(await (await upload()).json()).toEqual(first);
		expect(fixture.report().uploads).toEqual([{ filename: 'original.mp4', mimeType: 'video/mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fields: { index_id: 'index-one' } }]);
		expect(fixture.report().effects.media).toBe(1);
	});

	it('provides signed downloads and records accidental credential forwarding', async () => {
		const grant = await (await call('/workflow/media-grants', { method: 'POST', body: { video_id: 'video-1' } })).json();
		const result = await fetch(grant.url);
		expect(await result.text()).toBe('VideoVector fixture binary\n');
		expect(fixture.report().downloads).toEqual([{ path: '/__download/video-1', apiKeyPresent: false, authorizationPresent: false }]);
		expect((await fetch(`${origin}/__download/video-1`)).status).toBe(403);
	});

	it('replays a webhook signing secret, hides it from reports/reads, and supports deletion', async () => {
		const body = { name: 'fixture webhook', url: 'https://n8n.example.com/webhook/test', events: ['export.ready'], index_ids: null };
		const created = await (await call('/webhooks', { method: 'POST', body, key: 'hook-creation-key' })).json();
		expect(created.secret).toBeTruthy();
		expect(await (await call('/webhooks', { method: 'POST', body, key: 'hook-creation-key' })).json()).toEqual(created);
		expect(JSON.stringify(fixture.report())).not.toContain(created.secret);
		expect(await (await call(`/webhooks/${created.webhook_id}`)).json()).not.toHaveProperty('secret');
		expect((await call(`/webhooks/${created.webhook_id}`, { method: 'DELETE' })).status).toBe(200);
		expect((await call(`/webhooks/${created.webhook_id}`)).status).toBe(404);
		const recreated = await (await call('/webhooks', { method: 'POST', body, key: 'hook-creation-key' })).json();
		expect(recreated.webhook_id).toBe(created.webhook_id);
		expect(recreated.secret).not.toBe(created.secret);
		expect((await call(`/webhooks/${recreated.webhook_id}`)).status).toBe(200);
	});

	it('sends correctly signed bytes and identities to the registered callback', async () => {
		const hook = await (await call('/webhooks', { method: 'POST', body: { name: 'Callback', url: 'https://n8n.example.com/webhook/test', events: ['export.ready'] } })).json();
		const realFetch = fetch;
		let delivery: RequestInit | undefined;
		vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
			if (String(input) !== hook.url) return realFetch(input, init);
			delivery = init;
			return new Response('{"received":true}', { status: 200 });
		}));
		try {
			const outcome = await realFetch(`${origin}/__control/deliver`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookId: hook.webhook_id }) });
			expect(await outcome.json()).toMatchObject({ status: 200 });
			expect(delivery?.headers).toMatchObject({ 'x-webhook-id': hook.webhook_id, 'x-webhook-signature': `sha256=${createHmac('sha256', hook.secret).update(String(delivery?.body)).digest('hex')}` });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('records rate-limit diagnostics and supports configuring the next sweep without resetting calls', async () => {
		await fetch(`${origin}/__control/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failures: [{ method: 'GET', path: '/indexes', status: 429, headers: { 'retry-after': '5' } }] }) });
		const limited = await call('/indexes');
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('5');
		expect((await call('/indexes')).status).toBe(200);
		expect((await (await fetch(`${origin}/__control/report`)).json()).counts['GET /indexes']).toBe(2);
	});
});
