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
  this: IExecuteFunctions, itemIndex: number, property: string,
  fields: IDataObject, idempotencyKey: string,
): Promise<IDataObject> {
  const binary = this.helpers.assertBinaryData(itemIndex, property);
  const signal = this.getExecutionCancelSignal?.();
  if (signal?.aborted) throw new NodeOperationError(this.getNode(), 'Upload cancelled.');
  const filename = binary.fileName || `upload.${binary.fileExtension || 'bin'}`;
  const bytes = binary.id ? undefined : Buffer.from(binary.data, 'base64');
  const size = binary.id ? (await this.helpers.getBinaryMetadata(binary.id)).fileSize : bytes!.length;
  if (!Number.isSafeInteger(size) || size <= 0) throw new NodeOperationError(this.getNode(), 'Upload requires a known, positive binary size.');
  const digest = createHash('sha256');
  if (binary.id) {
    // n8n binary references are immutable for this execution. Identify the same
    // stored source without scanning it before the native resumable transfer.
    digest.update(JSON.stringify(['n8n-binary-v1', binary.id, size, filename, binary.mimeType]));
  } else {
    const last = Math.max(0, size - 64 * 1024);
    for (const offset of new Set([0, Math.floor(last / 2), last])) digest.update(bytes!.subarray(offset, Math.min(size, offset + 64 * 1024)));
  }
  const job = object(await apiRequest.call(this, 'POST', '/workflow/attachments', fields, undefined, idempotencyKey));
  if (!job.upload) return job as IDataObject;
  const grant = object(job.upload);
  const base = `${await apiBase(this)}/workflow/attachments/${encodeURIComponent(String(job.job_id))}`;
  if (typeof job.job_id !== 'string' || grant.url !== `${base}/files` || grant.complete_url !== `${base}/complete`
    || typeof grant.token !== 'string' || !grant.token) throw new NodeOperationError(this.getNode(), 'Invalid attachment upload destination.');
  const fileId = createHash('sha256').update(`${idempotencyKey}\0${0}`).digest('hex');
  const scoped = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    try {
      return object(await this.helpers.httpRequest({ method: 'POST', url, body: body as IHttpRequestOptions['body'],
        headers: { Accept: 'application/json', Authorization: `Bearer ${String(grant.token)}` },
        json: true, timeout: 300000, disableFollowRedirect: true, abortSignal: signal }));
    } catch (error) { throw apiError(this, error); }
  };
  const prepared = await scoped(String(grant.url), { file_id: fileId, file_name: filename, content_type: binary.mimeType,
    size_bytes: size, last_modified: 0, sample_sha256: digest.digest('hex') });
  let source: Awaited<ReturnType<IExecuteFunctions['helpers']['getBinaryStream']>> | undefined;
  try {
    if (prepared.upload !== null) {
      const session = object(prepared.upload);
      let url: URL;
      try { url = new URL(String(session.url)); } catch { throw new NodeOperationError(this.getNode(), 'Invalid storage upload session.'); }
      if (session.transport !== 'resumable' || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || !(url.hostname === 'storage.googleapis.com' || url.hostname.endsWith('.storage.googleapis.com'))
        || session.total_bytes !== size || !Number.isSafeInteger(session.offset) || Number(session.offset) < 0 || Number(session.offset) > size
        || !Number.isSafeInteger(session.chunk_size) || Number(session.chunk_size) <= 0) throw new NodeOperationError(this.getNode(), 'Invalid storage upload session.');
      let offset = Number(session.offset);
      let position = 0; let pending = Buffer.alloc(0);
      source = binary.id ? await this.helpers.getBinaryStream(binary.id, 64 * 1024) : undefined;
      const iterator = source?.[Symbol.asyncIterator]();
      const read = async (start: number, length: number): Promise<Buffer> => {
        if (bytes) return bytes.subarray(start, start + length);
        const result = Buffer.alloc(length); let written = 0;
        while (written < length) {
          if (!pending.length) {
            const next = await iterator!.next();
            if (next.done) throw new NodeOperationError(this.getNode(), 'Upload source ended before its expected size.');
            pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
          }
          const skipped = Math.min(Math.max(0, start - position), pending.length);
          position += skipped; pending = pending.subarray(skipped);
          if (position < start) continue;
          const count = Math.min(pending.length, length - written);
          pending.copy(result, written, 0, count);
          written += count; position += count; pending = pending.subarray(count);
        }
        return result;
      };
      while (offset < size) {
        signal?.throwIfAborted();
        const start = offset; const end = Math.min(size, offset + Math.min(Number(session.chunk_size), 8 * 1024 * 1024));
        const chunk = await read(start, end - start);
        while (offset < end) {
          let transferred: Record<string, unknown>;
          try {
            transferred = object(await this.helpers.httpRequest({ method: 'PUT', url: url.toString(), body: chunk.subarray(offset - start),
              headers: { 'Content-Length': String(end - offset), 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
              returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 300000, disableFollowRedirect: true,
              sendCredentialsOnCrossOriginRedirect: false, abortSignal: signal }));
          } catch { throw new NodeOperationError(this.getNode(), 'Storage upload was not confirmed. Retry this execution to resume the same job.', { description: `Job: ${String(job.job_id)}` }); }
          const status = Number(transferred.statusCode);
          const range = String(object(transferred.headers).range ?? '').match(/^bytes=0-(\d+)$/);
          const confirmed = status === 308 ? (range ? Number(range[1]) + 1 : 0) : [200, 201].includes(status) ? size : 0;
          if (confirmed <= offset || confirmed > end) throw new NodeOperationError(this.getNode(), 'Storage did not confirm the uploaded bytes. Retry this execution to resume.', { description: `Job: ${String(job.job_id)}` });
          offset = confirmed;
        }
      }
    }
    await scoped(`${grant.url}/complete`, { file_id: fileId });
    return await scoped(String(grant.complete_url), { file_ids: [fileId] }) as IDataObject;
  } finally { source?.destroy(); }
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
