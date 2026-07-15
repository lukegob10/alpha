# M4 implementation plan — reconstructable, integrity-checked runs

## Contract and schema changes

- Add versioned task-definition and variant identities without replacing the legacy `runs` and `tasks` projection.
- Add durable `eval_events` and `artifacts` records keyed to attempts. Events carry a monotonic sequence, timestamp, type, normalized payload, payload digest, redaction version, and optional late-event disposition.
- Store artifact bytes behind a content-addressed `ArtifactStore`; relational rows retain digest, size, media type, logical kind, retention/access policy, upload state, and provenance.
- Link grader evidence to artifact identities while preserving the M3 JSON evidence projection during rollout.
- Generate a forward-only migration and retain compatibility for every existing schema snapshot.

## Runtime and evidence collection

- Introduce an `evidence` module containing stable version-1 contracts, canonical encoding/digests, recursive secret redaction, an event journal, content-addressed filesystem storage, integrity validation, and reconstruction/export.
- Normalize lifecycle/agent observations through a registry-backed event envelope rather than persisting UI-formatted logs.
- Collect required evidence before cleanup: final diff, Git status/tree digest, transcript, final response, test output, extension log, environment manifest, usage, and stop reason.
- Represent large output with a bounded redacted event preview and a protected full artifact.
- Make upload retries idempotent and content addressed so interruption cannot create conflicting evidence.

## Tests and fixtures

- Unit-test canonical digests, event gaps/duplicates/late events, payload corruption, artifact corruption, nested/raw/base64/URL-encoded canaries, large-output truncation, and required-artifact completeness.
- Contract-test resumable filesystem uploads, workspace deletion after collection, deterministic reconstruction, and migration coverage.
- Extend hostile-runtime scenarios so missing/corrupt evidence invalidates a trial and never yields a valid pass.
- Verify secrets are absent from event payloads, artifact metadata, logs, and structured process specifications.

## Rollout and compatibility

- Dual-write new evidence records while continuing legacy task/run fields and M3 grader evidence JSON.
- Make integrity validation mandatory before a passing attempt is finalized; non-passing legacy reads remain available while old rows are explicitly marked as lacking an M4 evidence bundle.
- Add an export CLI that reconstructs an attempt into a deterministic manifest plus verified artifact files without requiring the original runner workspace.

## Validation

1. `pnpm --filter @alpha-code/evals test:unit`
2. `pnpm --filter @alpha-code/evals test:contract`
3. `pnpm --filter @alpha-code/evals test:migrations`
4. `pnpm --filter @alpha-code/evals test:integration`
5. `pnpm --filter @alpha-code/evals test:coverage`
6. `pnpm --filter @alpha-code/evals check-types`
7. `pnpm --filter @alpha-code/evals lint`

## Decisions and non-goals

- Initial artifact storage is repository-local filesystem storage behind a portable interface; remote object storage is not required for M4.
- Cryptographic identity uses SHA-256 over canonical bytes; database row IDs are not evidence identities.
- Subjective graders, distributed runner certification, task-bank expansion, and statistical promotion remain M5–M7 work.
