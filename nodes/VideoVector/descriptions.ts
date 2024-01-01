import type { INodeProperties } from 'n8n-workflow';

export const operationNames: Record<string, Array<[string, string, string]>> = {
 index: [['create', 'Create', 'Create an index'], ['get', 'Get', 'Get an index'], ['list', 'Get Many', 'List indexes'], ['delete', 'Delete', 'Delete an index and its media'], ['deletionStatus', 'Get Deletion Status', 'Get durable deletion status']],
 media: [['upload', 'Upload', 'Upload an n8n binary file'], ['importUrls', 'Import URLs', 'Import media from download URLs'], ['get', 'Get', 'Get a media item'], ['list', 'Get Many', 'List media in an index or playground'], ['segments', 'Get Segments', 'List processing segments'], ['download', 'Download', 'Download media or an exact run segment'], ['delete', 'Delete', 'Delete a media item'], ['deletionStatus', 'Get Deletion Status', 'Get durable deletion status']],
 prompt: [['define', 'Define From Instructions', 'Generate a prompt from plain language'], ['create', 'Create', 'Create a prompt with a JSON schema'], ['get', 'Get', 'Get a prompt'], ['list', 'Get Many', 'List prompts'], ['update', 'Update', 'Update a prompt'], ['delete', 'Delete', 'Delete a prompt']],
 run: [['start', 'Start', 'Process media using a prompt'], ['estimate', 'Estimate', 'Estimate a saved prompt execution'], ['get', 'Get', 'Get processing status'], ['list', 'Get Many', 'List prompt runs'], ['results', 'Get Results', 'Get extracted or selected results'], ['cancel', 'Cancel', 'Cancel a run'], ['failures', 'Get Failures', 'Inspect failed segments'], ['retrySegment', 'Retry Failed Segment', 'Retry a failed segment in a finished run'], ['retryStatus', 'Get Retry Status', 'Get a segment retry status']],
 search: [['semantic', 'Semantic Search', 'Search media using plain language'], ['condition', 'Condition Search', 'Search using structured conditions'], ['image', 'Image Search', 'Find similar images'], ['multimodal', 'Multimodal Search', 'Search using text and an image'], ['sqlCatalog', 'Get SQL Catalog', 'Get available SQL tables and columns'], ['sqlGenerate', 'Generate SQL', 'Generate SQL from an instruction'], ['sqlExecute', 'Execute SQL', 'Execute a read-only SQL search'], ['agentic', 'Agentic Search', 'Ask the search agent a question']],
 import: [['start', 'Start', 'Import media from an existing storage connector'], ['get', 'Get', 'Get import status and progress'], ['list', 'Get Many', 'List import jobs'], ['files', 'Get Imported Files', 'Get media imported by a job'], ['cancel', 'Cancel', 'Cancel an import'], ['retry', 'Retry Attachments', 'Retry failed or cancelled attachment imports']],
 export: [['create', 'Create', 'Create an index or run export'], ['get', 'Get', 'Get export status'], ['list', 'Get Many', 'List exports'], ['download', 'Download', 'Download a completed export']],
};

type Show = NonNullable<INodeProperties['displayOptions']>['show'];
const shown = (resource: string, operation: string[], extra: Show = {}): INodeProperties['displayOptions'] => ({ show: { resource: [resource], operation, ...extra } });
function field(displayName: string, name: string, type: INodeProperties['type'], defaultValue: INodeProperties['default'], extra: Partial<INodeProperties> = {}): INodeProperties {
 return { displayName, name, type, default: defaultValue, ...extra };
}
function options(displayName: string, name: string, values: Array<[string, string]>, defaultValue: string, extra: Partial<INodeProperties> = {}): INodeProperties {
 return field(displayName, name, 'options', defaultValue, { options: values.map(([value, label]) => ({ name: label, value })), ...extra });
}
function locator(displayName: string, name: string, method: string, displayOptions: INodeProperties['displayOptions']): INodeProperties {
 return field(displayName, name, 'resourceLocator', { mode: 'list', value: '' }, { required: true, displayOptions, modes: [
  { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod: method, searchable: true } },
  { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Enter an ID or use an expression' },
 ] });
}
const json = (displayName: string, name: string, defaultValue: string, extra: Partial<INodeProperties> = {}) => field(displayName, name, 'json', defaultValue, extra);
const text = (displayName: string, name: string, extra: Partial<INodeProperties> = {}) => field(displayName, name, 'string', '', extra);
const bool = (displayName: string, name: string, defaultValue = false, extra: Partial<INodeProperties> = {}) => field(displayName, name, 'boolean', defaultValue, extra);
const number = (displayName: string, name: string, defaultValue: number, max: number, extra: Partial<INodeProperties> = {}) => field(displayName, name, 'number', defaultValue, { typeOptions: { minValue: 1, maxValue: max }, ...extra });
const id = (name: string, show: INodeProperties['displayOptions']) => locator({ indexId: 'Index', promptId: 'Prompt', videoId: 'Media', runId: 'Run', connectorId: 'Connector' }[name]!, name, { indexId: 'listIndexes', promptId: 'listPrompts', videoId: 'listMedia', runId: 'listRuns', connectorId: 'listConnectors' }[name]!, show);
const executionFields: INodeProperties[] = [
 options('Video Segmentation', 'video_segmentation_type', [['content_aware', 'Content Aware'], ['fixed', 'Fixed Duration']], 'content_aware'),
 options('Audio Segmentation', 'audio_segmentation_type', [['content_aware', 'Content Aware'], ['fixed', 'Fixed Duration']], 'content_aware'),
 number('Video Segment Duration', 'video_segment_duration', 10, 300, { description: 'Fixed segment duration in seconds' }),
 number('Audio Segment Duration', 'audio_segment_duration', 10, 300, { description: 'Fixed segment duration in seconds' }),
 text('Processing Model', 'processing_model', { description: 'Model ID from the VideoVector pricing settings' }),
 bool('Enable Transcription', 'enable_transcription', true), bool('Enable Image Embeddings', 'enable_image_embedding', true),
];
const promptFields: INodeProperties[] = [
 text('Description', 'description'),
 json('Video-Level Configuration', 'video_level', '{}', { description: 'Video-level instructions, included_segment_fields, and json_schema' }),
 json('Semantic Indexing', 'semantic_indexing', '{}'), json('Execution Defaults', 'execution_config', '{}'),
 json('Selection Filter', 'selection_filter', '{}'),
];
function additional(resource: string, operations: string[], fields: INodeProperties[]): INodeProperties {
 return field('Additional Fields', 'additionalFields', 'collection', {}, { placeholder: 'Add Field', displayOptions: shown(resource, operations), options: fields });
}
const props: INodeProperties[] = [
 options('Resource', 'resource', [['export', 'Export'], ['import', 'Import'], ['index', 'Index'], ['media', 'Media'], ['prompt', 'Prompt'], ['run', 'Run'], ['search', 'Search']], 'media', { noDataExpression: true }),
 ...Object.entries(operationNames).map(([resource, entries]) => options('Operation', 'operation', [], entries[0][0], { noDataExpression: true, displayOptions: { show: { resource: [resource] } }, options: entries.map(([value, name, description]) => ({ name, value, description, action: description })) })),
 text('Name', 'name', { required: true, displayOptions: shown('index', ['create']) }),
 id('indexId', shown('index', ['get', 'delete', 'deletionStatus'])),
 additional('index', ['list'], [bool('Include Defaults', 'include_defaults', true)]),
 text('Input Binary Field', 'binaryProperty', { default: 'data', required: true, displayOptions: shown('media', ['upload']), description: 'Name of the input item binary field containing the file to upload' }),
 json('Files', 'files', '[{"download_url":"https://example.com/media.mp4","file_id":"source-file-1"}]', { required: true, displayOptions: shown('media', ['importUrls']), description: 'Array of download_url and stable file_id objects; file_name and mime_type are optional' }),
 options('Destination', 'destination', [['index', 'Existing Index'], ['newIndex', 'New Index'], ['playground', 'Playground']], 'index', { displayOptions: shown('media', ['upload', 'importUrls']) }),
 options('Destination', 'destination', [['index', 'Index'], ['playground', 'Playground']], 'index', { displayOptions: shown('media', ['list']) }),
 id('indexId', shown('media', ['upload', 'importUrls', 'list'], { destination: ['index'] })),
 text('Index Name', 'indexName', { required: true, displayOptions: shown('media', ['upload', 'importUrls'], { destination: ['newIndex'] }), description: 'Name of the index to create or resolve' }),
 { ...locator('Browse Index', 'browseIndexId', 'listIndexes', shown('media', ['get', 'segments', 'download', 'delete', 'deletionStatus'])), required: false, description: 'Optional index for the media selector. Leave empty to browse playground media, or enter a media ID directly.' },
 id('videoId', shown('media', ['get', 'segments', 'download', 'delete', 'deletionStatus'])),
 additional('media', ['upload', 'importUrls'], [text('Title', 'title')]),
 additional('media', ['segments'], [text('Run ID', 'run_id'), bool('Use Latest Run', 'latest_run')]),
 additional('media', ['download'], [text('Run ID', 'run_id'), text('Segment ID', 'segment_id'), text('File Name', 'fileName')]),
 text('Instruction', 'instruction', { required: true, typeOptions: { rows: 4 }, displayOptions: shown('prompt', ['define']) }),
 additional('prompt', ['define'], [bool('Save Prompt', 'save', true)]),
 text('Name', 'name', { required: true, displayOptions: shown('prompt', ['create']) }),
 text('Prompt Text', 'promptText', { required: true, typeOptions: { rows: 4 }, displayOptions: shown('prompt', ['create']) }),
 json('JSON Schema', 'jsonSchema', '{"type":"object","properties":{"description":{"type":"string"}},"required":["description"]}', { required: true, displayOptions: shown('prompt', ['create']) }),
 additional('prompt', ['create'], promptFields),
 id('promptId', shown('prompt', ['get', 'update', 'delete'])),
 additional('prompt', ['update'], [text('Name', 'name'), text('Prompt Text', 'prompt_text'), json('JSON Schema', 'json_schema', '{}'), ...promptFields, bool('Clear Video-Level Configuration', 'clear_video_level'), bool('Clear Selection Filter', 'clear_selection_filter')]),
 additional('prompt', ['list'], [bool('Active Only', 'active_only', true), bool('Include Defaults', 'include_defaults', true)]),
 options('Prompt Source', 'promptSource', [['saved', 'Saved Prompt'], ['instruction', 'Inline Instruction']], 'saved', { displayOptions: shown('run', ['start']) }),
 id('promptId', shown('run', ['start'], { promptSource: ['saved'] })),
 id('promptId', shown('run', ['estimate'])),
 text('Instruction', 'instruction', { required: true, typeOptions: { rows: 4 }, displayOptions: shown('run', ['start'], { promptSource: ['instruction'] }) }),
 options('Target', 'target', [['index', 'Entire Index'], ['videos', 'Specific Media'], ['playground', 'Entire Playground']], 'index', { displayOptions: shown('run', ['start', 'estimate']) }),
 id('indexId', shown('run', ['start', 'estimate'], { target: ['index'] })),
 json('Media IDs', 'videoIds', '[]', { required: true, displayOptions: shown('run', ['start', 'estimate'], { target: ['videos'] }) }),
 additional('run', ['start', 'estimate'], executionFields),
 id('runId', shown('run', ['get', 'results', 'cancel', 'failures', 'retrySegment', 'retryStatus'])),
 { ...locator('Browse Index', 'browseIndexId', 'listIndexes', shown('run', ['retrySegment', 'retryStatus'])), required: false, description: 'Optional index for the media selector. Leave empty to browse playground media, or enter a media ID directly.' },
 id('videoId', shown('run', ['retrySegment', 'retryStatus'])),
 text('Segment ID', 'segmentId', { required: true, displayOptions: shown('run', ['retrySegment', 'retryStatus']) }),
 text('Retry ID', 'retryId', { required: true, displayOptions: shown('run', ['retryStatus']) }),
 options('List Scope', 'listScope', [['index', 'Index'], ['video', 'Media'], ['all', 'Account']], 'index', { displayOptions: shown('run', ['list']) }),
 id('indexId', shown('run', ['list'], { listScope: ['index'] })),
 { ...locator('Browse Index', 'browseIndexId', 'listIndexes', shown('run', ['list'], { listScope: ['video'] })), required: false, description: 'Optional index for the media selector. Leave empty to browse playground media, or enter a media ID directly.' },
 id('videoId', shown('run', ['list'], { listScope: ['video'] })),
 options('Result Level', 'resultLevel', [['segment', 'Segment'], ['video', 'Video']], 'segment', { displayOptions: shown('run', ['results']) }),
 options('View', 'view', [['unfiltered', 'All Extracted Results'], ['filtered', 'Selected Matches'], ['both', 'Both Streams']], 'unfiltered', { displayOptions: shown('run', ['results']), description: 'Selected matches can be unavailable while selection is pending or absent; the full response preserves this distinction' }),
 additional('run', ['results'], [text('Media ID', 'video_id'), text('Filtered Cursor', 'filtered_cursor'), text('Unfiltered Cursor', 'unfiltered_cursor')]),
 options('Search Scope', 'searchScope', [['index', 'Index'], ['videos', 'Specific Media'], ['runs', 'Specific Runs'], ['playground', 'Playground']], 'index', { displayOptions: shown('search', ['semantic', 'condition']) }),
 id('indexId', shown('search', ['semantic', 'condition'], { searchScope: ['index'] })),
 json('Media IDs', 'videoIds', '[]', { required: true, displayOptions: shown('search', ['semantic', 'condition'], { searchScope: ['videos'] }) }),
 json('Run IDs', 'runIds', '[]', { required: true, displayOptions: shown('search', ['semantic', 'condition'], { searchScope: ['runs'] }) }),
 text('Query', 'query', { required: true, displayOptions: shown('search', ['semantic', 'multimodal', 'sqlExecute', 'agentic']), typeOptions: { rows: 3 } }),
 json('Conditions', 'filters', '[{"field":"description","operator":"contains","value":"person"}]', { required: true, displayOptions: shown('search', ['condition']), description: 'One to four conditions using schema field names and supported operators' }),
 options('Result Level', 'resultLevel', [['segment', 'Segment'], ['video', 'Video']], 'segment', { displayOptions: shown('search', ['semantic', 'condition']) }),
 id('indexId', shown('search', ['image', 'multimodal', 'sqlCatalog', 'sqlGenerate', 'sqlExecute'])),
 text('Input Binary Field', 'binaryProperty', { default: 'data', required: true, displayOptions: shown('search', ['image', 'multimodal']), description: 'Binary field containing the query image' }),
 number('Limit', 'limit', 20, 100, { displayOptions: shown('search', ['image', 'multimodal']) }),
 text('Instruction', 'instruction', { required: true, displayOptions: shown('search', ['sqlGenerate']), typeOptions: { rows: 3 } }),
 additional('search', ['image'], [json('Run IDs', 'run_ids', '[]'), json('Index IDs', 'index_ids', '[]')]),
 additional('search', ['multimodal'], [json('Run IDs', 'run_ids', '[]'), json('Index IDs', 'index_ids', '[]'), json('Search Fields', 'search_fields', '[]'), field('Text Weight', 'text_weight', 'number', 0.5, { typeOptions: { minValue: 0, maxValue: 1 } })]),
 additional('search', ['semantic'], [json('Additional Conditions', 'filters', '[]')]),
 additional('search', ['condition'], [text('Semantic Query', 'query')]),
 additional('search', ['sqlCatalog', 'sqlGenerate', 'sqlExecute'], [json('Run IDs', 'run_ids', '[]'), json('Index IDs', 'index_ids', '[]'), text('Existing Query', 'existing_query'), number('Result Limit', 'result_limit', 100, 2000)]),
 additional('search', ['agentic'], [text('Session ID', 'session_id', { description: 'Reuse a conversation; omit to start a new session' }), text('Session Title', 'title'), json('Index IDs', 'index_ids', '[]'), json('Run IDs', 'prompt_run_ids', '[]')]),
 id('connectorId', shown('import', ['start'])), id('indexId', shown('import', ['start'])),
 additional('import', ['start'], [text('Source Prefix', 'source_prefix'), text('File Pattern', 'file_pattern', { default: '*' }), bool('Recursive', 'recursive', true), options('Import Mode', 'import_mode_override', [['all', 'All Files'], ['new_only', 'New Files Only']], 'new_only')]),
 text('Job ID', 'jobId', { required: true, displayOptions: shown('import', ['get', 'files', 'cancel', 'retry']) }),
 additional('import', ['list'], [text('Status', 'status'), text('Index ID', 'index_id'), bool('Automation Only', 'automation_only')]),
 options('Export Source', 'exportSource', [['run', 'Run'], ['index', 'Index']], 'run', { displayOptions: shown('export', ['create']) }),
 id('runId', shown('export', ['create'], { exportSource: ['run'] })), id('indexId', shown('export', ['create'], { exportSource: ['index'] })),
 additional('export', ['create'], [options('Result Scope', 'result_scope', [['all', 'All Extracted Results'], ['matches', 'Selected Matches']], 'all'), text('Destination Connector ID', 'destination_connector_id'), text('Destination Subpath', 'destination_subpath'), json('Run IDs', 'prompt_run_ids', '[]', { description: 'Only supported for index exports' })]),
 text('Export ID', 'exportId', { required: true, displayOptions: shown('export', ['get', 'download']) }),
 text('Output Binary Field', 'outputBinaryProperty', { default: 'data', required: true, displayOptions: { show: { resource: ['media', 'export'], operation: ['download'] } } }),
];
for (const [resource, operations, max, extra] of [
 ['media', ['list', 'segments'], 100, {}], ['run', ['list'], 100, { listScope: ['index'] }], ['run', ['results'], 50, {}], ['search', ['semantic', 'condition'], 50, {}],
] as Array<[string, string[], number, Show]>) {
 props.push(bool('Return All', 'returnAll', false, { displayOptions: shown(resource, operations, extra), description: 'Whether to fetch all available pages. Search is bounded by the API snapshot result window.' }));
 props.push(number('Limit', 'limit', Math.min(50, max), max, { displayOptions: shown(resource, operations, { ...extra, returnAll: [false] }), description: resource === 'run' && operations[0] === 'results' ? 'Maximum results per selected stream' : 'Maximum number of results to return' }));
 if (!(resource === 'run' && operations[0] === 'results')) props.push(additionalPagination(resource, operations, extra));
}
function additionalPagination(resource: string, operations: string[], extra: Show): INodeProperties {
 return text('Start Cursor', 'cursor', { displayOptions: shown(resource, operations, extra), description: 'Optional opaque cursor from a previous full response. Run results use their per-stream cursors in Additional Fields.' });
}
props.push(number('Limit', 'limit', 50, 200, { displayOptions: shown('run', ['list'], { listScope: ['all', 'video'] }) }));
props.push(number('Limit', 'limit', 50, 200, { displayOptions: shown('import', ['list']) }));
props.push(number('Limit', 'limit', 50, 200, { displayOptions: shown('export', ['list']) }));
props.push(bool('Full Response', 'fullResponse', false, { description: 'Whether to return each complete API response, preserving pagination, readiness, warnings, and selection information. Otherwise list operations return one item per result.', displayOptions: { hide: { operation: ['download', 'upload', 'importUrls', 'create', 'update', 'delete', 'deletionStatus', 'define', 'start', 'estimate', 'get', 'cancel', 'failures', 'retrySegment', 'retryStatus', 'retry', 'agentic', 'sqlGenerate'] } } }));
props.push(text('Idempotency Key', 'idempotencyKey', { description: 'Optional stable business key. Omit to deduplicate native retries automatically. Include a per-item identity when processing multiple input items.', displayOptions: { show: { operation: ['upload', 'importUrls', 'create', 'update', 'delete', 'define', 'start', 'cancel', 'retrySegment', 'retry', 'semantic', 'condition', 'image', 'multimodal', 'sqlGenerate', 'agentic'] } } }));
export const properties = props;
