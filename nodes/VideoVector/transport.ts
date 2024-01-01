import { createHash } from 'node:crypto';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type {
  IBinaryData, IDataObject, IExecuteFunctions, IHookFunctions, IHttpRequestOptions,
  ILoadOptionsFunctions, IWebhookFunctions, JsonObject,
} from 'n8n-workflow';

export type ApiContext = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions;
export const DEFAULT_API_URL = 'https://api.vectormethods.com/api/v2';

export async function apiBase(context: ApiContext): Promise<string> {
  const credentials = await context.getCredentials('videoVectorApi');
  const base = String(credentials.baseUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new NodeOperationError(context.getNode(), 'The API URL must be an HTTP or HTTPS base URL without credentials, a query, or a fragment.');
  }
  return base;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function responseBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); }
  catch { return {}; }
}

/** Keep API diagnostics without retaining credential-bearing HTTP request objects. */
function apiError(context: ApiContext, error: unknown): NodeApiError {
  const outer = object(error);
  // The native authenticated helper wraps the HTTP error in NodeApiError.
  // Read its original response, then keep only public API diagnostics.
  const cause = object(outer.cause ?? outer.errorResponse ?? error);
  const response = object(cause.response ?? outer.response);
  const body = responseBody(response.body ?? response.data ?? cause.error ?? object(outer.context).data);
  const nested = object(body.error);
  const detail = object(body.detail);
  const headers = object(response.headers);
  const status = Number(response.status ?? response.statusCode ?? cause.statusCode ?? outer.httpCode);
  const message = String(nested.message ?? body.message ?? detail.message ??
    (typeof body.detail === 'string' ? body.detail : undefined) ?? outer.description ?? cause.message ?? outer.message ?? 'VideoVector request failed');
  const requestId = headers['x-request-id'] ?? headers['x-correlation-id'] ?? body.request_id;
  const code = nested.code ?? body.error_code ?? body.code ?? detail.code;
  const retryAfter = headers['retry-after'];
  const diagnostics = [code && `Code: ${String(code)}`, requestId && `Request ID: ${String(requestId)}`,
    retryAfter && `Retry after: ${String(retryAfter)} seconds`].filter(Boolean).join(' · ');
  const safe: JsonObject = { message };
  if (Number.isFinite(status)) safe.statusCode = status;
  const result = new NodeApiError(context.getNode(), safe, {
    message,
    description: diagnostics || undefined,
    httpCode: Number.isFinite(status) ? String(status) : undefined,
  });
  result.context = {
    ...(code ? { code: String(code) } : {}),
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...(retryAfter !== undefined ? { retryAfter: String(retryAfter) } : {}),
    ...(Number.isFinite(status) ? { statusCode: status } : {}),
  };
  return result;
}

/** Preserve native error identity and HTTP diagnostics when adding item context. */
export function nodeError(context: ApiContext, error: unknown, itemIndex?: number): NodeApiError | NodeOperationError {
  const result = error instanceof NodeApiError || error instanceof NodeOperationError
    ? error
    : new NodeOperationError(context.getNode(), error instanceof Error ? error : String(error));
  if (itemIndex !== undefined) result.context = { ...result.context, itemIndex };
  return result;
}

export async function apiRequest<T = IDataObject>(
  this: ApiContext,
  method: IHttpRequestOptions['method'],
  path: string,
  body?: unknown,
  qs?: IDataObject,
  idempotencyKey?: string,
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new NodeOperationError(this.getNode(), 'API paths must be relative to the configured VideoVector API.');
  }
  // n8n's request helper drops empty objects. Keep an explicit JSON body when
  // endpoints require it, while preserving genuinely bodyless requests.
  const emptyJson = body !== null && typeof body === 'object' &&
    !Array.isArray(body) && Object.keys(body).length === 0;
  try {
    return await this.helpers.httpRequestWithAuthentication.call(this, 'videoVectorApi', {
      method,
      url: `${await apiBase(this)}${path}`,
      body: (emptyJson ? '{}' : body) as IHttpRequestOptions['body'],
      qs,
      headers: { Accept: 'application/json', ...(emptyJson ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      json: true,
      timeout: 300000,
      disableFollowRedirect: true,
    }) as T;
  } catch (error) {
    throw apiError(this, error);
  }
}

/** Execution context survives n8n's Retry Execution and Retry On Fail. */
export function operationKey(this: IExecuteFunctions, itemIndex: number, operation: string, suffix = ''): string {
  const override = String(this.getNodeParameter('idempotencyKey', itemIndex, '') || '').trim();
  const context = this.getContext('node');
  if (!context.videoVectorIdempotencyRoot) context.videoVectorIdempotencyRoot = this.getExecutionId();
  const parts = override
    ? ['external', override, operation, suffix]
    : [context.videoVectorIdempotencyRoot, this.getNode().id,
      this.getWorkflowDataProxy(itemIndex).$runIndex, itemIndex, operation, suffix];
  return `n8n-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

export async function uploadBinary(
  this: IExecuteFunctions,
  itemIndex: number,
  property: string,
  fields: IDataObject,
  idempotencyKey: string,
): Promise<IDataObject> {
  const binary = this.helpers.assertBinaryData(itemIndex, property);
  const filename = binary.fileName || `upload.${binary.fileExtension || 'bin'}`;
  let body: unknown;
  const headers: Record<string, string> = { Accept: 'application/json', 'Idempotency-Key': idempotencyKey };
  if (binary.id) {
    // Axios' native multipart serializer reads name as filename metadata.
    // Never change path: stored binary streams may open it lazily.
    const stream = await this.helpers.getBinaryStream(binary.id);
    Object.assign(stream, { name: filename });
    body = { ...fields, file: stream };
    headers['Content-Type'] = 'multipart/form-data';
  } else {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(Buffer.from(binary.data, 'base64'))], { type: binary.mimeType }), filename);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    body = form;
  }
  try {
    return await this.helpers.httpRequestWithAuthentication.call(this, 'videoVectorApi', {
      method: 'POST', url: `${await apiBase(this)}/workflow/upload`,
      body: body as IHttpRequestOptions['body'], headers, json: true,
      timeout: 300000, disableFollowRedirect: true,
    }) as IDataObject;
  } catch (error) {
    throw apiError(this, error);
  }
}

export async function downloadBinary(
  this: IExecuteFunctions, url: string, filename?: string, mimeType?: string,
): Promise<IBinaryData> {
  try {
    const response = await this.helpers.httpRequest({
      method: 'GET', url, encoding: 'stream', returnFullResponse: true,
      timeout: 300000, sendCredentialsOnCrossOriginRedirect: false,
    });
    const disposition = String(response.headers['content-disposition'] || '');
    const suppliedName = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
    const downloadName = filename || (suppliedName?.[1] ?? suppliedName?.[2])?.trim().replace(/[\\/]/g, '_');
    return await this.helpers.prepareBinaryData(response.body, downloadName,
      mimeType || String(response.headers['content-type'] || 'application/octet-stream'));
  } catch (error) {
    throw apiError(this, error);
  }
}
