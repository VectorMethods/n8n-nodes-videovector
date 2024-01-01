import { NodeConnectionTypes } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData, INodeListSearchResult, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { properties } from './descriptions';
import { executeOperation, record, rows } from './operations';
import { apiRequest, nodeError } from './transport';

function selectedIndex(ctx: ILoadOptionsFunctions): string {
 const selected = ctx.getNodeParameter('browseIndexId', { mode: 'id', value: '' }) as IDataObject | string;
 return typeof selected === 'string' ? selected : String(selected.value ?? '');
}
async function listSearch(ctx: ILoadOptionsFunctions, path: string, identity: string, filter = '', collection?: string, cursor?: string): Promise<INodeListSearchResult> {
 const response: unknown = await apiRequest.call(ctx, 'GET', path, undefined, cursor ? { cursor, limit: 100 } : path.endsWith('/videos') ? { limit: 100 } : undefined);
 const envelope = Array.isArray(response) ? undefined : record(response);
 const data = rows(envelope ? envelope[collection ?? 'data'] : response);
 const pattern = filter.toLocaleLowerCase();
 const results = data.map((row) => ({ name: String(row.name ?? row.title ?? row.prompt_name ?? row[identity]), value: String(row[identity]), description: String(row[identity]) })).filter((option) => `${option.name} ${option.value}`.toLocaleLowerCase().includes(pattern));
 const pagination = envelope?.pagination as IDataObject | undefined;
 return { results, ...(pagination?.has_more && pagination.next_cursor ? { paginationToken: String(pagination.next_cursor) } : {}) };
}

export class VideoVector implements INodeType {
 description: INodeTypeDescription = {
  displayName: 'VideoVector', name: 'videoVector', icon: { light: 'file:videovector.svg', dark: 'file:videovector.svg' }, group: ['transform'], version: 1,
  subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
  description: 'Upload, extract, search, and export video, audio, and image intelligence',
  defaults: { name: 'VideoVector' }, usableAsTool: true,
  inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
  credentials: [{ name: 'videoVectorApi', required: true }], properties,
 };
 methods = {
  listSearch: {
   async listIndexes(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> { return listSearch(this, '/indexes', 'index_id', filter); },
   async listPrompts(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> { return listSearch(this, '/prompts', 'prompt_id', filter, 'prompts'); },
   async listConnectors(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> { return listSearch(this, '/connectors', 'connector_id', filter); },
   async listRuns(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> { return listSearch(this, '/prompt-runs', 'run_id', filter); },
   async listMedia(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
    const index = selectedIndex(this);
    return listSearch(this, index ? `/indexes/${encodeURIComponent(index)}/videos` : '/playground/videos', 'video_id', filter, 'data', paginationToken);
   },
  },
 };
 async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
  const output: INodeExecutionData[] = [];
  for (let index = 0; index < this.getInputData().length; index++) {
   try { output.push(...await executeOperation(this, index)); }
   catch (error) {
    if (this.continueOnFail()) {
     const failure = nodeError(this, error, index);
     const diagnostics = failure.context;
     const statusCode = diagnostics.statusCode ?? ('httpCode' in failure ? failure.httpCode : undefined);
     const source = this.getInputData()[index];
     const details: IDataObject = {
      ...diagnostics,
      ...(statusCode ? { statusCode: String(statusCode) } : {}),
     };
     // n8n restores paired source JSON on its error output. Its native envelope
     // must contain only error/message/details; a top-level item.error would
     // cause the engine to replace all JSON with only the error message.
     const json: IDataObject = this.getNode().onError === 'continueErrorOutput'
      ? {
       error: failure.message,
       ...(failure.description ? { message: failure.description } : {}),
       details,
      }
      : {
       ...source.json,
       error: failure.message,
       ...(diagnostics.code ? { code: diagnostics.code } : {}),
       ...(statusCode ? { statusCode: String(statusCode) } : {}),
       ...(diagnostics.requestId ? { requestId: diagnostics.requestId } : {}),
       ...(diagnostics.retryAfter !== undefined ? { retryAfter: diagnostics.retryAfter } : {}),
       ...(failure.description ? { description: failure.description } : {}),
       details,
      };
     output.push({
      json,
      ...(source.binary ? { binary: source.binary } : {}),
      pairedItem: { item: index },
     });
     continue;
    }
    throw nodeError(this, error, index);
   }
  }
  return [output];
 }
}
