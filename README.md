# VideoVector for n8n

Native VideoVector actions and event triggers for media ingestion, extraction,
search, and exports. The nodes consume the public VideoVector API; your n8n
workflow owns orchestration and VideoVector owns processing, billing, and jobs.

## Install and connect

Package: `@vectormethods/n8n-nodes-videovector`.

On self-hosted n8n, install the package from **Settings → Community nodes**.
On n8n Cloud, install it from the node panel when the verified community
package is available. The [HTTP workflow](examples/http-process-results.json)
uses built-in nodes and works on Cloud without installing a community package.

Create a **VideoVector API** credential with an API key from your
[VideoVector account](https://app.vectormethods.com). The default API URL is
`https://api.vectormethods.com/api/v2`. Connection testing uses the read-only
`GET /auth/validate` endpoint. Keys stay in n8n credentials; never paste them
into expressions, workflow JSON, or URLs.

- **Write** scope supports ingestion, prompt creation, processing, search, and exports.
- **Read** scope supports resource retrieval and search; **search** supports search only.
- **Admin** scope is required for deletion and for the Trigger's automatic webhook cleanup.

## Actions

| Resource | Operations |
| --- | --- |
| Index | Create, get, list, delete, deletion status |
| Media | Upload binary, import URLs, get, list, segments, download, delete, deletion status |
| Prompt | Define from instructions, create, get, list, update, delete |
| Run | Start, estimate, get, list, results, cancel, failures, retry segment, retry status |
| Search | Semantic, condition, image, multimodal, SQL catalog/generate/execute, agentic |
| Import | Start from connector, get, list, files, cancel, retry |
| Export | Create from run/index, get, list, download |

Resource selectors support browsing and expression-driven IDs. Each input item
is processed independently and keeps n8n item linking. List and result actions
emit one item per record. **Return All** follows supported cursors within the
server's result snapshot. It does not expand a search beyond the server's
result window or turn a limited list endpoint into an exhaustive listing.
**Full Response** preserves each response page, pagination, coverage, and
warnings so workflows can inspect truncation and selection readiness.
Run results support segment/video level and filtered/unfiltered/both views.
Partial completion and failure details remain visible in status responses.
For **Run → Start** or **Estimate** with **Specific Media**, select its
**Media Location**: Playground, or Index with the containing index ID.

Use n8n's **Retry On Fail** to schedule transient retries. **Continue (using
error output)** sends failed items to the error branch with their original
input, binary files, and item links. The `details` field retains the API error
code, HTTP status, request ID, and Retry-After value when the API supplies them.
Successful items stay on the regular output.

For uploads, pass an n8n binary property (default `data`) from Google Drive,
S3, HTTP Request, or another source node. No local filesystem path is needed.
For public or signed URLs, use Import URLs with a JSON array:

```json
[{"download_url":"https://example.com/video.mp4","file_id":"source-object-id","file_name":"video.mp4"}]
```

The server fetches the URLs. Private sources should supply a signed download
URL with enough lifetime for import, or download to n8n binary and use Upload.
Choose an index, a new named index, or Playground as the destination.

A run can use a saved prompt or plain-language instructions. Saved execution
settings are inherited unless you explicitly add overrides. A submitted run
returns promptly with its ID; processing continues on VideoVector.

## Reliable asynchronous workflows

Import a template from [examples](examples). Select credentials, replace the
configuration values, and activate only after a manual run:

- [Upload binary → process → results](examples/native-upload-process-results.json)
- [Import URL → wait for import → process → results](examples/native-url-import-process-results.json)
- [Built-in HTTP Request → process → results](examples/http-process-results.json)
- [Built-in MCP Client → list indexes, without a model](examples/mcp-list-indexes.json)
- [AI agent with the hosted MCP tools](examples/mcp-agent.json)

Templates use the native **Wait** node for 65 seconds between status requests.
n8n persists long waits so workers are released. A 24-hour deadline bounds the
workflow. Timeout errors include the accepted job/run ID so you can resume
with Get Status instead of creating another job. `failed` and `cancelled`
stop with explicit errors; `completed_with_failures` takes the partial-result
branch and still retrieves results. Import failures include failed-file data.

Native submissions keep the same per-item idempotency key during **Retry On
Fail** and the editor's **Retry Execution**. A fresh workflow execution or a
new loop iteration receives a new key. The HTTP template saves its submission
key in Configure before making the request, so Retry Execution reuses that
saved key even though n8n gives the retry a new execution ID.

Use the Idempotency Key option with your source's stable event/object ID when
you intentionally want deduplication across different workflow executions.
Reusing a key with changed parameters is an API conflict. An explicit new
business operation needs a new key. Poll the accepted run ID to follow its
progress.

## Events

Use **VideoVector Trigger** to start workflows on media, run, import, and export
events. Choose event types and optional indexes. n8n registers and removes its
subscription through the existing webhook API and checks incoming signatures.
Your n8n instance needs a publicly reachable HTTPS webhook URL. Test and
production URLs have separate subscriptions. On n8n 2.42.4, set
`N8N_WEBHOOK_URL` to that HTTPS base URL so both test and production callbacks
use the public address.

Delivery is at least once. Downstream systems should use
`$json._delivery.delivery_id` or the source resource ID for their own
deduplication when performing external writes.
A trigger event indicates a state change; fetch the run/import/export when you
need its complete current state or results. Never use progress events as proof
that work completed.

If n8n 2.42.4 stops during the initial publication and the trigger does not
receive events after restarting, let publication settle, unpublish the workflow,
wait for unpublishing to finish, then publish it again. Interrupted publication
can take about two minutes to settle because n8n retains its publication lease.
Unpublishing cleans up the subscription even when initial registration state was
not saved. Successfully published triggers retain their registration on restart.

## Built-in HTTP and MCP

For HTTP Request, create a **Header Auth** credential with header name
`X-API-Key`; assign it to each VideoVector HTTP node. Send JSON to the same
public API and an `Idempotency-Key` on submissions. Use native Wait/If nodes as
shown by the HTTP template. Follow each filtered/unfiltered result cursor
independently when retrieving both views.
In the HTTP template's **Configure** node, leave `indexId` empty for Playground
media or set the existing media's index ID. The template retains `videoId` so
processing stays limited to that selected media.

The hosted MCP endpoint is `https://api.vectormethods.com/mcp`. To call a tool
directly, use the built-in **MCP Client** with streamable HTTP and the same
`X-API-Key` Header Auth credential. The [standalone MCP template](examples/mcp-list-indexes.json)
calls the read-only `list_indexes` tool with `include_defaults: true`; it needs
only your VideoVector credential. Its output keeps the MCP `structuredContent`
object, including `user_indexes` and `default_indexes`.

For conversational tool selection, use **MCP Client Tool** connected to an AI
Agent. The [agent template](examples/mcp-agent.json) also requires a credential
for its OpenAI Chat Model; you can replace that model node with another supported
chat model. Native action nodes provide explicit operations for scheduled
business workflows, while an agent chooses tools from conversation.

## Development and publication

Use Node.js 24.21.0 and npm 11.15.0. From this package directory, build and
install the exact npm tarball into the included n8n 2.42.4 Docker environment:

```bash
npm ci --ignore-scripts
npm run verify
npm run pack:release
mkdir -p ../.local/n8n/packages ../.local/n8n/fixtures
cp vectormethods-n8n-nodes-videovector-1.0.0.tgz ../.local/n8n/packages/
docker compose up -d
docker compose exec --user node n8n sh -lc 'mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install --omit=dev --ignore-scripts --legacy-peer-deps /packages/vectormethods-n8n-nodes-videovector-1.0.0.tgz'
docker compose restart n8n
```

Open `http://localhost:5678`, create the local owner account, and add a
VideoVector API credential. The persistent Docker volume keeps workflows and
credentials across restarts. Rebuild, copy, install, and restart after changing
the package; this tests the same packed files that consumers install.

For trigger testing, supply the public HTTPS ingress address through the
Compose input variable:

```bash
N8N_TEST_WEBHOOK_URL=https://your-public-host/ docker compose up -d
```

Compose maps this to n8n's `N8N_WEBHOOK_URL` and explicitly enables unverified
community packages for installing the local build before catalog verification.

Source and releases are published through the company's **Public Repo Bot**,
never a personal GitHub account. The public repository is
`VectorMethods/n8n-nodes-videovector`; package tags are `videovector-n8n-v<version>`.
Publication controls verify the immutable npm artifact, source/tag identity,
provenance attestation, and registry bytes before finalizing a release.
n8n Cloud discoverability additionally requires the n8n community verification
submission; an npm release alone does not grant verification.
See [release prerequisites](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/RELEASE.md) for the company repository, npm trusted
publisher, and catalog setup required for the first public release.
