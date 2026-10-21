# Fix 14: native VSIX artifact correctness

Mode: operational hardening. Scope: the high native-platform finding in `clean-09-workflows.md`, optional LanceDB
loading, and the search-output worker's build/package integration. Existing unrelated edits were preserved. No dependency
installation, dependency upgrade, lockfile change, release, publication, or commit was performed by this agent.

## Contract and evidence

- Microsoft's [platform-specific extension contract](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions),
  retrieved 2026-10-20, says `--target` selects platform packages and an omitted target creates a fallback for other
  platforms. Native Node modules are an explicit use case. Alpha now declares its actual target instead of presenting
  the build host's native binary as a universal artifact.
- The installed `@lancedb/lancedb` **0.27.2** manifest declares seven optional native packages. Its actual native loader
  requires the matching flat `lancedb.<platform>.node` filename after bundling. It declares no Intel macOS native package.
  These current package files, not historical Alpha design documents, determine the mapping below.
- Current [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
  retrieved 2026-10-20, confirms `windows-11-arm`, `ubuntu-24.04-arm`, `macos-14` ARM64, and `macos-15-intel` labels.
  The [download-artifact v7 contract](https://github.com/actions/download-artifact/blob/v7/README.md) confirms Node 24 and
  matrix artifact collection with `pattern` and `merge-multiple`. No existing production dependency was upgraded.
- This is extension packaging and optional-backend isolation. No Codex runtime, prompt, authority, or sandbox behavior
  was ported or changed. Parent research baseline: Codex `c7234c1174b27d9c55199fba0d546dc27d1b0415`.

## Explicit platform mapping

| VSIX target    | Required flat LanceDB file                | Release runner                        |
| -------------- | ----------------------------------------- | ------------------------------------- |
| `win32-x64`    | `lancedb.win32-x64-msvc.node`             | `windows-latest`                      |
| `win32-arm64`  | `lancedb.win32-arm64-msvc.node`           | `windows-11-arm`                      |
| `darwin-arm64` | `lancedb.darwin-arm64.node`               | `macos-14`                            |
| `darwin-x64`   | None: core extension plus Qdrant indexing | `macos-15-intel`                      |
| `linux-x64`    | `lancedb.linux-x64-gnu.node`              | `ubuntu-latest`                       |
| `linux-arm64`  | `lancedb.linux-arm64-gnu.node`            | `ubuntu-24.04-arm`                    |
| `alpine-x64`   | `lancedb.linux-x64-musl.node`             | Mapping tested; release lane deferred |
| `alpine-arm64` | `lancedb.linux-arm64-musl.node`           | Mapping tested; release lane deferred |

The release matrix produces six desktop artifacts. Alpine release support remains deferred because this change does not
claim a validated Alpine install/build/host path. The native helper still distinguishes GNU libc and musl correctly.
`web`, `linux-armhf`, 32-bit Windows, and unknown targets are rejected by this packaging route. Intel macOS retains core
installation support; a local-indexing request explains the unavailable backend and points to Qdrant.

## Exact edits

- `src/lancedb-native.mjs`: one target-to-binding mapping, host OS/CPU/libc selection, and an explicit-target inventory
  that fails if the required optional dependency is absent and copies only the matching binding. Development inventory
  without an explicit target retains its previous installed-subset behavior.
- `src/esbuild.mjs`: packaging's `ALPHA_VSIX_TARGET` selects that inventory; `workers/searchCommandOutput.ts` is now a
  worker entry alongside the existing workers.
- `scripts/package-vsix.mjs` and `src/package.json`: the standard `pnpm vsix` route automatically labels the native host
  and writes `bin/alpha-<version>-<target>.vsix`. It validates inventory before invoking the installed VSCE executable
  through Node with structured arguments, and propagates the same target to prepublish bundling. Explicit cross-host
  targets fail. The dormant `publish:marketplace` script was removed after repository search found no retained caller or
  documentation; its direct publishers could otherwise regenerate unsafe untargeted artifacts. No publisher was run.
- `scripts/install-vsix.js`: selects the same targeted filename. Its historical tracked CRLF lines are preserved;
  only the two edited lines use LF so the focused diff passes the repository whitespace check without whole-file churn.
- `README.md`: current manual installation examples use the targeted filename, Intel macOS's indexing limitation is
  explicit, and the existing minimum-host/reference-host confusion is corrected to 1.125.0/1.138.0 with both gate commands.
- `scripts/verify-vsix-contents.mjs`: requires a bounded (64 KiB) VSIX manifest, reads `Identity.TargetPlatform`, supports
  `--target` assertions independently of verifier OS, requires the correct flat native file, and rejects extra platform
  bindings. Intel macOS must contain no LanceDB binary. The verifier now also requires `dist/workers/searchCommandOutput.js`.
  Existing credential, copied-document, WASM, and ripgrep checks remain in force; ripgrep checks use the declared target.
- `src/services/code-index/vector-store/lancedb-client.ts` and English `embeddings.json`: the optional native library loads
  through one cached asynchronous import on first indexing use. A missing backend stays inside the indexing error
  boundary with platform, index-path, original error, and Qdrant/reinstall guidance. Importing services does no native
  load or index-directory creation.
- `.github/workflows/release-vsix.yml`: existing Windows release-quality gates remain prerequisites. Matching native
  runners build the six artifacts, execute inventory/isolation regressions, run real native-index tests where supported,
  verify the archive target, and upload each separately. Release creation depends on the whole matrix and requires all
  six expected filenames. The workflow is normally tracked (`git ls-files -v` reports `H`), not ignored or hidden by an
  index flag. No Git staging or index flag changes were made.
- Tests: native inventory/host mapping, an esbuild-generated CommonJS lazy-load regression, unavailable-backend behavior,
  safe packager invocation, installer filename selection, matrix publication prerequisites, archive target/native
  matching for all eight mappings, untargeted/ambiguous/mixed-platform rejection, manifest allocation limits, and a
  missing search-worker archive regression.

## Validation run by this agent

Baseline: existing native inventory **10/10** and packaging/installer/archive tooling **31/31** passed. The new loading
regression failed before the change because importing `lancedb-client.ts:3` evaluated the unavailable native dependency.

After the fix:

- `pnpm --dir src test __tests__/lancedb-native.spec.mjs services/code-index/vector-store/__tests__/lancedb-loading.spec.ts services/code-index/vector-store/__tests__/lancedb-client.spec.ts`: **32/32 passed**.
- `pnpm --dir src test services/code-index/vector-store/__tests__/lancedb-native.spec.ts`: **3/3 passed**, real Windows
  x64 binding and temporary local index. No performance improvement claim is made from this test's existing benchmark.
- `node --test scripts/package-vsix.test.mjs scripts/install-vsix.test.js scripts/verify-vsix-contents.test.mjs`:
  **49/49 passed**, including the final rerun after the removed-publisher wiring assertion.
- `node --test scripts/harness/catalog.test.mjs`: **9/9 passed**; existing host and compatibility prerequisites remain.
- Scoped ESLint for the native helper, native packaging tests, lazy client, and loading regression: passed.
- Prettier passed for the owned source/tooling/workflow files. The historical CRLF installer received focused diff and
  whitespace verification instead of a complete line-ending rewrite. `git diff --check` for the owned changes: passed.
- An in-memory esbuild invocation emitted `dist/workers/searchCommandOutput.js` from the settled worker source, with no
  output written. The archive fixture refuses its omission. Both new release PowerShell blocks parsed successfully
  without executing their build, upload, or publication commands.

After the script-only manifest changes, pnpm checks used per-process
`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` to avoid automatic installs. No repository/global pnpm setting was changed.

## Parent integration checks and residual risk

Sources are ready for the parent's serialized build/package/host checks. Do not pass target arguments through root Turbo:
its dry-run demonstrated that they are forwarded to dependency builds as well. Use plain `pnpm vsix` on the matching host.
For an explicit package-only invocation after its build prerequisites, use `pnpm --dir src vsix --target <target>`.

```powershell
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'warn'
pnpm --dir src check-types
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-3.2.6-win32-x64.vsix --check-source --target win32-x64
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

This agent intentionally did not run broad bundle/VSIX/host checks while other agents edited. The parent reported its
integrated typecheck and bundle passing; the final integrated results belong in the parent report. Hosted matrix
execution and installation/activation of each new artifact on its matching exact 1.138.0 host remain unverified here.
Archive fixtures prove filename/target contracts; they do not execute foreign-architecture machine code. Existing native
tests exercise the installed native dependency on matching runners, rather than loading an extracted release artifact.

The retired publisher's existing `ovsx` development dependency was left unchanged to preserve the no-dependency/lock
constraint; pruning that unused tool is a separate dependency-only cleanup. No local indexing support is claimed for
Intel macOS until the dependency supplies a validated matching binding. No VS Code installation minimum was raised.
