# CLI Run Reports Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Archive each configured TypeScript CLI ticket execution automatically as an inspectable JSON file, including success, provider failure and graceful cancellation.

**Architecture:** A dedicated `src/run-reports/` module reserves one exclusive JSON file before API calls and updates it atomically at completion. CLI uses `SupportAssistant.process()` and its existing output capture hook. Reports are separate from content-free telemetry and preserve input, final response, sanitized errors, trace, intermediate outputs and configuration snapshots.

**Tech Stack:** TypeScript, Node.js filesystem APIs, existing SDK metadata resolver and node:test. No new dependencies or live API calls for verification.

**Spec:** User selected automatic CLI saving and one JSON per execution after the first two manually archived runs.

## Constraints

- Default directory: `typescript-basic/reports/manual-tests/`, independent of terminal cwd; `--reports-dir` overrides it.
- Group by SHA-256 of normalized ticket text; a fresh report UUID prevents overwriting repeated tests.
- Report format version 2 distinguishes automatic reports from the imported format version 1 files.
- Initial state `running`; final state `finished`, with trace requestId recorded separately from reportId.
- Snapshot provider/model, runtime settings, prompts/hashes, JSON schemas, exact price YAML/hash, application/Node/selected SDK versions, UTC timestamps and original/normalized ticket text.
- Never serialize API keys, environment objects, SDK clients, raw SDK errors or authorization headers.
- Preserve stdout response format and stderr metadata-only telemetry. No API calls from tests.
- Reserve file before API work; report write errors become sanitized `report_error`. Preserve the primary operational error if final archival also fails.
- Existing pasted reports remain untouched. Help and invalid arguments do not generate reports; startup configuration errors before report initialization do not generate reports.
- Work in the active checkout: the TypeScript project and earlier user changes are untracked and belong to the current working state.

## Tasks

- [x] Add failing CLI tests for independent records, snapshots, errors and secret exclusion; cover default/overridden directories, raw outputs, response compatibility and provider errors. Add filesystem coverage for reservation and concurrent writers.
- [x] Add `run-reports/types.ts` and `run-reports/writer.ts`: `RunReportWriter.create(options)` reserves a report; `finish({response, trace, error, rawOutputs})` atomically finalizes it. Expose original price source through `PriceCatalog.source` rather than rereading a mutable file.
- [x] Integrate recorder with CLI, `process()` capture and graceful cleanup; update help, safe error code and capture comment.
- [x] Document saved contents and usage in the existing TypeScript README. Test writers on temporary directories, without filling the user's testing archive.
- [x] Run focused tests, TypeScript checks, full suite and formatting; request a read-only review focused on lifecycle, file integrity and credential exclusion.

## Review Focus

- Concurrent executions of the same ticket must not overwrite one another.
- Report destination failures must occur before API calls where possible and never expose raw filesystem errors.
- Partial execution, cancellation and telemetry failures must preserve captured outputs and trace where available.
- Reports must contain only explicitly selected configuration fields, never secret-bearing objects.
- Archive writes must not alter the public JSON response or content-free stderr contract.

## Verification and Rulings

- All 107 tests passed; both TypeScript project checks and formatting passed.
- The reviewer found early SIGINT listener removal during final archive writing. A regression test reproduced exit 130; retaining the listener and recording late cancellation passed the test. Follow-up read-only review found no remaining actionable findings.
- `smoke:package` reached offline installation but failed with npm `ENOTCACHED` for `@types/node@26.6.5`; no registry access was attempted. A temporary project copy using installed dependencies independently verified default report location with a different cwd. Installed-package smoke remains unverified until npm cache contains the required dependency.
- Existing imported reports were not modified, and temporary tests left no synthetic files in the user's manual-test archive.
