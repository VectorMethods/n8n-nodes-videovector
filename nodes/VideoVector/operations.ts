import { jsonParse, NodeOperationError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { apiRequest, downloadBinary, operationKey, uploadBinary } from './transport';

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
 if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an API object response');
 return value as RecordValue;
}
export function rows(value: unknown): IDataObject[] {
 if (!Array.isArray(value)) throw new Error('Expected an API array response');
 return value.map((entry) => record(entry) as IDataObject);
}
function jsonValue(value: unknown, label: string): unknown {
 if (typeof value !== 'string') return value;
 return jsonParse<unknown>(value, { errorMessage: `${label} must contain valid JSON` });
}
function cleanFields(value: unknown, preserveEmptyDescription: boolean): IDataObject {
 const result: IDataObject = {};
 const jsonFields = new Set(['json_schema', 'video_level', 'semantic_indexing', 'execution_config', 'selection_filter', 'run_ids', 'index_ids', 'search_fields', 'prompt_run_ids', 'filters']);
 for (const [key, raw] of Object.entries(record(value))) {
  if (raw === undefined || (raw === '' && !(preserveEmptyDescription && key === 'description'))) continue;
  result[key] = (jsonFields.has(key) ? jsonValue(raw, key) : raw) as IDataObject[string];
 }
 return result;
}
const encoded = (value: string): string => encodeURIComponent(value);
function parameter(ctx: IExecuteFunctions, i: number, name: string, fallback: string = ''): string {
 const value = ctx.getNodeParameter(name, i, fallback);
 if (typeof value === 'object' && value !== null && 'value' in value) return String(value.value);
 return String(value);
}
function arrayParameter(ctx: IExecuteFunctions, i: number, name: string): IDataObject[string] {
 const value = jsonValue(ctx.getNodeParameter(name, i), name);
 if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty JSON array`);
 return value as IDataObject[string];
}
function scopeFields(ctx: IExecuteFunctions, i: number, name: string): IDataObject {
 switch (parameter(ctx, i, name, 'index')) {
  case 'index': return { index_id: parameter(ctx, i, 'indexId') };
  case 'videos': return { video_ids: arrayParameter(ctx, i, 'videoIds') };
  case 'runs': return { prompt_run_ids: arrayParameter(ctx, i, 'runIds') };
  default: return {};
 }
}
function destination(ctx: IExecuteFunctions, i: number): IDataObject {
 switch (parameter(ctx, i, 'destination', 'index')) {
  case 'index': return { index_id: parameter(ctx, i, 'indexId') };
  case 'newIndex': return { index_name: parameter(ctx, i, 'indexName') };
  default: return {};
 }
}
const item = (json: unknown, index: number): INodeExecutionData => ({ json: record(json) as IDataObject, pairedItem: { item: index } });
function emit(response: unknown, index: number, full: boolean, collection?: string): INodeExecutionData[] {
 if (full) return [item(Array.isArray(response) ? { data: response } : response, index)];
 if (collection) return rows(record(response)[collection]).map((row) => item(row, index));
 return Array.isArray(response) ? rows(response).map((row) => item(row, index)) : [item(response, index)];
}
function nextCursor(page: RecordValue): string | undefined {
 const pagination = record(page.pagination);
 return pagination.has_more && typeof pagination.next_cursor === 'string' && pagination.next_cursor ? pagination.next_cursor : undefined;
}

/** Fetch only cursors exposed by the server; each full-response item remains an untouched page. */
export async function paginate(
 ctx: IExecuteFunctions, index: number, path: string, query: IDataObject, full: boolean,
): Promise<INodeExecutionData[]> {
 const all = ctx.getNodeParameter('returnAll', index, false) as boolean;
 const limit = ctx.getNodeParameter('limit', index, 50) as number;
 let cursor = parameter(ctx, index, 'cursor') || undefined;
 const output: INodeExecutionData[] = [];
 const seen = new Set<string>();
 do {
  const response = record(await apiRequest.call(ctx, 'GET', path, undefined, { ...query, limit: all ? 100 : limit, ...(cursor ? { cursor } : {}) }));
  output.push(...emit(response, index, full, 'data'));
  cursor = all ? nextCursor(response) : undefined;
  if (cursor && seen.has(cursor)) throw new Error('The API repeated a pagination cursor');
  if (cursor) seen.add(cursor);
 } while (cursor);
 return output;
}

/** A finished stream is excluded from later requests so it cannot restart at page one. */
export async function runResults(ctx: IExecuteFunctions, index: number, full: boolean, fields: IDataObject): Promise<INodeExecutionData[]> {
 const selected = parameter(ctx, index, 'view', 'unfiltered');
 const all = ctx.getNodeParameter('returnAll', index, false) as boolean;
 let pending = selected === 'both' ? ['filtered', 'unfiltered'] : [selected];
 const cursors: Record<string, string> = {};
 for (const stream of pending) if (fields[`${stream}_cursor`]) cursors[stream] = String(fields[`${stream}_cursor`]);
 const seen: Record<string, Set<string>> = { filtered: new Set(), unfiltered: new Set() };
 const output: INodeExecutionData[] = [];
 while (pending.length) {
  const query: IDataObject = {
   result_level: parameter(ctx, index, 'resultLevel', 'segment'),
   view: pending.length === 2 ? 'both' : pending[0],
   limit: all ? 50 : ctx.getNodeParameter('limit', index, 50) as number,
  };
  if (fields.video_id) query.video_id = fields.video_id;
  for (const stream of pending) if (cursors[stream]) query[`${stream}_cursor`] = cursors[stream];
  const response = record(await apiRequest.call(ctx, 'GET', `/workflow/runs/${encoded(parameter(ctx, index, 'runId'))}/results`, undefined, query));
  if (full) output.push(item(response, index));
  const next: string[] = [];
  for (const stream of pending) {
   const page = response[stream];
   if (page == null) {
    if (!full && stream === 'unfiltered') throw new NodeOperationError(ctx.getNode(), 'Extraction results are unavailable', { itemIndex: index, description: `Run ${String(response.run_id)} is ${String(response.status)}. Wait for a terminal run status, or enable Full Response to inspect readiness.` });
    if (!full && selected === 'filtered') throw new NodeOperationError(ctx.getNode(), 'Selected results are unavailable', { itemIndex: index, description: 'Selection may be pending, failed, or absent. Enable Full Response to inspect selection_summary, or select All Extracted Results.' });
    continue;
   }
   const parsed = record(page);
   if (!full) output.push(...rows(parsed.data).map((row) => item({ ...row, _videovector: { run_id: response.run_id, status: response.status, result_level: response.result_level, view: stream, selection_summary: response.selection_summary } }, index)));
   const cursor = all ? nextCursor(parsed) : undefined;
   if (cursor) {
    if (seen[stream].has(cursor)) throw new Error(`The API repeated the ${stream} pagination cursor`);
    seen[stream].add(cursor);
    cursors[stream] = cursor;
    next.push(stream);
   }
  }
  pending = next;
 }
 return output;
}

export async function executeOperation(ctx: IExecuteFunctions, index: number): Promise<INodeExecutionData[]> {
 const resource = parameter(ctx, index, 'resource');
 const operation = parameter(ctx, index, 'operation');
 const full = ctx.getNodeParameter('fullResponse', index, false) as boolean;
 const fields = cleanFields(ctx.getNodeParameter('additionalFields', index, {}), resource === 'prompt' && operation === 'update');
 const key = (suffix?: string) => operationKey.call(ctx, index, `${resource}.${operation}`, suffix);
 const pathId = (name: string) => encoded(parameter(ctx, index, name));
 const get = async (path: string, query?: IDataObject) => apiRequest.call(ctx, 'GET', path, undefined, query);
 const post = async (path: string, body?: IDataObject, suffix?: string) => apiRequest.call(ctx, 'POST', path, body, undefined, key(suffix));
 let response: unknown;

 if (resource === 'index') {
  if (operation === 'create') response = await post('/indexes', { name: parameter(ctx, index, 'name') });
  else if (operation === 'list') response = await get('/indexes', fields);
  else if (operation === 'get') response = await get(`/indexes/${pathId('indexId')}`);
  else if (operation === 'delete') response = await apiRequest.call(ctx, 'DELETE', `/indexes/${pathId('indexId')}`, undefined, undefined, key());
  else if (operation === 'deletionStatus') response = await get(`/indexes/${pathId('indexId')}/deletion`);
 }
 if (resource === 'media') {
  if (operation === 'upload') response = await uploadBinary.call(ctx, index, parameter(ctx, index, 'binaryProperty', 'data'), { ...destination(ctx, index), ...fields }, key());
  else if (operation === 'importUrls') response = await post('/workflow/attachments', { ...destination(ctx, index), ...fields, files: arrayParameter(ctx, index, 'files') });
  else if (operation === 'get') response = await get(`/videos/${pathId('videoId')}`);
  else if (operation === 'delete') response = await apiRequest.call(ctx, 'DELETE', `/videos/${pathId('videoId')}`, undefined, undefined, key());
  else if (operation === 'deletionStatus') response = await get(`/videos/${pathId('videoId')}/deletion`);
  else if (operation === 'list') return paginate(ctx, index, parameter(ctx, index, 'destination', 'index') === 'index' ? `/indexes/${pathId('indexId')}/videos` : '/playground/videos', {}, full);
  else if (operation === 'segments') return paginate(ctx, index, `/videos/${pathId('videoId')}/segments`, fields, full);
  else if (operation === 'download') {
   const { fileName, ...body } = fields;
   const grant = record(await apiRequest.call(ctx, 'POST', '/workflow/media-grants', { ...body, video_id: parameter(ctx, index, 'videoId'), intent: 'download' }));
   const binary = await downloadBinary.call(ctx, String(grant.url), fileName ? String(fileName) : typeof grant.filename === 'string' ? grant.filename : undefined, typeof grant.mime_type === 'string' ? grant.mime_type : undefined);
   return [{ json: { video_id: parameter(ctx, index, 'videoId'), ...body }, binary: { [parameter(ctx, index, 'outputBinaryProperty', 'data')]: binary }, pairedItem: { item: index } }];
  }
 }
 if (resource === 'prompt') {
  if (operation === 'define') response = await post('/workflow/define', { instruction: parameter(ctx, index, 'instruction'), ...fields });
  else if (operation === 'create') response = await post('/prompts', { name: parameter(ctx, index, 'name'), prompt_text: parameter(ctx, index, 'promptText'), json_schema: record(jsonValue(ctx.getNodeParameter('jsonSchema', index), 'JSON Schema')) as IDataObject, ...fields });
  else if (operation === 'update') response = await apiRequest.call(ctx, 'PUT', `/prompts/${pathId('promptId')}`, fields, undefined, key());
  else if (operation === 'delete') response = await apiRequest.call(ctx, 'DELETE', `/prompts/${pathId('promptId')}`, undefined, undefined, key());
  else if (operation === 'get') response = await get(`/prompts/${pathId('promptId')}`);
  else if (operation === 'list') return emit(await get('/prompts', fields), index, full, 'prompts');
 }
 if (resource === 'run') {
  if (operation === 'start') response = await post('/workflow/process', { ...(parameter(ctx, index, 'promptSource', 'saved') === 'saved' ? { prompt_id: parameter(ctx, index, 'promptId') } : { prompt_instruction: parameter(ctx, index, 'instruction') }), ...scopeFields(ctx, index, 'target'), ...fields });
  else if (operation === 'estimate') response = await apiRequest.call(ctx, 'POST', '/prompt-runs/estimate', { prompt_id: parameter(ctx, index, 'promptId'), target: { type: parameter(ctx, index, 'target', 'index'), ...scopeFields(ctx, index, 'target') }, ...fields });
  else if (operation === 'get') response = await get(`/prompt-runs/${pathId('runId')}`);
  else if (operation === 'list') {
   const scope = parameter(ctx, index, 'listScope', 'index');
   if (scope === 'index') return paginate(ctx, index, `/indexes/${pathId('indexId')}/prompt-runs`, {}, full);
   response = await get(scope === 'video' ? `/videos/${pathId('videoId')}/prompt-runs` : '/prompt-runs', { limit: ctx.getNodeParameter('limit', index, 50) as number });
  } else if (operation === 'results') return runResults(ctx, index, full, fields);
  else if (operation === 'cancel') response = await post(`/prompt-runs/${pathId('runId')}/cancel`);
  else if (operation === 'failures') response = await get(`/prompt-runs/${pathId('runId')}/failed-segments`);
  else if (operation === 'retrySegment') response = await post(`/prompt-runs/${pathId('runId')}/videos/${pathId('videoId')}/segments/${pathId('segmentId')}/retry`);
  else if (operation === 'retryStatus') response = await get(`/prompt-runs/${pathId('runId')}/videos/${pathId('videoId')}/segments/${pathId('segmentId')}/retries/${pathId('retryId')}`);
 }
 if (resource === 'search') {
  if (operation === 'semantic' || operation === 'condition') {
   const all = ctx.getNodeParameter('returnAll', index, false) as boolean;
   const cursor = parameter(ctx, index, 'cursor');
   let page = record(cursor ? await get('/workflow/search/page', { cursor }) : await post('/workflow/search', {
    ...scopeFields(ctx, index, 'searchScope'), ...fields,
    ...(operation === 'semantic' ? { query: parameter(ctx, index, 'query') } : { filters: arrayParameter(ctx, index, 'filters') }),
    result_level: parameter(ctx, index, 'resultLevel', 'segment'), limit: ctx.getNodeParameter('limit', index, 50) as number,
   }));
   const output = emit(page, index, full, 'data');
   const seen = new Set<string>();
   let next = all ? nextCursor(page) : undefined;
   while (next) {
    if (seen.has(next)) throw new Error('The API repeated a search pagination cursor');
    seen.add(next);
    page = record(await get('/workflow/search/page', { cursor: next }));
    output.push(...emit(page, index, full, 'data'));
    next = nextCursor(page);
   }
   return output;
  }
  if (operation === 'image' || operation === 'multimodal') {
   const image = await ctx.helpers.getBinaryDataBuffer(index, parameter(ctx, index, 'binaryProperty', 'data'));
   const body: IDataObject = { ...fields, image_data: image.toString('base64'), top_k: ctx.getNodeParameter('limit', index, 20) as number };
   if (operation === 'multimodal') {
    body.text_query = parameter(ctx, index, 'query');
    if (typeof body.text_weight === 'number') body.image_weight = 1 - body.text_weight;
   }
   response = await post(`/indexes/${pathId('indexId')}/${operation === 'image' ? 'image-search' : 'multimodal-search'}`, body);
  } else if (operation.startsWith('sql')) {
   const body: IDataObject = {};
   for (const name of ['run_ids', 'index_ids']) if (fields[name] !== undefined) body[name] = fields[name];
   const base = `/search/sql/${pathId('indexId')}`;
   if (operation === 'sqlCatalog') return emit(await apiRequest.call(ctx, 'POST', `${base}/catalog`, body), index, full, 'tables');
   if (operation === 'sqlGenerate') response = await post(`${base}/generate`, { ...body, instruction: parameter(ctx, index, 'instruction'), ...(fields.existing_query ? { existing_query: fields.existing_query } : {}) });
   if (operation === 'sqlExecute') {
    response = await apiRequest.call(ctx, 'POST', base, { ...body, query: parameter(ctx, index, 'query'), ...(fields.result_limit ? { result_limit: fields.result_limit } : {}) });
    if (!full) {
     const result = record(response);
     const contexts = Array.isArray(result.row_context) ? result.row_context : [];
     return rows(result.rows).map((row, rowIndex) => item({ ...row, _videovector: { row_context: contexts[rowIndex] ?? null, truncated: result.truncated, applied_result_limit: result.applied_result_limit } }, index));
    }
   }
  } else if (operation === 'agentic') {
   let sessionId = fields.session_id;
   if (!sessionId) sessionId = record(await post('/chat/sessions', fields.title ? { title: fields.title } : {}, 'session')).session_id as string;
   response = await post(`/chat/sessions/${encoded(String(sessionId))}/turns`, { message: parameter(ctx, index, 'query'), scope: { ...(fields.index_ids ? { index_ids: fields.index_ids } : {}), ...(fields.prompt_run_ids ? { prompt_run_ids: fields.prompt_run_ids } : {}) } }, 'turn');
  }
 }
 if (resource === 'import') {
  if (operation === 'start') response = await post('/import-jobs', { connector_id: parameter(ctx, index, 'connectorId'), index_id: parameter(ctx, index, 'indexId'), ...fields });
  else if (operation === 'get') response = await get(`/import-jobs/${pathId('jobId')}`);
  else if (operation === 'list') response = await get('/import-jobs', { ...fields, limit: ctx.getNodeParameter('limit', index, 50) as number });
  else if (operation === 'cancel') response = await post(`/import-jobs/${pathId('jobId')}/cancel`);
  else if (operation === 'retry') response = await post(`/import-jobs/${pathId('jobId')}/retry`);
  else if (operation === 'files') {
   const job = record(await get(`/import-jobs/${pathId('jobId')}`));
   if (full) return [item(job, index)];
   if (!Array.isArray(job.video_ids)) throw new Error('Import response did not include video_ids');
   const output: INodeExecutionData[] = [];
   for (let offset = 0; offset < job.video_ids.length; offset += 100) {
    const media = rows(await apiRequest.call(ctx, 'POST', '/videos/batch', { video_ids: job.video_ids.slice(offset, offset + 100) as string[] }));
    output.push(...media.map((video) => item({ ...video, _videovector: { job_id: job.job_id, status: job.status, progress: job.progress, failed_files: job.failed_files, skipped_files: job.skipped_files } }, index)));
   }
   return output;
  }
 }
 if (resource === 'export') {
  if (operation === 'create') {
   const source = parameter(ctx, index, 'exportSource', 'run');
   if (source === 'run' && fields.prompt_run_ids !== undefined) throw new Error('Run IDs are only supported for index exports');
   response = await post(source === 'index' ? `/exports/index/${pathId('indexId')}` : `/exports/prompt-run/${pathId('runId')}`, fields);
  } else if (operation === 'get') response = await get(`/exports/${pathId('exportId')}`);
  else if (operation === 'list') response = await get('/exports', { limit: ctx.getNodeParameter('limit', index, 50) as number });
  else if (operation === 'download') {
   const grant = record(await apiRequest.call(ctx, 'POST', `/exports/${pathId('exportId')}/download-url`));
   if (typeof grant.download_url !== 'string' || !grant.download_url) throw new NodeOperationError(ctx.getNode(), 'Export is not available for download', { itemIndex: index, description: `Export status: ${String(grant.status)}. Connector exports are delivered to storage; download exports must finish first.` });
   const binary = await downloadBinary.call(ctx, grant.download_url);
   return [{ json: { export_id: parameter(ctx, index, 'exportId'), status: grant.status as string }, binary: { [parameter(ctx, index, 'outputBinaryProperty', 'data')]: binary }, pairedItem: { item: index } }];
  }
 }
 if (response === undefined) throw new NodeOperationError(ctx.getNode(), `Unsupported operation: ${resource}.${operation}`, { itemIndex: index });
 return emit(response, index, full);
}
