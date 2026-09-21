# Checkpoint performance

Alpha retains its per-task shadow Git repository and persistent index. Existing checkpoint hashes, diff modes,
and workspace restore behavior remain compatible. A new task still needs an initial baseline; preserving an index
helps subsequent snapshots but does not eliminate that initial cost.

## Investigation

The Cline comparison was prompted by its September 2026 release notes about replacing a throwaway snapshot index
with a persistent per-session index. Reviewed on 2026-09-20: Cline commit
[`5a3b870d8573a2a6f41695a638c0fdf92e879112`](https://github.com/cline/cline/commit/5a3b870d8573a2a6f41695a638c0fdf92e879112),
specifically `sdk/packages/core/src/hooks/checkpoint-hooks.ts`. This is Cline's SDK checkpoint implementation;
the earlier comparison should not be read as proof that its VS Code extension had the same throwaway-index path.
Alpha already uses a persistent index under the task's checkpoint repository.
That optimization cannot be described as a missing feature in Alpha or as a reason to migrate its storage format.

The existing Alpha task loop also already starts checkpoint initialization in the background. Consumers previously
polled every 250 ms while waiting for initialization, and a failed initializer could leave concurrent consumers
waiting until their individual timeouts. Historical diffs also staged the live workspace even when comparing two
saved commits, doing unnecessary filesystem work and changing the private index.

## Changes

- Coalesce initialization consumers around one per-task promise instead of polling. Only publish a ready service;
  settle consumers promptly when initialization fails, and prevent late completion from publishing after timeout.
- Read historical diffs directly from the saved commits. Stage the current workspace only for comparisons against
  the current workspace, where staging is still needed to include new files.
- Apply Cline's `core.ignorestat=false` and `core.splitIndex=false` safeguards to checkpoint Git commands, preventing
  inherited Git settings from suppressing detection of later edits or introducing shared index files.
- Preserve the nested-repository scan and current exclusion rules. Pruning dependency directories solely by name
  would need additional correctness work: user ignore-file overrides and legacy tracked content affect what Git
  actually includes.

The five-second warning can still occur when a consumer genuinely waits for a slow initial baseline. This change
does not claim to eliminate cold workspace scanning or hashing, and does not turn checkpoints off.

## Validation

Focused tests cover concurrent initialization, initialization failure and timeout, historical diff contents and
index preservation, and existing snapshot/restore behavior. An opt-in real Git benchmark lives at
`src/services/checkpoints/__tests__/checkpoint-performance.spec.ts`.

Validated locally with 25 core checkpoint tests and 53 real-Git service/exclusion tests, extension typechecking,
ESLint for the changed TypeScript files, and the VS Code 1.122.1 smoke gate. The extension bundle also succeeds.

Run it from PowerShell:

```powershell
$env:ALPHA_CHECKPOINT_PERF = "1"
pnpm --dir src test services/checkpoints/__tests__/checkpoint-performance.spec.ts --silent=false
Remove-Item Env:ALPHA_CHECKPOINT_PERF
```

The benchmark uses only a temporary synthetic workspace and does not stage the developer's repository.
Compare the same fixture and sample count on the same machine. Fresh shadow repositories measure cold repository
initialization; filesystem caches are not flushed, so this is not a cold-disk benchmark.

### Local measurements, 2026-09-20

Windows 11 (10.0.26200), Node 24.14.1, pnpm 11.24.0, Git 2.43.0.windows.1. Three samples per version,
100 source files, 10,000 nested dependency files, and 16 MiB of unignored text. Each sample creates a new shadow
repository. The historical comparison contains one changed source file; the 16 MiB of data changes only afterward,
so it must not be scanned/staged to display that historical comparison. No model or provider is involved.

| Metric (ms)            | Before samples            | After samples             | Before median | After median |
| ---------------------- | ------------------------- | ------------------------- | ------------- | ------------ |
| Initialization         | 2980.30, 4713.74, 3157.72 | 2172.18, 2703.56, 1809.31 | 3157.72       | 2172.18      |
| Nested repository scan | 211.36, 208.65, 193.60    | 200.56, 196.41, 182.17    | 208.65        | 196.41       |
| Historical diff        | 1186.57, 1183.93, 1779.60 | 665.76, 519.77, 976.58    | 1186.57       | 665.76       |

Historical diff median decreased by approximately 44% on this fixture. The correctness test separately verifies
that the index is untouched. Initialization and scan timings are reported for context; those paths were not
algorithmically optimized, and their timing differences should be treated as host/cache variation rather than
evidence of a startup speedup. These local samples are not a general throughput guarantee or a CI timing threshold.
