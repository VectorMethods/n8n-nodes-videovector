# VideoVector n8n acceptance record

The integration is implemented and passes contract and controlled-runtime acceptance. **Deployed VideoVector acceptance and public publication remain pending.** No backend runtime code or migrations were changed.

## Tested artifact

| Component | Version / identity |
| --- | --- |
| Package | `@vectormethods/n8n-nodes-videovector@1.0.0` |
| Implementation commit | `e26172a7af5e738697a6ef580950d38b969c9be6` |
| Runtime artifact source | `5efd02b0` (adds documented restart recovery) |
| Tarball | `videovector-1.0.0-3bfe6c349d63.tgz` |
| SHA-256 | `174da39dbcc0c580c566c1c8c0d8a8dbb7cf9c958a9f54061df0d626aae0e715` |
| SHA-1 | `3bfe6c349d63a752c01139b3233e7efe74f1676a` |
| Official image | `n8nio/n8n:2.42.4` |
| Image digest | `sha256:9c0862a08090c79122069e23131d27529c250b92e90c9d51a6ec406fe1527c4e` |
| Node / artifact packer | `24.21.0` / npm `11.15.0` |
| Editor | `http://localhost:5678`, persistent volume and filesystem binary storage |

Later report, harness, and publication-control-only changes do not alter the installed package contents. The tarball contains no runtime dependencies and installed into both an empty npm project and the official n8n instance.

## Procedure and totals

The complete implementation, examples, release wiring, and harness preceded verification. The discovery sweep continued through independent failures. Two product correction batches addressed shared causes; harness/environment blockers were handled separately. A third batch addresses publication-control typing/formatting discovered by full PR CI. No native package code changed during final runtime acceptance.

- Build, types, strict official n8n lint, source/distributable scans, and committed package secret scan passed.
- **125 package tests passed**, covering credentials, all 47 operations, transport, triggers, and fixtures.
- **428 focused release/CI/auth/classifier/website tests passed; one existing test skipped.** Syntax, Ruff, actionlint, and shellcheck passed.
- **42 final scenarios passed in the real n8n runtime against controlled HTTP responses.** The editor, engine, credentials, binary manager, Wait persistence, Docker restarts, ngrok ingress, and signatures were real. VideoVector API responses and webhook sending were controlled fixtures.
- Runtime dependency audit found zero vulnerabilities. Package-only changes classify as `no_deploy`.
- Full PR CI runs the other maintained product surfaces. Its initial sweep found publication-verifier typing and formatting issues. Batch 3 passed exact CI mypy/Black/Ruff gates and 339 affected invariant/release/classifier tests (one existing skip); these overlap the focused counts above. The PR records final CI status.

## Acceptance matrix

| Area | Evidence | Result |
| --- | --- | --- |
| Distribution | Official tooling, clean install, installed tarball | Passed |
| All operations/scopes | 47 mappings, defaults, credential and scope contracts | Passed against contracts/controlled API |
| Binary | Stored/inline MP4 byte hashes, filenames/MIME, media/export download without API credentials | Passed, executions 111–114 |
| Persisted chain | Upload → run → 65-second Wait → restart → three result pages → export | Passed, execution 110 |
| Imports | URL/connector mappings, partial/failed file outcomes, native URL workflow branches | Passed against controlled API, executions 115–118 |
| Results/search | Independent cursors, unavailable/empty selection, snapshot limits, search mappings | Passed against contracts/controlled API |
| Items/errors | Expressions, paired items, separate error branch, source/binary/diagnostic retention | Passed, executions 85–93 |
| Retry identity | Later-item failure, native and UI retry, fresh runs, loops, image/multimodal | Passed, executions 104–109 and 119–122 |
| Trigger | Signed delivery, identifiers, rejection, test/production isolation, changed configuration, cleanup | Passed, executions 123–127 |
| Published-trigger restart | Same subscription/key, signed delivery, zero leftovers | Passed, executions 128–129 |
| Async errors | Cancellation, partial completion, rate limits, deadlines retaining job IDs | Passed against contracts/controlled API |
| Editor | Discovery/icons, credential test, selectors/manual IDs, expressions, MP4 preview, export inspection | Passed in Chrome |
| Examples | Native upload, native URL import, HTTP, standalone MCP, MCP agent | All five imported |
| Example execution | Both native workflows and HTTP workflow | Passed against controlled API |
| Hosted MCP / AI agent | Live API credential; agent also needs a model credential | Pending |
| Deployed API | Real processing, URL/connector jobs, search, exports, webhook sender, credential revocation | Pending authorized live key |
| Publication | Company setup, exact owner approval, provenance, n8n catalog submission | Pending |

## Runtime evidence

[Execution 110](http://localhost:5678/workflow/xeV7M8aAYOHO18Tr/executions/110) resumed after restart and completed in 65.359 seconds: three result items, exactly one upload/run/export, and managed `results.json` (`application/json`, 33 bytes). Export contents were controlled. The editor showed all three result items and native View/Download controls.

[Trigger execution 129](http://localhost:5678/workflow/PE9PC1X39A1McMjH/executions/129) followed a container restart after execution 128. The subscription and creation key remained unchanged; native deactivation removed it.

Native retry 104 → 105 preserved accepted earlier-item work. Fresh/loop executions 106 → 107 received distinct identities. Image/multimodal executions 108/109 retained their keys. HTTP 119 → UI retry 120 retained `n8n:119:start-run`; fresh execution 121 used a new identity. Execution 122 covered Retry On Fail after a lost response.

Full local evidence is under ignored `n8n/.reports/`: `final-package.json`, `verification.json`, `final-release-ledger.json`, `final-action-{errors,cases,retry-loop}.json`, `final-binary.json`, `final-http-retry.json`, `live-persistence.json`, `final-trigger.json`, `final-trigger-persistence.json`, `ui-discovery.json`, and consolidated `issue-ledger.json`. Earlier results remain under `discovery/` and `correction1/`. Credentials and owner state stay under ignored `.local/n8n/` with restricted permissions.

## Collected findings and batched fixes

| Priority | Shared cause | Correction |
| --- | --- | --- |
| P1 | Official build selected a TypeScript compatibility alias and missed assets | Node16 resolution, explicit pinned type checker, official icon copying |
| P1 | Scanner CLI invocation could exit successfully after failing analysis | Official programmatic source and packed-artifact scan that fails closed |
| P1 | Image/multimodal submissions lacked retry identities | Shared keyed POST transport; native retry verified |
| P1 | Native error output either misrouted items or replaced rich JSON | Supported JSON error/message/details envelope; binary and paired source retained |
| P1 | Webhook creation identity depended on unsaved activation state | Derive identity from canonical registration; replay creation and native cleanup |
| P2 | Native wrappers hid API diagnostics | Retain code/status/request ID/Retry-After without credential-bearing request config |
| P2 | Null results appeared empty | Explicit unavailable-results error; Full Response retains readiness |
| P2 | Shared cleanup prevented clearing prompt descriptions | Preserve explicitly empty description |
| P2 | Media selection only browsed Playground | Optional Browse Index selector and native cursor paging |
| P2 | HTTP retry used the new execution ID | Store the original submission identity in Configure |
| P2 | Strict tooling, metadata, and release expectations differed | Official lint config, supported categories, exact Node pin, updated contract assertions |
| P2 | Publication metadata typing and formatting failed full CI | Typed entrypoint lists and formatter changes confined to publication controls |
| Environment | Legacy webhook URL setting omitted test callbacks | Use N8N_WEBHOOK_URL for test and production |
| Harness | Crash observation ended before n8n's lease expired | Observe publication status with a 180-second recovery deadline |
| Harness | Persistence assertion expected two rows from a three-page fixture | Assert all three identities against the same completed execution |

Batch 1 fixed shared transport, mapping, results, binary, trigger identity, and tooling. Its verification exposed n8n's replacement of JSON when top-level item.error exists. Batch 2 adopted the native JSON envelope, fixed the exact toolchain pin/test lint, and added the direct MCP template. All final native scenarios passed on the resulting artifact.

## n8n 2.42.4 publication crash limitation

A crash during initial publication can leave a native webhook route before registration state is saved. After its 120-second lease expires, n8n can report published without invoking registration again. The inspected WorkflowPublicationApplier advances its live version before activation; replay sees an empty diff and treats the existing route as registered.

Automatic recovery failed in workflow `Cc5hOX7ChGh8NxmE`. **Unpublish → wait until unpublishing completes → publish** recovered the deterministic identity, delivered signed execution 84, and left no orphan subscription after cleanup. Evidence is retained in `trigger-restart-discovery.json`, `trigger-republish-discovery.json`, and `trigger-runtime-investigation.json`. Normal restarts of already published triggers passed on the final artifact. No extra consumer state was added to simulate engine ownership.

## Remaining acceptance and release gates

The prepared key `n8n integration acceptance — 2026-10-07` has Admin scope for webhook cleanup and a seven-day expiry. Its creation awaits the browser tool's required action-time approval; the form has not been submitted. Once authorized, `live-test.mjs bootstrap`, `live-media.mjs prepare/finish`, and `live-mcp.mjs` are ready for deployed testing with credentials stored in n8n.

The public repository and npm package did not exist during assessment. Company App installation, source environment variables, npm publisher setup, protected-main owner approval, and n8n submission remain required under the [release runbook](../RELEASE.md). Nothing has been publicly published and no catalog approval is claimed. Native Cloud installation follows verification; built-in examples require no community package installation.
