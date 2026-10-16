# Subagent launches in plain folders

## Failure and owning boundary

A Code-mode `spawn_agent` call with no `agent_type` resolves to an editing Worker. Worker preparation previously
required `git rev-parse --show-toplevel` before creating the child. Consequently, even two prompt-only test agents
failed when the parent worked in an ordinary folder. Explore and Review agents did not take that branch.

The owning boundary is `ManagedSubagentWorktreeService`: it validates worker paths and owns isolated checkouts,
change capture, conflict detection, Apply/Discard, and recovery. Changing the requested role or falling back to
unrestricted shared-workspace writes would change authority or bypass those established protections.

## Codex reference and intentional difference

The current reference is [openai/codex commit 0e67502123b4c6952b9fa5d672d2907fe4059f56](https://github.com/openai/codex/commit/0e67502123b4c6952b9fa5d672d2907fe4059f56),
retrieved on 2026-10-16. Its native
[spawn path](https://github.com/openai/codex/blob/0e67502123b4c6952b9fa5d672d2907fe4059f56/codex-rs/core/src/thread_spawn.rs)
passes the invoking step's environment into the child. The
[child configuration](https://github.com/openai/codex/blob/0e67502123b4c6952b9fa5d672d2907fe4059f56/codex-rs/core/src/agent/child_config.rs)
inherits the working directory and runtime approval/permission snapshot, including after role overrides.
Neither introduces a Git repository admission requirement. The nearest
[multi-agent configuration tests](https://github.com/openai/codex/blob/0e67502123b4c6952b9fa5d672d2907fe4059f56/codex-rs/core/src/tools/handlers/multi_agents_tests.rs)
use a fresh temporary working directory and assert the resulting child configuration.

Alpha aligns launch availability while deliberately retaining its existing Worker isolation and reviewed change sets.
It reuses its TypeScript worker service and native Git operations; it does not introduce another agent runtime or
change execution, approval, protected-path, or mutation-gate policy.

## Plain-folder behavior

- Scope validation retains physical-path, exact-file, traversal, `.git`, and symlink checks. Only genuinely absent
  repository metadata selects the plain-folder path. Broken metadata and failed Git operations remain errors.
- Each Worker gets an artifact-owned private Git database outside the user's workspace. Source files are captured
  through explicit Git directory and working-tree arguments, then the existing isolated checkout is created.
  The user's folder receives no Git metadata; the index and snapshot commits belong to the private database.
- Private database configuration preserves plain-folder file bytes independently of a user's global automatic
  line-ending conversion. Existing repository-backed Workers retain their repository's checkout policy.
- On Windows, long extension-storage paths use an owned short database under the existing personal Alpha data
  directory, `~/.alpha/worker-git`. Persisted artifact ownership records keep that database available for reload and
  pending change review; loading and cleanup validate the recorded owner before accessing it.
- Capture, scope-violation quarantine, conflict checks, Apply/Discard, cancellation, and orphan recovery continue
  through the same service. Private database ownership is checked before loading persisted artifacts. Existing
  artifacts without the optional private metadata field remain readable.
- Nested workers retain the common Git database until their live checkout and captured proposals are released.
  Chat deletion finds all owned worker artifacts, including agents that produced no changes, and removes dependent
  artifacts before their private database. Unknown records and failed ownership checks preserve the stored data.
- Retained default Workers revalidate the same workspace-root `.` scope accepted at initial preparation. Parent
  policy and write-scope ceilings continue to apply during continuation.

Git must still be installed because Alpha's existing worker isolation uses native Git. A Git repository in the
user's folder is no longer required. This change does not initialize Git or change Git configuration in that folder.

## Regression coverage and release gates

Focused core tests exercise real plain-folder snapshots, concurrent isolated Workers, empty workspaces, byte
preservation, scope checks, conflict handling, nested artifact retention, cleanup, and recovery. Provider tests cover
two default Code preparations, rebuilding a retained Worker after its prepared runtime is unloaded, and deleting
a no-op worker's private artifact with its parent chat.

A separate exact-host acceptance test starts two native default Workers in a fresh non-Git workspace, holds both
initial requests until both agents are live, collects their distinct results through `wait_agent`, and checks stable
parent identity, isolated working directories, paired persisted tool transactions, and the absence of source Git
metadata throughout. It is included in the existing managed-agent certification command.

Release validation uses the focused tests, type/style checks, `pnpm certify:managed-agents:automated`, the exact
VS Code 1.125.0 smoke gate, and the normal bundle/VSIX content checks. Run receipts and upstream source references
are retained outside the source tree under `alpha-chat-validation/non-git-subagent-3.2.1/` for this release.
