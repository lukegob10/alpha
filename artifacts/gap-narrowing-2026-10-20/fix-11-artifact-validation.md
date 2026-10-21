# Fix 11: managed proposal artifact validation

Mode: **correctness cleanup**, scoped to the persisted proposal reader and its artifact file operations. Reviewed and
implemented on 2026-10-20 against Alpha HEAD `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`, preserving other agents' and the
user's existing changes. This closes the demonstrated escaped proposal-file-reference boundary; it does not establish
that arbitrary local metadata edits or concurrent filesystem replacement are authenticated.

## Before and root cause

[Review 08](../directory-review-2026-10-20/clean-08-managed-packages.md) and its
[generated-proposal diagnostic](../directory-review-2026-10-20/clean-08-repro.mjs) correctly identified a data-integrity
failure. `load()` cast arbitrary JSON to `ManagedWorkerArtifact`; ordinary Git artifacts bypassed private-repository
ownership checks. `discard()` joined the saved `patchFile` to the proposal directory and removed the resulting path.

Before editing production code, the new regression initialized a real Git repository, created a managed worktree,
changed a scoped file, captured a legitimate proposal, and changed only its saved `patchFile`. Running the focused test
failed with `ENOENT` while reading `outside-proposal-canary.txt`: discard had deleted that owned-temporary-directory
canary outside proposal storage. This establishes **local metadata tampering**, with no demonstrated remote/provider
entry point.

## Changes

- Validate both ordinary and private JSON before using it. Validate required fields, statuses, paths, timestamps,
  collection members, change entries, and optional private-owner fields; require the saved ID to match the requested ID.
- Admit only the generated proposal filenames: `changes.patch`, numeric `*-before` / `*-after` snapshot names, and the
  fixed metadata filename. Traversal, either separator style, absolute references, alternate data streams, and
  cross-role metadata references fail validation.
- Resolve artifact directories against the physical configured storage root, reject artifact and bucket aliases that
  escape that layout, and reject linked or non-regular metadata/proposal files. A configured storage-root alias remains
  supported, including existing Windows short-path storage tests.
- Reuse the checks for load, diff paths, capture output, patch apply/discard, metadata persistence, bulk metadata scans,
  and final artifact removal. Recovery uses the validated reader and leaves unknown or invalid records untouched.
- Preserve an existing directory whose metadata is absent, instead of deleting its data as a repair. Deleting an already
  absent artifact remains idempotent.

## Old and new readers

No persisted format version or public TypeScript interface changed. Current and historical generated filename formats
remain readable. Missing `fileWriteScope` and `gitRelativeFileScope` arrays deliberately default to `[]`, preserving the
prior directory-authority fallback rather than guessing a narrower scope from current disk state. Ordinary legacy
records can omit the optional private-Git fields. Additive artifact/change metadata is preserved on successful writes;
unknown private-owner receipt fields and unsupported statuses are rejected.

A discard committed before patch removal, or interrupted after patch removal but before its final metadata write,
remains resumable: a missing referenced patch is allowed by load/discard. Applying a proposal requires an existing owned
regular patch file. Loading does not rewrite metadata or normalize unsafe references into a different target.

## Files

- [Runtime](../../packages/core/src/worktree/managed-subagent-worktree.ts): schema, identity/physical-path checks, and file
  sinks only; native Git execution, worker cancellation, and provider code were not changed.
- [Regressions](../../packages/core/src/worktree/__tests__/managed-subagent-worktree.artifact-validation.spec.ts): generated
  ordinary/private proposals, external canaries, malformed data, identity mismatch, both separators, directory/file
  links, missing metadata, legacy defaults, and capture-output replacement.
- This record.

## Validation

Windows; Node `24.21.0`; pnpm `11.24.0`; every Vitest invocation used `--maxWorkers=1`.

- Before production edits:
  `pnpm --filter @alpha-code/core test --maxWorkers=1 src/worktree/__tests__/managed-subagent-worktree.artifact-validation.spec.ts`
  — **1 test failed for the intended reason**, external canary deleted.
- Intermediate focused security/persistence run: **17 passed, 1 skipped**. The initial Windows exclusion for regular-file
  symlinks was subsequently replaced with an explicit permission-based skip; this host supports those symlinks.
- The first five-file run completed with **58 passed / 10 failed**, 68 tests, 844.11 seconds. Main worktree,
  capture-recovery, and persistence specs passed. Nine non-Git tests reached their unchanged 30-second limits:
  empty-folder startup, concurrent proposals, partial reload, substituted private directory, configured storage alias,
  both ASCII/UTF-8 nested administration cases, and both nested private-retention cases. The remaining failure was the
  new security file's repeated setup hook. Errors were deadline failures and, during teardown, `EBUSY`; there was no
  assertion mismatch in that run. These failures are retained as unsuccessful validation, not classified as preexisting.
- A focused legacy rerun confirmed a 30-second repeated real-Git `beforeEach` timeout followed by `EBUSY`. The fixture
  now generates/captures one ordinary proposal in `beforeAll`, then copies its persisted files into fresh per-case
  storage; actual private/capture cases still generate their own worktrees. The legacy two-repository case has a
  60-second real-Git budget, with its assertions unchanged. The next focused run recorded **19 passed / 1 failed**:
  three serial create/capture lifecycles in one capture-output case exceeded 30 seconds. Those three outputs are now
  separate cases retaining that 30-second limit. Existing suites' deadlines were not changed.
- Final security/persistence command:
  `pnpm --filter @alpha-code/core test --maxWorkers=1 src/worktree/__tests__/managed-subagent-worktree.artifact-validation.spec.ts src/worktree/__tests__/managed-subagent-worktree.persistence.spec.ts`
  — **22 passed, 2 files, no skips**, 40.48 seconds. Regular Windows file symlinks and all three capture-output cases ran.
- Controlled non-Git rerun after competing broad validation stopped:
  `pnpm --filter @alpha-code/core test --maxWorkers=1 src/worktree/__tests__/managed-subagent-worktree.non-git.spec.ts`
  — **15 passed, no skips**, 52.96 seconds, with existing 30-second limits. Every affected spec has passing coverage
  across separate runs; the initial combined run remains recorded as failed.
- Focused ESLint for the runtime and new regression file: **passed**, `--max-warnings=0`.
- Touched-file Prettier and `git diff --check`: **passed**.

No repository-wide typecheck, build, managed-agent certification, or exact VS Code host gate was run by this
implementation agent; the coordinating agent owns those checks.

## Source comparison

Inspected the current official Codex CLI snapshot at commit
[`c7234c1174b27d9c55199fba0d546dc27d1b0415`](https://github.com/openai/codex/tree/c7234c1174b27d9c55199fba0d546dc27d1b0415)
from the local `ac-c7234c1` checkout before implementation:

- [`worktree/src/metadata.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/worktree/src/metadata.rs)
  parses a typed owner record, checks its version and owner, and avoids replacing another owner during binding.
- [`worktree/src/lib.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/worktree/src/lib.rs)
  checks physical managed layout, non-linked checkout/bucket metadata, and registration backlinks before admitting
  managed worktrees.
- [`worktree/tests/worktree.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/worktree/tests/worktree.rs)
  covers the exact Desktop owner schema and rejects checkout/bucket aliases while allowing a configured root alias.

Alpha retains its native TypeScript proposal and private-repository formats and its existing security policy. The
intentional difference is backward-compatible defaults and preservation of additive fields in Alpha's unversioned
artifact format. No Rust implementation or sandbox architecture was ported. Historical Alpha commit `32c9ad37e` was
also inspected to confirm the existing artifact contract and generated snapshot naming.

## Residual risk and scope

- These checks reduce persisted-data trust and revalidate paths at the relevant sinks; they do not hold directory/file
  handles across the entire operation. A hostile same-user process changing filesystem entries between validation and
  use remains outside the established proof and requires a separate race-hardening design.
- Host-generated `gitRoot` / `worktreePath` fields are shape-validated here; comprehensive worktree-registration
  authentication and native process cancellation are separate contracts. Existing private Git ownership/receipt checks
  remain in force.
- The initial directory review's other custom-tool and worker-cancellation findings are outside this patch.
- No remote exploitability or general performance improvement is claimed.
- Unsuccessful deadline runs also reported `EBUSY` fixture teardown. No broad temporary-directory or private-bucket
  cleanup was attempted; retained test-owned records are not treated as permission to remove unknown storage.
