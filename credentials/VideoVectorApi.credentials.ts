import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class VideoVectorApi implements ICredentialType {
	name = 'videoVectorApi';
	displayName = 'VideoVector API';
	documentationUrl = 'https://vectormethods.com/docs/guides/n8n';
	icon = { light: 'file:../nodes/VideoVector/videovector.svg', dark: 'file:../nodes/VideoVector/videovector.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create an API key in VideoVector. Triggers require read, write, and admin scopes; index selectors also require search.',
		},
		{
			displayName: 'API Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.vectormethods.com/api/v2',
			required: true,
			description: 'The VideoVector API URL, including /api/v2. Change only when using another VideoVector deployment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: { 'X-API-Key': '={{$credentials.apiKey}}' },
		},
	};

	// Validation returns HTTP 204 and deliberately does not create or mutate resources.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/auth/validate',
			method: 'GET',
		},
	};
}
