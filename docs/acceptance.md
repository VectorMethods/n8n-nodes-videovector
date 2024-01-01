# VideoVector n8n acceptance record

Native nodes, credentials, examples, and release controls are implemented. **Correction batch 4 acceptance passed: 63 runtime scenarios, all five workflow imports, package checks, clean installation, and editor checks.** Real deployed API workflows, signed webhooks, credential scopes/revocation, and both MCP examples passed. npm publication and n8n catalog approval remain separate release gates.

No backend runtime code or migrations were changed. Live connector testing required correcting access to one existing connector secret, as recorded below.

## Current corrected artifact

| Component | Version / identity |
| --- | --- |
| Package | `@vectormethods/n8n-nodes-videovector@1.0.0` |
| Correction batch 4 commit | `8fa9ce3a4df0de5b95dbb48ca18ab5d10bab4f75` |
| Tarball | `videovector-1.0.0-642af1dc1503.tgz` |
| SHA-256 | `fd0661288ddafcadcfcd95d0c558842c556fbcd28a51320942e5adb86ed466c7` |
| SHA-1 | `642af1dc150390cd0e748b8c18e805533b5e2120` |
| Package checks | Build, types, official lint, examples, source/distributable scans passed; **132 tests passed** |
| Corrected-artifact runtime acceptance | **Passed: 41 controlled + 22 deployed scenarios; five workflow imports** |
| Official image | `n8nio/n8n:2.42.4` |
| Image digest | `sha256:9c0862a08090c79122069e23131d27529c250b92e90c9d51a6ec406fe1527c4e` |
| Node / artifact packer | `24.21.0` / npm `11.15.0` |
| Editor | `http://localhost:5678`, persistent volume and filesystem binary storage |

The corrected tarball passed a clean installation, distributable scan, and installation into the official n8n instance. The package has no runtime dependencies. The earlier completed controlled-runtime sweep used source `5efd02b0` and tarball `videovector-1.0.0-3bfe6c349d63.tgz`, SHA-256 `174da39dbcc0c580c566c1c8c0d8a8dbb7cf9c958a9f54061df0d626aae0e715`; that evidence remains historical and is distinguished from the final artifact results below.

## Procedure and measured results

Implementation, examples, release wiring, and harnesses preceded verification. Discovery continued through independent failures. Product corrections were batched by shared cause; environment and harness blockers were handled separately. Initial product batches addressed transport, results, item behavior, triggers, and tooling; batch 3 addressed publication-control typing/formatting; batch 4 corrected the two mapping/transport issues found by deployed testing.

- **132 package tests passed** on the correction batch 4 source, covering credentials, all 47 operations, transport, triggers, and fixtures.
- **63 final-artifact runtime scenarios passed:** 41 controlled and 22 deployed. The controlled scenarios comprise core behavior (10), errors (9), retries (4), binary/import behavior (8), HTTP retries (2), trigger lifecycle (7), and the persisted processing chain (1). The deployed scenarios comprise reads (4), trigger lifecycle (8), published-trigger restart (5), corrected SQL catalog/default-session agentic/indexed-media estimate/indexed-media processing (4), and the shipped HTTP workflow (1).
- **All five shipped workflows imported successfully.** The corrected editor showed live index discovery, executed an indexed-media estimate, and previewed a real downloaded export.
- The preceding artifact's 42 controlled scenarios and earlier deployed discovery remain supporting evidence. Controlled tests use the real n8n engine, binary manager, credentials, editor, persisted Waits, Docker restarts, and ngrok, with deliberate fixture responses for API/error cases. All 13 final deployed trigger scenarios used real VideoVector subscriptions and its signed test-delivery endpoint.
- **Nine deployed credential scenarios passed:** native/HTTP validation, permitted reads, write/admin scope rejection, searchable selection, and revocation.
- Live processing, results, media/export downloads, URL and connector imports, semantic/condition/image/multimodal/SQL/agentic search, standalone MCP, and MCP-agent tool use succeeded in the executions below.
- The preceding repository sweep passed **428 focused release/CI/auth/classifier/website tests, with one existing skip**. Batch 3 passed the exact CI mypy/Black/Ruff gates and 339 affected tests, with one existing skip; these counts overlap. Prior PR CI passed all 16 checks at commit `1628e4be`. Main-target [PR 370](https://github.com/VectorMethods/Playground_backend/pull/370) subsequently passed all four checks at `4d48`.
- Runtime dependency audit found zero vulnerabilities. Package-only changes classify as `no_deploy`.

## Acceptance matrix

| Area | Collected evidence | Current result |
| --- | --- | --- |
| Distribution | Official tooling, clean corrected-tarball installation, source/distributable scans | Passed; final artifact installed and exercised in n8n |
| Operation contracts | All 47 mappings, omitted defaults, scopes, error contracts | 132 current package tests passed |
| Stored/inline binary | Controlled byte hashes, filenames/MIME, unsigned media/export downloads; live upload/read/download | Final eight-case binary/import suite and live 192, 209–210 passed |
| Persisted processing | Upload → processing → 65-second Wait → container restart → three result pages → export | Final controlled chain 341 passed with one upload/run/export; live chain 192 also passed |
| Indexed specific media | Selected index scope accompanies specific media IDs in native and HTTP requests | Corrected live estimate 285, native run 286, HTTP workflow 255, and editor selection/execution passed |
| Results and export | Independent stream/cursor contracts; live segments, extraction streams, export binary | Live 211–212 and 219 passed; empty/unavailable/partial edge cases controlled |
| URL import | Real media grant, URL import, processing, extraction, imported-file inspection | Live 222 and 227 passed |
| Connector import | Existing connector, one bounded small object, empty-prefix outcome, disposable-index cleanup | Live 247 and 250–252 passed after one-secret IAM repair |
| Prompt/index lifecycle | Create/read/define/edit/clear/delete, estimation and deletion status | Live 136–140, 177–181, 186, 189–190 and 244–252 passed |
| Search | Semantic, condition, image/multimodal, generated/executed SQL, non-streaming agentic | Live 214–215, 224–226, 228–229 passed |
| SQL catalog | Required empty JSON body retained by the n8n transport | Corrected live execution 253 and regression tests passed |
| Items/errors | Expressions, pairing, separate error output, binary/source diagnostics | Final core/error suites passed; live 403/401 diagnostics passed |
| Retry identity | Later-item failure, native retry, UI retry, fresh runs, loops, image/multimodal | Final retry suites passed; earlier 104–109 and 119–122 retained |
| Trigger lifecycle | Real signed deliveries, bad signature 401, repeated test/production isolation, configuration replacement and cleanup | Final eight live checks and seven controlled checks passed; live executions 310, 316, 321, 324, 335 |
| Published-trigger restart | Persisted registration, same subscription, signed callback after restart and cleanup | Final five live checks passed, executions 348/352; shared Wait 341 verified before interruption |
| Credential lifecycle | Native test, HTTP 204, permitted read, write/admin 403, revocation 401 | Nine live checks passed, executions 240–243 and 248–249 |
| Async/error outcomes | Cancellation, failed/partial imports, retry eligibility, rate limits, deadlines retaining job IDs | Controlled coverage retained; live connector failure and empty outcome observed |
| Editor/selectors | Chrome discovery/icons, credentials, expressions, live selectors, execution and binary preview | Corrected index discovery/estimate passed; real export 219 preview passed; read-only selector passed |
| Examples | All five imported; native media/URL, HTTP, standalone MCP and MCP-agent examples executed live | Passed; corrected HTTP 255 and final HTTP retry suite passed |
| Publication | Company release controls, exact approval/artifact, npm provenance, n8n submission | Pending; no public publication or catalog approval claimed |

## Deployed execution evidence

The corrected artifact passed [SQL catalog 253](http://localhost:5678/workflow/kCjtJPezY9w3LLCM/executions/253), [default-session agentic search 254](http://localhost:5678/workflow/g2oMcxOybcn28Rii/executions/254), [indexed-media estimate 285](http://localhost:5678/workflow/GWfvLtutM77a5MCP/executions/285), and [indexed-media processing 286](http://localhost:5678/workflow/UMJAn4Rz8cMA4xqb/executions/286). The [shipped HTTP workflow 255](http://localhost:5678/workflow/61xsNoQGhPGESBeM/executions/255) completed real processing, persisted waiting, and paginated results. Final deployed index/prompt/import/export reads passed in executions 266–269.

Final deployed trigger executions [348](http://localhost:5678/workflow/GOhZ6qA29WBemhMn/executions/348) and [352](http://localhost:5678/workflow/GOhZ6qA29WBemhMn/executions/352) received signed deliveries before and after the shared restart using the same saved subscription. Immediately before interruption at `2026-10-07T17:44:29.256Z`, the harness captured execution 341 in `waiting` state with `waitTill=17:44:47.332Z`. Native trigger cleanup and preservation of existing subscriptions passed.

[Media execution 192](http://localhost:5678/workflow/puiHw9ihmadI6rvK/executions/192) completed real extraction after persisted 65-second Waits and a container restart. The shared restart began at `2026-10-07T17:16:27.600Z`; the post-restart execution history records Wait resumption at `17:16:40.827Z`, another persisted Wait, and eventual success. The additional Wait evidence is explicitly a post-restart snapshot, not an immediate pre-interruption capture. It used the whole dedicated index to continue discovery after the Specific Media scope issue was identified. [Export execution 219](http://localhost:5678/workflow/XaNxnt5UxriI0Cv1/executions/219) created and downloaded the real export. [URL workflow 222](http://localhost:5678/workflow/UfpHbksapCUM4eQW/executions/222) completed URL import, processing, and extraction.

[Image extraction 221](http://localhost:5678/workflow/ggrf9l4ohvMI1Zxa/executions/221) produced the data used for [image search 224](http://localhost:5678/workflow/ux7tALuwlZPh9frU/executions/224) and [multimodal search 225](http://localhost:5678/workflow/WKLp6VXRvfFjdidv/executions/225). [SQL generation 226](http://localhost:5678/workflow/3XhqaImptznPCwZG/executions/226), [SQL execution 228](http://localhost:5678/workflow/Q62rVjrwq44mz8MT/executions/228), and [agentic search 229](http://localhost:5678/workflow/vEGoKvK2wR4L7sNm/executions/229) succeeded against live data.

[Connector import 247](http://localhost:5678/workflow/jFOYlATU0N5RIEKw/executions/247) imported a verified small object through an existing connector. Earlier execution 231 failed because the deployed runtime identity lacked access to that connector's existing secret. The repair granted Secret Manager accessor on that single secret to the existing runtime service account; the secret payload was not read and no deployment changed. The later bounded empty-prefix import completed normally, and disposable-index deletion/status checks passed.

[Standalone MCP execution 132](http://localhost:5678/workflow/cVek1mJ9s8U8XjQb/executions/132) called the deployed `list_indexes` tool and preserved structured output/item pairing. [MCP-agent execution 223](http://localhost:5678/workflow/zX7GiFvE8HfGe0VS/executions/223) used Google Vertex Chat Model and invoked `VideoVector_MCP_list_indexes` through the shipped agent workflow.

[Trigger execution 203](http://localhost:5678/workflow/tjPUWW3p992IZ9u3/executions/203) received a real signed VideoVector callback after the shared restart, following execution 199 before it. The registration and subscription stayed the same. Native cleanup removed every dedicated test subscription. Existing subscriptions were preserved.

Credential acceptance used a dedicated read-only key with a one-day expiry, created in the signed-in product UI because key management requires JWT authentication. It was transferred directly into n8n's credential store and then revoked through the product UI. Native credential testing and HTTP validation rejected it after revocation; the separate shared live acceptance key was unchanged. No key or JWT was printed or stored in report files. Exact request IDs, credential references, and key lifecycle evidence remain in the local credential report.

## Controlled evidence retained

[Final execution 341](http://localhost:5678/workflow/4xHQAk7HizXlaCwV/executions/341) completed successfully after the shared restart: three result pages, exactly one upload/run/export, and managed `results.json` binary output. The export request sent neither API-key nor Authorization headers to the download URL. This chain exercised the corrected artifact against controlled API responses.

[Execution 110](http://localhost:5678/workflow/xeV7M8aAYOHO18Tr/executions/110) resumed after restart and completed in 65.359 seconds with three result items, one upload/run/export, and managed `results.json`. Its API/export contents were controlled. The Chrome editor showed all three result items and native View/Download controls.

Native retry 104 → 105 preserved earlier accepted work. Fresh/loop executions 106 → 107 received distinct identities. Image/multimodal 108/109 retained their keys. HTTP execution 119 → UI retry 120 retained its original submission key; fresh execution 121 used a new identity. Execution 122 covered Retry On Fail after a lost response. Controlled partial/failed outcomes and rate limits remain deliberate error fixtures, not failures induced in the deployed service.

Local evidence is under ignored `n8n/.reports/`: `correction4-package.json`, `correction4-distribution.json`, `correction4-ui.json`, `correction4/`, `verification.json`, `final-release-ledger.json`, `final-action-{errors,cases,retry-loop}.json`, `final-binary.json`, `final-http-retry.json`, `live-persistence.json`, `final-trigger*.json`, `deployed-trigger*.json`, `deployed-credentials.json`, `deployed-shared-restart-wait-evidence.json`, `live-media.json`, `live-contracts*.json`, `live-mcp.json`, `live-agent.json`, `live-connector-secret-iam-remediation.json`, `ui-discovery.json`, and `issue-ledger.json`. Historical discovery failures remain preserved; an old failed row is not silently overwritten by later successful evidence. Owner/session state stays under ignored `.local/n8n/`; API credentials are stored in n8n.

## Collected findings and batched fixes

| Priority | Shared cause | Correction / verification state |
| --- | --- | --- |
| P1 | Official build selected a TypeScript compatibility alias and missed assets | Node16 resolution, pinned type checker, official asset copying; checks passed |
| P1 | Scanner CLI could exit successfully after analysis failure | Programmatic source/distributable scans fail closed; passed |
| P1 | Image/multimodal requests lacked retry identities | Shared keyed POST transport; native retry verified |
| P1 | Native error output misrouted items or replaced rich JSON | Supported JSON error/message/details envelope; source, binary and pairing verified |
| P1 | Webhook identity depended on unsaved activation state | Canonical deterministic creation identity and owned native cleanup; replay/cleanup verified |
| P1 | Specific Media omitted the selected index scope | Batch 4 adds Media Location/index selector and index_id with video_ids, including the HTTP example; regressions, live 285/286/255 and editor checks passed |
| P2 | n8n dropped required empty JSON bodies | Batch 4 preserves explicit `{}` with JSON content type; regressions and live SQL catalog 253 passed |
| P2 | Native wrappers hid API diagnostics | Preserve code/status/request ID/Retry-After; controlled and live 403/401 checks passed |
| P2 | Null results appeared empty | Explicit unavailable-results error; Full Response preserves readiness |
| P2 | Cleanup prevented clearing prompt descriptions | Preserve explicit empty descriptions; live edit/clear passed |
| P2 | Media selection browsed Playground only | Optional Browse Index and native cursor paging |
| P2 | HTTP execution retry used the new execution ID | Persist original submission identity in Configure; native/UI retries passed |
| P2 | Tooling/metadata and release assertions differed | Official lint, categories, exact pins, updated contracts; passed |
| P2 | Publication metadata typing/formatting failed full CI | Batch 3 typed entrypoints and confined formatter changes; affected checks passed |
| Environment | Legacy webhook URL omitted test callbacks | N8N_WEBHOOK_URL covers both lifecycles; controlled/live isolation passed |
| Environment | Existing connector secret lacked runtime access | Repair one secret's IAM binding; live connector import 247 passed |
| Harness | Crash observation ended before n8n's lease expired | Publication-status polling with 180-second deadline; engine limitation preserved below |
| Harness | Persistence assertion expected two rows from three pages | Inspect all three identities in the same completed execution; no rerun |
| Harness | Saved credential test omitted the redacted form data | Match the editor's test payload; rerun only affected validation; all nine live checks passed |
| Harness | Agent assertion omitted n8n's tool-name prefix | Validate the original execution's actual tool call; no repeated model invocation |

## n8n 2.42.4 publication crash limitation

A crash during initial publication can leave a native webhook route before registration state is saved. After its 120-second lease expires, n8n can report published without invoking registration again. The inspected WorkflowPublicationApplier advances its live version before activation; replay sees an empty diff and treats the existing route as registered.

Automatic recovery failed in workflow `Cc5hOX7ChGh8NxmE`. **Unpublish → wait until unpublishing completes → publish** recovered the deterministic identity, delivered signed execution 84, and left no orphan subscription after cleanup. Evidence remains in `trigger-restart-discovery.json`, `trigger-republish-discovery.json`, and `trigger-runtime-investigation.json`. Normal restarts of already published triggers passed with both controlled and real deployed subscriptions. No extra consumer state was added to simulate engine ownership.

## Acceptance completed; publication gates remain

The corrected tarball above passed the complete acceptance sweep, including indexed Specific Media, SQL catalog, native persisted processing, both trigger lifecycles, and the shipped workflows. Final reports are retained separately under `n8n/.reports/correction4/`; previous discovery and acceptance evidence remains preserved. The documented n8n initial-publication crash behavior and its verified recovery procedure remain applicable.

Public repository/company App setup, source environment variables, npm publisher configuration, protected-main owner approval, exact artifact/provenance verification, and n8n catalog submission follow the [release runbook](../RELEASE.md). Their completion must be confirmed through the existing company controls. This record does not claim npm publication, n8n submission, or catalog approval. Native Cloud installation follows verification approval; built-in examples require no community package installation.
