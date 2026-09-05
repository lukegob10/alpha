# NOR-33: Python verification command evidence

Reference: Alpha 2.1.23, `530d737ec07ba6c4feac0f6745960de224496944`. Investigation and implementation date: 2026-09-05.

The old resolver recognized only `python`/`python3`, accepted pytest's whole-directory form or individual test files,
and reused Plan execution policy as an evidence gate. Directory arguments and versioned launchers therefore produced
no evidence even when the terminal command succeeded.

## Contract

`pythonPytestArguments` identifies simple `pytest`, versioned `python` executables, and `py` with bounded numeric
version/architecture selectors followed by exact `-m pytest`. Original argv remains in the command digest. The helper
does not approve execution; Plan retains its existing unsafe-argument and shell restrictions.

`resolveCommandVerification` retains its optional-scope return contract. Its optional `onRejected` callback explains
unsupported commands/configuration, unavailable scope/content, and uncovered changes. ClineProvider adds missing and
unknown change-set diagnostics. NOR-37 owns collecting these diagnostics in Task and presenting them through the shared
completion decision. Diagnostics remain ephemeral; after reload, durable obligations still identify missing checks.

Pytest directory coverage uses real workspace paths, default test discovery, and a bounded literal configuration subset:
`testpaths` and reporting-only `addopts` in pytest.ini, .pytest.ini, pyproject.toml's ini_options, setup.cfg, and tox.ini.
All configured suite roots must be selected before a directory command can cover source changes. Without testpaths,
the conventional tests directory must contain every discovered default test. Explicit test targets cover only those
tests; provider capture can record that subset without crediting other files in the same change set.

Ambiguous active configurations, unsupported native pytest TOML, unknown options, filtered runs, symlinks, nested
projects, and exceeded discovery/content bounds remain unsupported. Ordinary conftest hooks are fingerprinted and
supported when the host requires runtime collection evidence. Custom collection-producing hooks and outer collection
wrappers are unsupported because they can hide tests before observation; ordinary fixtures and builtin parametrization
remain supported. Runtime INI overrides reuse the static reporting-only allowlist, and effective collection defaults
are checked so inherited `-o python_functions=...` or configuration callbacks cannot hide tests inside a passing file.
A caller using only the static resolver cannot claim
coverage through executable hooks. Source/configuration fingerprints and discovery dependencies are captured before
execution. Observed configuration bytes must match the final snapshot, and pytest scope is resolved again after
completion to detect changed configuration or test topology. The direct `smol-toml@1.3.4` dependency, already present
transitively in the lockfile, parses inert TOML correctly instead of rejecting harmless unrelated metadata.

New evidence carries `runner: "pytest"`. The existing ledger additionally requires `testValidation === true`, computed
from an execution-bound structured collection receipt after the output completion barrier. Every expected test file
must have collected tests and at least one passing test, all collected nodes must have terminal outcomes, and no file
may have failed tests. All-skipped, no-tests, deselected, collection-only, malformed, stale, and missing receipts do not
count. Stdout summaries never grant verification. Actual exit zero, no signal, correct owner/association and current
content remain independently required. Legacy saved receipts retain their prior reader; new fields are optional and
no persisted schema migration is introduced.

## Physical execution and assurance boundary

The receipt manager creates a private temporary directory outside the workspace with a unique plugin name and nonce.
The extension-bundled, bounded Python observer records the original command/execution identity, effective cwd, project
root, configuration, selection options, final collection, and per-file execution outcomes. It detects modified selection,
distributed/repeated sessions, failed setup/teardown, and unsupported bounds. Reports are limited to 256 KiB and 256
files; node accounting is limited to 16,384 items and 1 MiB of IDs. Reading checks directory identity, a regular
non-symlink report, stable file metadata, strict schema, canonical workspace paths, and matching identity. Completion
and disposal are idempotent. Backgrounding keeps the receipt alive; terminal completion or failure releases it.

Execa uses a subprocess environment overlay. The VS Code adapter uses the stable 1.122.1 `TerminalState.shell` value
to choose scoped bash/sh/zsh or PowerShell/Windows PowerShell launch transport. Existing PYTEST_ADDOPTS, PYTEST_PLUGINS,
and PYTHONPATH are preserved; only the unique observer module and directory are appended. PowerShell helpers include
a UTF-8 BOM so Windows PowerShell 5 preserves Unicode paths and arguments. They restore environment presence/values and
preserve the native exit code. Original command text remains in approval, evidence, and process
records. No rerun or repository configuration change is used. Cancellation is latched across asynchronous helper
creation so an aborted command cannot launch afterward. Unidentified/cmd/fish shells or unavailable instrumentation
execute normally and remain unverified with an actionable diagnostic when preparation is unavailable. PowerShell script
execution policy still applies; a policy-blocked helper cannot produce successful evidence.

This is a runtime witness to suite execution, not proof that passing tests exercise each source change. Arbitrary code
inside the pytest process can tamper with its own state; the observer is not adversarial attestation. Competing outermost
hook wrappers and custom runners beyond the supported subset can require explicit unverified handling. The receipt
does not widen tool approval, mode policy, or mutation authority.

Task copies the optional outcome and bounded capture/runtime diagnostics into command evidence. This shared plumbing is
included here and coordinated with NOR-37. Explicit/ordinary completion presentation and bounded repair behavior remain
owned by NOR-37.

## Evidence and validation

The initial regression run reproduced 16 failures and 36 passes. Independent adversarial review added tests for hidden
configuration, precedence, path containment, config changes, virtual environments, and default ignored directories.
The resolver/Plan/provider/ledger batch passes 322 tests. Observer tests execute Python 3.12 with pytest 8.3.4 and cover
normal fixtures, selection, error phases, counts, bounds, and host receipt acceptance. Launcher tests execute PowerShell
7, Windows PowerShell 5, and Git bash/sh; zsh has unit coverage but its executable is unavailable here. Physical Task
tests exercise the scheduler, receipt, provider, and durable completion gate. Final focused results are 35 Task command
outcome tests, 39 receipt-manager tests, 25 actual-Python observer tests, 31 launcher tests, 40 existing command-tool tests,
and 60 adjacent lifecycle/authority/mutation/terminal tests. Adapter regressions include 22 TerminalProcess tests.
Final `src` typecheck, repository lint (12 tasks), `pnpm bundle`, and `pnpm vsix` pass. The contents verifier checks all
1,783 VSIX entries successfully: required files are present and no `.env` files are packaged. No performance improvement
is claimed.

The exact-host command was started and the root bundle passed. It was stopped during its second webview build at the
orchestrator's request, before host launch. VS Code 1.122.1 validation remains required in the sequential combined run;
parallel tasks had exposed a shared runner issue with spaces in the worktree path.

Primary references retrieved 2026-09-05: [pytest configuration](https://docs.pytest.org/en/stable/reference/customize.html),
[pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html),
[pytest invocation](https://docs.pytest.org/en/stable/how-to/usage.html),
[Python Windows launchers](https://docs.python.org/3/using/windows.html), and
[pytest default discovery source](https://raw.githubusercontent.com/pytest-dev/pytest/main/src/_pytest/main.py).
The observer uses the installed pytest 8.3.4 hook contracts; the terminal adapter is checked against
[VS Code 1.122.1 API declarations](https://raw.githubusercontent.com/microsoft/vscode/1.122.1/src/vscode-dts/vscode.d.ts).
The helper encoding follows Microsoft's
[Windows PowerShell 5 character encoding guidance](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/main/reference/5.1/Microsoft.PowerShell.Core/About/about_Character_Encoding.md).
