# n8n Creator Portal submission packet

Prepared for `@vectormethods/n8n-nodes-videovector@1.0.1` on 2026-10-07.
**Prepared, not submitted or approved.** Submit through the company creator
account only after the company release workflow publishes the public npm
package with provenance. Public release setup remains in [RELEASE.md](../RELEASE.md).

## Submission details

| Detail | Value |
| --- | --- |
| Creator Portal | <https://creators.n8n.io/nodes> |
| Package | `@vectormethods/n8n-nodes-videovector` |
| Version | `1.0.1` |
| npm URL | <https://www.npmjs.com/package/@vectormethods/n8n-nodes-videovector/v/1.0.1> |
| Public source | <https://github.com/VectorMethods/n8n-nodes-videovector> |
| Documentation | <https://vectormethods.com/docs/guides#n8n> |
| Package README | <https://github.com/VectorMethods/n8n-nodes-videovector#readme> |
| Authentication guide | <https://vectormethods.com/docs/api#auth-and-api-keys> |
| Account / API-key setup | <https://app.vectormethods.com> |
| Maintainer | VectorMethods — `support@vectormethods.com` |
| Issue tracker | <https://github.com/VectorMethods/n8n-nodes-videovector/issues> |
| License | MIT |
| Nodes | VideoVector; VideoVector Trigger |

The npm and public-source links above identify the intended release. Confirm
they resolve to the company-published version before entering this packet in
the portal; this document does not attest that publication has occurred.

## Description

VideoVector brings media ingestion, extraction, search, and exports into n8n.
The VideoVector action node offers 47 operations for indexes, media, prompts,
runs, semantic/condition/image/multimodal/SQL/agentic search, connector imports,
and exports. It uses the public REST API with native n8n credentials, binary
handling, item linking, pagination, and retry scheduling. VideoVector Trigger
manages signed webhook subscriptions with separate test and production
lifecycles. Account administration and connector setup remain in VideoVector.
Maintained by VectorMethods, with usage documentation, workflow examples, and
support through the linked issue tracker or support email.

## Authentication and reviewer setup

Create a VideoVector account and API key, then add a **VideoVector API**
credential in n8n. Authentication uses `X-API-Key`; the default base URL is
`https://api.vectormethods.com/api/v2`. The credential test calls
`GET /auth/validate`. Use write scope for ingestion and processing, read scope
for resource inspection, and admin scope for deletion and the Trigger's
automatic subscription cleanup. The Trigger needs a public HTTPS webhook URL.
Keep reviewer credentials in n8n's credential store; never include secrets in
this packet, workflow JSON, screenshots, or public issues.

## Importable workflows

- [Native binary upload → process → results](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/examples/native-upload-process-results.json)
- [Native URL import → process → results](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/examples/native-url-import-process-results.json)
- [Built-in HTTP → process → results](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/examples/http-process-results.json)
- [Built-in MCP Client → list indexes](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/examples/mcp-list-indexes.json)
- [AI agent with hosted MCP tools](https://github.com/VectorMethods/n8n-nodes-videovector/blob/main/examples/mcp-agent.json)

Processing templates use persisted 65-second Waits and a configurable 24-hour
deadline. HTTP/MCP examples use built-in nodes and are usable without native
catalog installation. The agent example additionally needs a supported model
provider credential. Native Cloud installation follows catalog approval.

## Review evidence and submission prerequisites

The [acceptance record](acceptance.md) records 132 package tests, 63 final
runtime scenarios, all five imports, clean tarball installation, editor checks,
real deployed API workflows and signed webhook deliveries, plus credential
scope/revocation checks. The accepted package uses TypeScript and official
`@n8n/node-cli` tooling, is MIT licensed, and has no runtime dependencies.
Source and distributable scans passed. The record also documents the verified
recovery procedure for n8n 2.42.4's interrupted initial-publication behavior.

n8n currently requires GitHub Actions publication with npm provenance for
verification, a public matching repository and maintainer, technical/UX
compliance, and public documentation with authentication and examples. These
requirements were checked against n8n's [submission instructions](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md)
and [verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines.md).
After the approved release, confirm the registry version, provenance, source,
maintainer, and links, submit this package through the Creator Portal, then
record its submission identifier and review status in the release record.
