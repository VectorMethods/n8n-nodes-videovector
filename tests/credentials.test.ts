import { describe, expect, it } from 'vitest';

import { VideoVectorApi } from '../credentials/VideoVectorApi.credentials';

describe('VideoVector credentials', () => {
	const credentials = new VideoVectorApi();

	it('stores the API key as a password and authenticates using the canonical header', () => {
		expect(credentials.properties.find((field) => field.name === 'apiKey')).toMatchObject({
			typeOptions: { password: true },
			required: true,
		});
		expect(credentials.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { 'X-API-Key': '={{$credentials.apiKey}}' } },
		});
	});

	it('uses the production base URL and a read-only 204-compatible credential test', () => {
		expect(credentials.properties.find((field) => field.name === 'baseUrl')?.default).toBe('https://api.vectormethods.com/api/v2');
		expect(credentials.test.request).toMatchObject({ method: 'GET', url: '/auth/validate' });
		expect(credentials.test.rules).toBeUndefined();
	});
});
