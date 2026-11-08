# VideoVector n8n 3.0.0 acceptance record

The extraction contract requires segment and whole-media schemas on every prompt, including image processing. Each source commits both result scopes and all internal analysis windows together. Different media items can complete independently; media assets and image indexing may become ready afterward.

Processing no longer applies prompt filters, exposes fixed segmentation, or returns separate selected and unselected streams. Run results use one `data` page and `pagination.next_cursor`, with `result_level` selecting the projection. Conditional search remains available for downstream filtering.

Validation completed for this release:

- 94 focused action and fixture tests cover required whole-media prompt configuration, execution overrides, single-cursor results, empty pages, and API request/response contracts.
- Type checking, lint, build, and all five importable workflow examples pass.
- [Public package CI](https://github.com/VectorMethods/n8n-nodes-videovector/actions/runs/42520873177) passed on the implementation revision.

The existing release workflow verifies the exact package artifact and registry delivery. Version 3.0.0 is paired with the unified extraction API deployment.
