# VS Code 1.138.0 baseline migration

Started 2026-10-19. The reference host moves from exact VS Code 1.125.0 to exact **1.138.0**. The initial migration also
raised the installation minimum to `^1.138.0`; the 2026-10-20 compatibility correction below restores `^1.125.0` for
Alpha 3.2.6. This does not change the Node 24.21.0, pnpm 11.24.0, or TypeScript 5.8.3 development baseline.

## Minimum-host compatibility correction (2026-10-20)

The user requested continued installation on VS Code 1.125. The 3.2.5 installer rejection was caused by the extension's
`engines.vscode` range, rather than an established dependency on newer stable APIs. Microsoft's
[extension manifest contract](https://code.visualstudio.com/api/references/extension-manifest), retrieved 2026-10-20,
defines this field as the compatible VS Code version range. Alpha 3.2.6 restores `^1.125.0`; exact 1.138.0 remains the
reference host and primary release gate.

The installed `@types/vscode@1.125.0` and `@types/vscode@1.138.0` stable declarations were compared again on
2026-10-20: their differences are documentation comments only. The extension compiles against 1.125.0 types, while
the E2E runner retains 1.138.0 types. This split also satisfies the pinned `@vscode/vsce@3.3.2` packaging rule in
`out/validation.js` (`validateVSCodeTypesCompatibility`), which rejects API types with a higher minor version than the
extension's declared minimum. No production API check or packaging validation is bypassed.

Minimum-host compatibility runs use exact 1.125.0 separately from the existing 1.138.0 suites. In particular, the LM
fixture characterizes each host's actual late-cancellation behavior, while Alpha-owned cancellation must return
promptly on both hosts. Historical 1.138.0 receipts remain reference-host evidence and cannot prove 1.125.0 support.
Run the minimum-host gate with:

```sh
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

It covers activation and contributions, executable modes, offline storage recovery, and the eight deterministic LM
contracts. QA and release workflows run its `:run` variant immediately after the primary 1.138.0 gate, reusing the
fresh extension/webview build. A minimum-host result cannot satisfy reference-host receipt validation. The live
Copilot sidecar remains restricted to 1.138.0; minimum-host testing uses the deterministic provider fixture.

The subsequent sections retain the original migration's measurements and host identity.

## Sources and host identity

Primary references retrieved 2026-10-19:

- [Microsoft's 1.138 release notes](https://code.visualstudio.com/updates/v1_138).
- [The exact 1.138.0 stable Windows archive](https://update.code.visualstudio.com/1.138.0/win32-x64-archive/stable).
- [The 1.138.0 stable API](https://github.com/microsoft/vscode/blob/1.138.0/src/vscode-dts/vscode.d.ts),
  checked through the installed `@types/vscode@1.138.0` package.

The downloaded Windows x64 host identifies as version `1.138.0`, commit
`7debcd0e2acdea1c52de81bf9ee1620444407dda`. It lives in the ignored
`apps/vscode-e2e/.vscode-test/vscode-win32-x64-archive-1.138.0/` cache. The existing 1.125.0 download and profiles are
retained. The regular user installation is not replaced.

## Contract changes

The runner defaults, campaign host selection, fixture manifest, versioned package scripts, CI/release commands,
portable reproducer, evaluator entry point, and harness evidence validators now select 1.138.0. Versioned commands
use `:1380` in place of `:1250`, including:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:extended:1380
pnpm --filter @alpha-code/vscode-e2e test:vscode-lm:1380:run
```

Historical evidence retains its recorded host identity. A 1.125.0 receipt cannot satisfy the new host gate.
Explicit runner version options remain available for investigations, but reference-host suites and campaigns require
1.138.0. Persistent profiles remain isolated by exact version; do not copy authentication or reset historical profiles.
Live Copilot testing needs a separately initialized, signed-in Alpha-owned 1.138.0 profile and an explicit request budget.

GitHub's protected-main rules must require `VS Code 1.138.0 extension-host contract` and
`VS Code 1.138.0 smoke and independent task outcomes`, matching the current workflow job names. The release
preparation inspection on 2026-10-20 found the two retired 1.125.0 context names in repository ruleset `16181755`.
Migrate those context names together with the workflows, retaining the same required-check integration IDs, strict
up-to-date policy, review requirements, and CodeQL rules. The [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset)
is the administrative contract; the local workflow alone does not update repository rules.

The adapter's existing compatibility guards remain in place. Upgrading the host does not by itself authorize new
proposed APIs or establish that cancellation, opaque provider state, browser approval hooks, or LM stream ordering
behave identically. The deterministic LM fixture and exact-host suites must verify those contracts.

## Observed API and cancellation differences

The installed 1.125.0 and 1.138.0 stable API definitions differ only in documentation, including an inlay-hint ordering
clarification and a test-run parameter comment. The LM message constructors still expose User and Assistant, so this
migration does not invent a System constructor or enable proposed APIs.

Runtime behavior does change. The [1.138.0 LM implementation](https://github.com/microsoft/vscode/blob/1.138.0/src/vs/workbench/api/common/extHostLanguageModels.ts)
retains cancellation sources and forwards `$cancelLanguageModelChatRequest` after the startup RPC returns. The direct
fixture test reproduced the old characterization failure on the actual new host: the provider token was cancelled,
where the 1.125.0 contract expected it to remain uncancelled. The revised tests wait for the provider's cancellation
event and require both direct and Alpha-owned requests to return without manually releasing the held fixture. Alpha's
existing cancellation bridge remains necessary for prompt local teardown and compatibility guards.

## Validation

Validated locally on Windows x64 on 2026-10-19, with Node 24.21.0 and pnpm 11.24.0:

- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`: passed all thirteen host suites on actual VS Code 1.138.0,
  including all eight deterministic LM contracts and both background-command tests. Every selected test was required.
- `pnpm --filter @alpha-code/vscode-e2e test:extended:1380:run`: passed all five extended host suites using the fresh
  extension/webview build, including storage recovery, scheduled tasks, and rich-document reopening.
- E2E runner unit tests: 671 passed, two platform-specific skips. The final host-option/profile regression selection
  passed all 34 tests after recompilation.
- VS Code LM adapter, contract, and transport parity unit tests: 171 passed across three files.
- Offline evaluator unit tests: 392 passed across 38 files.
- Harness and portable runner tooling: 88 passed, including old-host receipt rejection and manifest/type/gate alignment.
- Extension, E2E runner, and evaluator typechecks passed. E2E runner and evaluator lint passed. The extension and webview
  builds passed. Focused formatting and `git diff --check` passed.
- `pnpm vsix` and `node scripts/verify-vsix-contents.mjs bin/alpha-3.2.4.vsix --check-source` passed: 1,815 archive entries
  verified, all 16 checked document assets match source, and no `.env` file is packaged. The packaged manifest's minimum
  editor version is `^1.138.0`. VSCE emitted its file-count advisory; packaging completed successfully.

The first direct cancellation characterization failed for the expected reason before its correction: the 1.138.0
provider received late cancellation. The new-host runner-default regression also failed before updating the runner.

Historical 1.125.0 results in other design documents are not evidence of 1.138.0 compatibility. No signed-in live Copilot
requests were run, and this migration does not claim live model quality, the complete core confidence/certification
campaign, or cross-platform host validation. Those remain separate follow-up checks.

## Reusable local live-test profile

The dedicated 1.138.0 profile has been initialized on this Windows machine. Reuse these owned roots for live runs:

- Profile root: `F:\alpha-e2e\profiles`; the version-specific directory is `F:\alpha-e2e\profiles\1.138.0`.
- Persistent application storage: `user-data`, `extensions`, and `shared-data` inside that version-specific directory.
- Workspace: `F:\alpha-e2e\workspace`.
- Run evidence for 1.138.0: `F:\alpha-e2e\artifacts-1380`.

To reopen interactive setup with the same saved profile, run from the repository root:

```sh
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.138.0 --vscode-executable F:\roo-fork\Alpha-Code\apps\vscode-e2e\.vscode-test\vscode-win32-x64-archive-1.138.0\Code.exe --profile-dir F:\alpha-e2e\profiles --workspace F:\alpha-e2e\workspace --artifacts-dir F:\alpha-e2e\artifacts-1380 --setup
```

Use the normal development-sidecar host so credentials are stored by VS Code in persistent storage. Do not use
`--extensionTestsPath`, disposable profiles, or copy credential stores from 1.125.0. Sign-in is performed manually.
Choose **Continue / Retry** in **Copilot test setup** after signing in, then **Finish** after readiness succeeds so the
host closes normally and flushes storage. Before claiming saved authentication works, reopen this same profile and
check model discovery and Alpha model access without issuing a model request.

Saved access is verified by run `live-1380-saved-access-1792462445902`. The same profile was closed and reopened on exact
VS Code 1.138.0: discovery returned 19 models, all with `canSendRequest: true` in Alpha's extension context, with zero
model requests. The single required discovery test passed, the host exited normally with verified ownership, evidence
capture completed, and retention completed. The correlated receipts are in
`F:\alpha-e2e\artifacts-1380\live-1380-saved-access-1792462445902`.

An earlier reopen proved model access but its overall runner result was blocked by an incomplete, over-budget retention
scan of the historical shared `F:\alpha-e2e\artifacts` root. New 1.138 runs use the separate evidence root above. No
historical evidence or credentials were deleted or copied, and retention limits were not weakened. The initial sign-in
setup receipt was cancelled; the subsequent clean reopen is the evidence of persisted access. This verifies saved
authorization, not a successful live model request. Select an exact discovered model and a request budget before a paid
workflow test.
