import { createHash, createHmac, timingSafeEqual } from 'crypto';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { apiRequest, nodeError } from '../VideoVector/transport';

interface Subscription extends IDataObject {
	webhook_id: string;
	secret?: string;
	url: string;
	events: string[];
	index_ids: string[] | null;
	status: string;
}

interface Registration extends IDataObject {
	id?: string;
	secret?: string;
	key: string;
	body: IDataObject;
	fingerprint: string;
	uncertain?: boolean;
}

function statusCode(error: unknown): number {
	const value = error as { httpCode?: string; statusCode?: number; response?: { status?: number } };
	return Number(value?.httpCode ?? value?.statusCode ?? value?.response?.status);
}

function registration(context: IHookFunctions | IWebhookFunctions): Registration | undefined {
	return context.getWorkflowStaticData('node').registration as Registration | undefined;
}

function setRegistration(context: IHookFunctions, value?: Registration): void {
	const data = context.getWorkflowStaticData('node');
	if (value) data.registration = value;
	else delete data.registration;
}

function sorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function sameStrings(left: string[] | null, right: string[] | null): boolean {
	return JSON.stringify(sorted(left ?? [])) === JSON.stringify(sorted(right ?? []));
}

function desiredSubscription(context: IHookFunctions): IDataObject {
	const url = context.getNodeWebhookUrl('default');
	if (!url?.startsWith('https://')) {
		throw new NodeOperationError(context.getNode(), 'VideoVector requires a public HTTPS webhook URL', {
			description: 'Configure n8n N8N_WEBHOOK_URL with your public HTTPS address before enabling this trigger.',
		});
	}
	const events = sorted(context.getNodeParameter('events') as string[]);
	if (events.length === 0) {
		throw new NodeOperationError(context.getNode(), 'Select at least one event');
	}
	const indexIds = sorted(context.getNodeParameter('indexIds', []) as string[]);
	const workflow = context.getWorkflow();
	const node = context.getNode();
	return {
		name: `n8n: ${workflow.id ?? workflow.name ?? 'workflow'} / ${node.id}`.slice(0, 100),
		url,
		events,
		index_ids: indexIds.length ? indexIds : null,
		metadata: { n8n_workflow_id: workflow.id ?? '', n8n_node_id: node.id },
	};
}

function fingerprint(body: IDataObject): string {
	return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function finishRegistration(context: IHookFunctions, state: Registration): Promise<void> {
	try {
		const result = (await apiRequest.call(context, 'POST', '/webhooks', state.body, undefined, state.key)) as Subscription;
		if (!result.webhook_id || !result.secret) {
			throw new NodeOperationError(context.getNode(), 'VideoVector did not return the webhook signing secret', {
				description: 'Retry activation to recover the subscription through its existing idempotency key.',
			});
		}
		state.id = result.webhook_id;
		state.secret = result.secret;
		setRegistration(context, state);
	} catch (error) {
		// A definitive rejection created no subscription. Keep uncertain outcomes for replay.
		if ([400, 401, 403, 404, 422].includes(statusCode(error)) && !state.uncertain) {
			setRegistration(context);
		} else {
			state.uncertain = true;
			setRegistration(context, state);
		}
		throw nodeError(context, error);
	}
}

async function removeRegistration(context: IHookFunctions): Promise<void> {
	const state = registration(context);
	let ids: string[];
	if (state?.id) ids = [state.id];
	else {
		// n8n saves static data after successful activation. A process restart can
		// therefore lose a pending POST response; discover only this node's exact
		// callback, never another workflow's subscription or its test/production peer.
		const url = state?.body.url ?? context.getNodeWebhookUrl('default');
		const subscriptions = (await apiRequest.call(context, 'GET', '/webhooks')) as Subscription[];
		ids = subscriptions.filter((hook) => {
			const metadata = hook.metadata as IDataObject | undefined;
			return hook.url === url && metadata?.n8n_workflow_id === context.getWorkflow().id && metadata?.n8n_node_id === context.getNode().id;
		}).map((hook) => hook.webhook_id);
	}
	for (const id of ids) {
		try {
			await apiRequest.call(context, 'DELETE', `/webhooks/${encodeURIComponent(id)}`);
		} catch (error) {
			if (statusCode(error) !== 404) {
				if (statusCode(error) === 403) {
					throw new NodeOperationError(context.getNode(), error as Error, {
						message: 'VideoVector could not remove the webhook subscription',
						description: 'Use an API key with admin scope to deactivate or replace this trigger. The subscription has been retained so cleanup can be retried.',
					});
				}
				throw nodeError(context, error);
			}
		}
	}
	// Creation idempotence belongs to the backend's live subscription row. Once
	// deleted, the same key recreates that row with a fresh signing secret.
	setRegistration(context);
}

export function verifySignature(rawBody: Buffer | undefined, signature: unknown, secret: string): boolean {
	if (!rawBody || typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
	const received = Buffer.from(signature.slice('sha256='.length), 'hex');
	const expected = createHmac('sha256', secret).update(rawBody).digest();
	return timingSafeEqual(received, expected);
}

export class VideoVectorTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'VideoVector Trigger',
		name: 'videoVectorTrigger',
		icon: { light: 'file:../VideoVector/videovector.svg', dark: 'file:../VideoVector/videovector.svg' },
		group: ['trigger'],
		version: 1,
		description: 'Start a workflow when VideoVector media, runs, imports, or exports change',
		subtitle: '={{$parameter["events"].join(", ")}}',
		defaults: { name: 'VideoVector Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'videoVectorApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Use an API key with read, write, and admin scopes. Admin is required to remove subscriptions when testing, deactivating, or changing this trigger.',
				name: 'scopeNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Event Names or IDs',
				name: 'events',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getEvents' },
				default: [],
				required: true,
				description: 'Events that start this workflow. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Index Names or IDs',
				name: 'indexIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getIndexes' },
				default: [],
				description: 'Leave empty for all indexes. Events without an index still arrive. Loading the list requires search scope. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getEvents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const events = (await apiRequest.call(this, 'GET', '/webhooks/events')) as string[];
				return events.map((event) => ({ name: event, value: event })).sort((a, b) => a.name.localeCompare(b.name));
			},
			async getIndexes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const indexes = (await apiRequest.call(this, 'GET', '/indexes', undefined, { include_defaults: false })) as Array<{ index_id: string; name: string }>;
				return indexes.map((index) => ({ name: index.name, value: index.index_id })).sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const desired = desiredSubscription(this);
				const state = registration(this);
				if (!state?.id) return false;
				let remote: Subscription;
				try {
					remote = (await apiRequest.call(this, 'GET', `/webhooks/${encodeURIComponent(state.id)}`)) as Subscription;
				} catch (error) {
					if (statusCode(error) !== 404) throw nodeError(this, error);
					setRegistration(this);
					return false;
				}
				if (
					state.secret && remote.status === 'active' && remote.url === desired.url &&
					sameStrings(remote.events, desired.events as string[]) &&
					sameStrings(remote.index_ids, desired.index_ids as string[] | null)
				) return true;
				await removeRegistration(this);
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const body = desiredSubscription(this);
				const requestFingerprint = fingerprint(body);
				let state = registration(this);
				if (state && state.fingerprint !== requestFingerprint) {
					await removeRegistration(this);
					state = undefined;
				}
				if (!state) {
					const key = `n8n-webhook-${requestFingerprint}`;
					state = { key, body, fingerprint: requestFingerprint };
					setRegistration(this, state);
				}
				await finishRegistration(this, state);
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				await removeRegistration(this);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = registration(this);
		const request = this.getRequestObject();
		const headers = this.getHeaderData();
		const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : undefined;
		if (
			!state?.secret || headers['x-webhook-id'] !== state.id ||
			!verifySignature(rawBody, headers['x-webhook-signature'], state.secret)
		) {
			this.getResponseObject().status(401).json({ error: 'Invalid webhook signature or subscription' });
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData();
		return {
			webhookResponse: { received: true },
			workflowData: [[{
				json: {
					...body,
					_delivery: {
						webhook_id: state.id,
						delivery_id: headers['x-delivery-id'] ?? null,
						idempotency_key: headers['idempotency-key'] ?? null,
						attempt_id: headers['x-delivery-attempt-id'] ?? null,
					},
				},
			}]],
		};
	}
}
