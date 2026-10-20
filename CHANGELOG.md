# Changelog

## 2.0.0 — Standalone imported parts and grounded extraction

This is a breaking contract release paired with the corresponding VideoVector API deployment.

- All ordinary uploads return an asynchronous ImportJob. Wait for import completion before processing.
- Long videos become independently uploaded parts of at most 40 minutes. Each part has its own video ID and local timestamps.
- Enumerate every ordered outputs page, or process with `import_job_id` to select the complete manifest. `video_ids` contains only its current page.
- Import progress distinguishes source files from generated parts and reports ingestion phase and downstream execution readiness.
- `video_level` now contains only `instructions_text` and `json_schema` and requires content-aware segmentation. It is grounded in the same media call as segment fields. Selected-segment input and synthesis-only result fields are removed.

Update existing upload workflows before upgrading: retain `job_id`, wait for completion, and use the complete import selector or all output pages. The shipped examples follow this lifecycle.
