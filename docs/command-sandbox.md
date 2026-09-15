# Command auto-approval and filesystem isolation

## Contract

The extension's command runner uses an OS sandbox. Auto-approval and command prefix rules decide whether Alpha asks;
the sandbox decides where the process and its descendants can write. With command auto-approval enabled and `*` allowed,
scripts and commands with computed executables run automatically when there are no deny rules. Explicit deny rules,
disabled tools, mode restrictions, and inherited worker authority still apply.

The write grant comes from the immutable step policy. An outside `cwd` does not add a write grant. Another open VS Code
workspace folder does not add a write grant. The native runtime enforces the boundary for relative paths, junctions,
symlinks, scripts, and descendant processes. Plan commands receive read-only workspace access.

Network access remains enabled. Alpha supplies a separate scratch/cache directory for each workspace scope, outside other
projects. It redirects common temporary, npm, Corepack/XDG, and Python cache locations there. Runtime binaries and setup
credentials remain outside the writable workspace. Harness configuration directories stay protected.

Outside writes through native file tools retain their existing explicit approval flow. A sandboxed command cannot escape
through an approval, failed setup, or shell-integration fallback. For an outside edit, use the approved native file tool.
For commands that need another project's write scope, start a task in that project. A linked worktree's Git metadata outside
the task root is not implicitly writable.

## Persistence and UX

Approval preferences remain in their existing global settings store. Runtime installation and Windows setup persist for
the user, across projects, task restarts, and extension reloads. No approval preferences are reset or migrated.

The first command downloads the pinned runtime with a cancellable progress notification. Windows reuses a compatible
existing native sandbox setup when available. A machine without one may need a one-time Windows administrator prompt;
ordinary project changes do not create another approval setting or setup choice. An administrator can complete initial
machine provisioning before unattended use.

Extension commands use the inline terminal adapter, including tasks with a saved host-terminal preference. That adapter
owns process cancellation and output. The terminal settings show the effective behavior; obsolete shell-integration
workaround controls are no longer presented. Their persisted values remain readable. The protected CLI application keeps
its existing host execution and explicit command approvals.

## Runtime and compatibility

The runtime is the standalone sandbox command from **Codex CLI 0.144.6**, source commit
`1e66aaa95b5ab39d3ef3057cd50bdecd576a8356`, inspected on **2026-09-15**. No model, OpenAI account, login, API call, or provider
selection is involved. Alpha supplies a complete managed permission profile through `--sandbox-state-json`, an explicit
Windows elevated-sandbox setting, and a fixed environment policy. User or project Codex configuration cannot replace the
filesystem grant with full access. Installation verifies the official archive SHA-256 before extraction and atomically
publishes the versioned directory. Failed or cancelled downloads leave no usable partial installation.

Windows uses the native restricted process identity and private desktop. macOS and Linux use the runtime's native sandbox
backends. Unsupported platforms and failed native initialization fail closed. The runtime is downloaded once (roughly
110–140 MB compressed), rather than bundled into every VSIX.

Two Windows compatibility adaptations are confined to the launcher:

- Git receives process-local `safe.directory` entries for the task's roots because the sandbox uses another Windows
  identity. It never writes a wildcard trust grant to the user's Git configuration. In-root `.git` metadata is writable;
  metadata resolving outside the root is not granted.
- Node 20's JavaScript `realpathSync` can fail while enumerating an ancestor that Windows does not expose, even when the
  target is accessible. A Windows Node preload retries only those `EPERM`/`EACCES` `lstat` failures through the native
  handle-based implementation. OS access checks still apply. `--preserve-symlinks-main` allows the preload to initialize
  before Node resolves the entry point. This Windows adaptation requires Node with `--import` support (18.18+); the
  development and release baseline remains Node **20.19.2**.

PowerShell commands use encoded arguments. For CMD, a fixed encoded PowerShell adapter passes the original interactive
command line to CMD using its native quoting rules, streams stdout/stderr, and closes stdin for noninteractive execution. Command text and executable
paths enter the adapter as base64 data. The wrapper itself runs inside the sandbox and belongs to the same process tree.

## Validation

`CommandSandbox.spec.ts` covers the explicit grant, outside cwd, cancellation, and unavailable runtime.
It also covers VS Code's lowercase Windows drive spelling and scope identity changes before launch.
`SandboxRuntime.spec.ts` covers global reuse, checksum failure, cleanup, and retry.
`CommandSandbox.native.spec.ts` is an opt-in real-OS gate: set `ALPHA_SANDBOX_NATIVE_RUNTIME` to the executable from the
checksum-verified pinned release package, then run:

```sh
pnpm --dir src test -- integrations/terminal/__tests__/CommandSandbox.native.spec.ts
```

The native gate exercises writes/deletes/renames, junction escapes, descendant writes, two independent projects sharing
setup, read-only Plan execution, loopback networking, inline cancellation, quoted executable paths, pnpm builds, and Git
metadata writes. Mocked lifecycle tests do not substitute for this gate.

The preview release workflow also runs `test:command-sandbox:1221:run` after building the extension. This real-host test
requires a successful command through the production installer and launcher, with global `*` approval, zero command
approvals from the harness, an in-root write, and blocked outside writes/deletes. It fails on a command error even if
the task lifecycle reaches completion.

Release gates also include affected unit tests, both package typechecks/lint, localization, packaging verification, and
the exact **VS Code 1.122.1** smoke gate. Platform-specific evidence must be reported separately; a Windows run does not
establish macOS/Linux compatibility.

## Sources

- [Sandbox CLI source at the pinned revision](https://github.com/openai/codex/blob/1e66aaa95b5ab39d3ef3057cd50bdecd576a8356/codex-rs/cli/src/debug_sandbox.rs)
- [Pinned runtime release and asset digests](https://github.com/openai/codex/releases/tag/rust-v0.144.6)
- [Windows sandbox design](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Node 20.19.2 preload options](https://nodejs.org/download/release/v20.19.2/docs/api/cli.html#--importmodule)
- [Node native realpath](https://nodejs.org/download/release/v20.19.2/docs/api/fs.html#fsrealpathsyncnativepath-options)

The Codex runtime is distributed upstream under Apache-2.0. Alpha's integration is independent of the selected model
provider and does not invoke the Codex agent loop.
