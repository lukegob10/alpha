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
- Prune checkpoint-excluded directories from the nested-repository scan when creating a new shadow repository. Keep
  the full scan for existing repositories, whose indexes may already track excluded content. Validate staged gitlinks
  and fall back to a full scan if staging fails, because workspace `.gitignore` rules take precedence over the shadow
  repository's `$GIT_DIR/info/exclude` file ([Git ignore documentation](https://git-scm.com/docs/gitignore)). Keep
  following workspace directory links so nested repositories remain detectable.
- Pass deterministic commit settings as command-scoped Git configuration instead of launching separate `git config`
  processes. Start the initialization timer before the nested-repository scan and log scan, Git version, and initial
  snapshot durations separately.

The five-second warning can still occur when a consumer genuinely waits for a slow initial baseline. This change
reduces avoidable scanning and Git process startup; Git still has to stage and hash the included workspace content.

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
that the index is untouched. Those initialization and scan samples predate the follow-up investigation below.
These local samples are not a general throughput guarantee or a CI timing threshold.

### Initialization follow-up, 2026-09-22

Windows, Node 24.14.1, pnpm 11.24.0, Git 2.43.0.windows.1. Three samples per version using the same synthetic
fixture above: 100 source files, 10,000 files in `node_modules`, and 16 MiB of unignored text. Initialization
measurements wrap the full `initShadowGit()` call. The first run is the pre-follow-up implementation; the second
includes directory pruning, command-scoped Git configuration, and the added nested-repository safety checks.

| Metric (ms)            | Before samples            | Follow-up samples      | Before median | Follow-up median |
| ---------------------- | ------------------------- | ---------------------- | ------------- | ---------------- |
| Initialization         | 1316.56, 1255.94, 1340.33 | 875.32, 875.78, 957.83 | 1316.56       | 875.78           |
| Nested repository scan | 149.72, 128.84, 129.52    | 37.59, 29.89, 29.54    | 129.52        | 29.89            |

The first follow-up run showed median initialization falling by about 33% and nested scan time by about 77%. The
recursive `ripgrep` scan had been walking the 10,000-file dependency tree even though a new checkpoint would exclude
it. Three serial Git configuration subprocesses also added startup overhead. Two more three-sample runs on the same
host produced these medians:

| Metric (ms)            | Repeat 1 samples          | Repeat 1 median | Repeat 2 samples       | Repeat 2 median |
| ---------------------- | ------------------------- | --------------- | ---------------------- | --------------- |
| Initialization         | 1388.51, 1152.49, 1518.57 | 1388.51         | 909.71, 997.61, 936.05 | 936.05          |
| Nested repository scan | 44.92, 35.55, 92.93       | 44.92           | 39.41, 27.49, 30.46    | 30.46           |

The nested scan remained 65–77% faster than the pre-follow-up median across these runs. Total initialization was
variable: one rerun was slower than the original median, while the other was about 29% faster. The phase log shows
the initial snapshot (staging, index validation, and commit) taking 584–894 ms in the two reruns and remaining the
largest phase. The fixture supports that the scan avoids walking excluded dependency files; it does not establish a
reliable total startup improvement across workspaces. A large included workspace can still spend substantial time
staging and hashing files.

### Real task trace, 2026-09-22

The latest Alpha output log contained two checkpoint initializations from the same workspace. `initShadowGit()` took
39,447 ms and 19,726 ms. Nested repository scans took 72 ms and 48 ms. The initial snapshot took 34,250 ms and
16,985 ms. In the 19,726 ms run the Git version subprocess added another 2,495 ms; this was redundant because the task
initialization already checks that Git is installed before creating the service.

The workspace's tracked `.alpha/code-index` cache contained 3,687 files totaling 481,150,555 bytes, primarily
LanceDB `.lance` segments. The cache is generated from workspace files and can be rebuilt. Checkpoint excludes did not
cover it, so every new per-task shadow repository read and hashed almost half a gigabyte before the task could save
its first checkpoint. This was the dominant delay behind the 15-second timeout, while nested-repository detection
accounted for less than 0.1 seconds.

The fix excludes only `.alpha/code-index/`; `.alpha/documents/` remains checkpointed. Existing task repositories
migrate previously tracked code-index files out of the private index in a new commit, preserving prior checkpoint
history and leaving cache files in the workspace untouched. The service no longer runs a second Git version
subprocess, and initialization logs now split initial snapshot time into `git add`, staged-index validation, and
commit phases. The core logs the remaining Git-availability preflight separately.

An opt-in live-workspace benchmark uses a temporary shadow directory and reads the supplied workspace without saving
or restoring files. It can be run with:

```powershell
$env:ALPHA_CHECKPOINT_PERF = "1"
$env:ALPHA_CHECKPOINT_PERF_WORKSPACE = (Resolve-Path "<workspace path>").Path
pnpm --dir src test services/checkpoints/__tests__/checkpoint-performance.spec.ts --testNamePattern="live workspace" --silent=false
Remove-Item Env:ALPHA_CHECKPOINT_PERF
Remove-Item Env:ALPHA_CHECKPOINT_PERF_WORKSPACE
```

Three post-fix samples against that workspace initialized in 1,398 ms, 1,642 ms, and 1,981 ms (median 1,642 ms).
Their `git add` phases took 668–829 ms; initial snapshots took 1,098–1,459 ms. Compared with the two task traces,
observed initialization fell by about 90–96%. This is a same-host live-workspace comparison, not a general guarantee;
the original task runs and benchmark samples do not have controlled disk-cache state.

Validation for this fix: 25 core checkpoint tests, 59 checkpoint service/exclusion tests, the three-sample live
workspace benchmark, extension typechecking, ESLint, Prettier, and the exact-host smoke gate on VS Code 1.122.1 all
passed.
