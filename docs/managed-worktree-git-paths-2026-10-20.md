# Windows linked-worktree Git startup paths

The full confidence gate exposed a production failure while capturing a nested editing worker from a plain folder.
The nested worker's checkout remained reachable after its parent checkout was captured and removed, but Git rejected
`read-tree` with `fatal: '$GIT_DIR' too big`. This prevented the child proposal from reaching review.

## Reproduction and owning invariant

With a 57-character owned temporary directory, the original fixture produced these physical path lengths:

| Path                           | Length |
| ------------------------------ | -----: |
| Extension storage              |    101 |
| Private Git database           |    174 |
| Worker checkout                |    157 |
| Linked worktree administration |    221 |

`ManagedSubagentWorktreeService.prepareGitPaths` previously decided whether to adapt Windows paths using only the
caller's `cwd`, explicit `GIT_DIR`, `GIT_WORK_TREE`, and new checkout path. Each was below its conservative 220 threshold.
The `.git` pointer nevertheless resolved to the longer administration directory inside
`repository.git/worktrees/<worker-id>`.

The installed host uses Git **2.43.0.windows.1**. Its
[discovered-directory setup](https://github.com/git-for-windows/git/blob/v2.43.0.windows.1/setup.c#L949-L958) forwards the
discovered directory to explicit-directory setup when `GIT_WORK_TREE` is set. Capture supplies that environment variable.
[Explicit-directory setup](https://github.com/git-for-windows/git/blob/v2.43.0.windows.1/setup.c#L849-L860) rejects a Git
directory whose `strlen` exceeds `PATH_MAX - 40`, before loading repository configuration. `core.longpaths=true` does not
bypass that guard. The Windows environment conversion uses
[UTF-8](https://github.com/git-for-windows/git/blob/v2.43.0.windows.1/compat/mingw.c#L2230-L2265), so JavaScript string
length also missed paths containing multibyte characters. These primary sources were retrieved on **2026-10-20**.

## Change

The existing Git invocation adapter now resolves physical Git administration before deciding whether a Windows
invocation needs its existing temporary junctions. All existing startup-path thresholds use UTF-8 byte length, retaining
the conservative 220-byte cutoff. Non-Windows invocations retain their early return.

The fix serves ordinary Git, buffered Git, private repositories, nested worktrees, capture, reload, and cleanup through
the same adapter. Physical worktree registration, invocation ownership checks, bounded metadata files, proposal retention,
and persisted artifact formats remain under their existing owners. Temporary aliases remain invocation resources and are
removed after the Git effect and registration checks finish.

Windows invocations now perform one physical metadata resolution before accepting the short-path case. The resolution
uses asynchronous filesystem operations; it does not start another Git process or cache metadata across invocations.
This is a correctness tradeoff, with no claim of a general performance improvement.

## Codex comparison

The comparison used current Codex CLI commit **`18795fc12571a3530d3e4ac18366e41cd2f57448`**, retrieved **2026-10-20**.
Its [linked-worktree trust implementation](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/git-utils/src/trust.rs#L139)
resolves physical administration and common-directory identity, validates worktree backlinks, and treats bounded regular
metadata files as a trust boundary. Its
[worktree trust tests](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/worktree_trust_tests.rs)
cover moved checkouts, aliases, substituted metadata, and main-checkout ownership.

The resulting Alpha contract follows that physical-identity requirement. Alpha's existing proposal quarantine for
editing workers, including work in plain folders, remains an intentional extension capability. This change adapts Git
startup at Alpha's native TypeScript boundary and does not change delegation authority, introduce a runtime, or port
Codex's sandbox.

## Validation

The unchanged existing nested-retention test reproduced the failure with exactly one selected case and the original
temporary-path length. Two added deterministic Windows cases failed for the same `read-tree` error before the production
fix and passed afterward:

- An ASCII linked administration path is 221 characters and bytes despite a 157-character checkout.
- A UTF-8 linked administration path is only 219 UTF-16 code units while exceeding 220 UTF-8 bytes.

Both cases remove the parent checkout, instantiate a fresh service, capture the nested proposal, verify that the shared
private database remains retained by the proposal, then delete both task artifacts and verify that the original plain
folder and its contents remain intact. Reproduction receipts verify source hashes and ownership before removing each
fresh test root. Raw reports and Git setup traces are retained under
`artifacts/testing-2026-10-20/worktree-path-repro/`.

These exact boundary fixtures require an ASCII physical TEMP parent no longer than 60 characters; they validate that
headroom before constructing the 99/101-character storage paths. A short alias for a longer physical parent is
insufficient. The UTF-8 case introduces exactly two multibyte characters, independently of padding length. Full Windows
reruns use a fresh, marked native C-user TEMP directory with a short physical basename and its verified native 8.3 alias.

An adjacent owned-storage-junction characterization also exercises create, reload, capture, apply, and deletion through a
short storage spelling that resolves to a long physical directory. Those operations succeed on the installed Git; the
existing checkout allocation policy is unchanged. A preliminary assertion that demanded a short physical checkout was
removed because it imposed a stronger contract without an observed lifecycle failure. The final test verifies the
observable lifecycle and preservation of the caller's junction.

The native C TEMP rerun exposed a separate fixture capability: creating a child directory through a C-volume junction
failed in this environment before any Git invocation. Direct physical-directory creation succeeded, and the junction's
`stat`, `realpath`, and directory listing matched its target. Native `CreateDirectoryW` also failed with Windows error
183 through a junction with canonical target and link paths shorter than 100 characters. Canonicalizing the target,
removing 8.3 spelling, and using a namespaced path did not change that result. These observations do not establish a
Windows-wide, Node-wide, Git, or long-path defect.

That characterization now creates its storage junction in a fresh, marked root on the workspace filesystem under the
already ignored `artifacts/testing-worktree-git-alias/` namespace. Its source plain folder remains in genuine native
C-user TEMP accessed through the verified 8.3 alias. The fixture verifies the canonical target, target/alias device and
inode identity, every original lifecycle assertion, preservation of the caller's junction, and root ownership before
cleanup. It does not skip or fall back after a capability failure, and it does not introduce a production filesystem
workaround. The failing C-volume receipts and native API comparisons remain retained with the original failure.

All four affected managed-worktree suites passed **55/55 cases**, with no skips, using two workers and the same
57-character temporary-path condition before the fixture relocation. Core typecheck, core lint, touched-file formatting,
and `git diff --check` also passed for that source. The test receipt confirms unchanged source hashes and complete cleanup
of its owned temporary root.

After fixture relocation, the complete owning spec passed **15/15 cases** under native C TEMP, followed by all four
affected suites passing **55/55 cases**, with no skips. The final run used a 50-character physical native C TEMP root and
its verified 44-character 8.3 alias; production and spec hashes remained unchanged during the run. The native temporary
root and every owned workspace fixture were removed. Core typecheck, core lint, touched-file formatting, and whitespace
checks passed for the final fixture. Matching evidence is retained as
`c-owning-after-fixture-*` and `c-affected-final-*` in the worktree investigation directory.

Broader confidence, exact-host, and packaging gates must use the new source freeze; earlier successful runs do not certify
this change.
