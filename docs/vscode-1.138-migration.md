# VS Code host compatibility

VS Code **1.125.0** is the installation minimum. Exact **1.138.0** is the reference product and primary release gate.
Moving the reference host does not raise the installation minimum.

## Manifest and API boundary

- `src/package.json` declares `engines.vscode: ^1.125.0` and compiles against `@types/vscode@1.125.0`.
- The E2E runner uses the reference-host types and selects an exact host for each suite.
- Production features must work with stable APIs available in 1.125.0. Detect optional newer APIs at the VS Code adapter
  boundary and provide a tested minimum-host fallback.
- The runner's proposed-API flag is a test facility, not production authorization.
- Raising the installation minimum requires an explicit compatibility decision, a demonstrated dependency, and coordinated
  manifest, types, minimum-host tests, workflows, and documentation updates.

## Required gates

Run from the repository root using the pinned Node and pnpm versions:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The first command builds the extension and webview and runs the primary exact-host contracts. The second checks activation,
modes, storage recovery, and deterministic VS Code LM behavior on the installation minimum. Its result cannot satisfy the
1.138.0 gate. The `:run` variants reuse existing extension/webview builds; only use them when those builds are current.

Changes involving host adapters or the installation minimum require both gates. The repository guide also requires the
reference-host gate for activation, commands, webviews, VS Code LM, task lifecycle, cancellation, persistence, modes, and
packaging. Report a blocked host launch explicitly; another editor version cannot substitute for the required host.

The focused deterministic LM command is:

```sh
pnpm --filter @alpha-code/vscode-e2e test:vscode-lm:1380:run
```

Preserve ordered response parts, opaque provider/reasoning state, tool-call IDs, usage, cancellation, and recovery.
Host cancellation behavior is version-specific: the fixture characterizes late cancellation separately while Alpha's
cancellation bridge must settle promptly on both supported hosts.

## Host and profile ownership

Keep scripted acceptance profiles disposable and distinct from signed-in live profiles. Persistent profiles are isolated
by exact host version. Do not copy credential stores between versions or reset unrelated profiles. Record the actual host
version, model ID, owned profile, and run conditions with live evidence. Model discovery or saved sign-in alone does not
establish a successful model request.

Use the [dedicated live-profile runbook](vscode-live-test-profiles.md) for setup and the
[testing workflow](testing-harness.md) for the wider validation matrix. Receipts retain their original host identity;
historical results do not certify the current source.

When moving the reference host, update runner defaults, exact-host scripts and assertions, fixtures, evidence validators,
CI/release job names, and documentation together. Required GitHub check names are repository administration state and must
be coordinated with workflow job names.

Primary platform contracts: [extension manifests](https://code.visualstudio.com/api/references/extension-manifest),
[stable API](https://code.visualstudio.com/api/references/vscode-api), and
[Language Model API](https://code.visualstudio.com/api/extension-guides/language-model).
