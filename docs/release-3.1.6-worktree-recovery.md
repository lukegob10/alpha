# Alpha 3.1.6 release recovery

The first release attempt on `ea6b1d6bf7934215485979b884172bfc9b77a19d` did not publish a VSIX.
[Release workflow 37254403898](https://github.com/lukegob10/alpha/actions/runs/37254403898) failed both Windows
long-storage worktree cases. The corresponding Code QA certification failed the same two cases in its worker-worktree
track; the other deterministic tracks passed. Linux units, offline evaluators, and exact-host smoke/scripted outcomes
passed independently. The failed receipts remain in GitHub's retained workflow artifacts.

## Cause and owning boundary

The runner used Git for Windows `2.55.0.windows.5`; the previous local testing used `2.43.0.windows.1`.
Both failures reproduce with the official, temporary MinGit 2.55.0.5 executable. The 202-character storage case
captures an unexpected deletion of untouched `keep.txt`; the 218-character case fails checkout with
`this operation must be run in a work tree`.

Git 2.55's [Windows realpath implementation](https://github.com/git-for-windows/git/blob/v2.55.0.windows.5/compat/mingw.c)
resolves junctions using `GetFinalPathNameByHandleW`. Its
[repository setup](https://github.com/git-for-windows/git/blob/v2.55.0.windows.5/setup.c) then uses that physical
worktree path. These primary sources were retrieved on 2026-10-04. Native setup traces confirm that the physical
overlong checkout replaces Alpha's short invocation alias. The previous junction adaptation alone is insufficient
for this Git version. No upstream Git behavior change is assumed from memory.

## Correction and compatibility

`ManagedSubagentWorktreeService.create` retains metadata, snapshots, and patches in the configured extension storage.
On Windows, when the conventional checkout path reaches the existing 220-character Git setup bound, it exclusively
allocates the physical checkout with `fs.mkdtemp` in the native temporary directory. Its resolved physical path must
also remain below that bound. The existing artifact `worktreePath` records the actual location before registration.

This extends the existing worktree service and persistence contract. Older saved paths remain readable; no migration
or additional registry is needed. Existing capture, apply, cancellation, orphan recovery, and Git removal own the
short checkout. Failed cleanup retains its addressable artifact; successful cleanup removes the checkout. The
temporary checkout remains a recovery dependency until changes are captured durably, as with conventional checkouts.

The long-storage regressions still use 202- and 218-character storage paths, preserve the original index, HEAD and Git
configuration, exercise nested Workers, and apply only the authorized file. Their former assertion requiring an
overlong physical checkout is deliberately replaced with checks for a short physical checkout, persisted location,
physical removal, and absent native Git registration. Proposal storage remains overlong. Alias-unlink fault coverage
now exercises a long snapshot worktree through the existing Git effect boundary. Startup/delete failure tests also
cover long storage and fresh-service recovery of the short checkout.

The extension and UX remain version 3.1.6 because the failed attempt published neither a tag nor an asset. GitHub's
unchanged release workflow must verify the final merged source and package before creating the release.

Local validation: both long-storage cases fail before correction and pass afterward with Git 2.55.0; the same cases
also pass with Git 2.43.0. The complete core package run passes all other cases, exposing only fixture expectations
that require adaptation to the new checkout location. After that adaptation, all 12 capture/recovery cases pass with
Git 2.55.0, including the two additional long-storage failure/recovery cases. Core type checking passes. Final full
package, extension-consumer, certification, exact-host, and VSIX verification belong to the fresh GitHub release run.
