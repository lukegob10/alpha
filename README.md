# Alpha Code

Alpha is a VS Code extension for planning, coding, debugging, and reviewing work with AI.

## Install

Download Alpha from [GitHub Releases](https://github.com/lukegob10/alpha/releases/latest). Choose the `.vsix` matching your
operating system and architecture, then run **Extensions: Install from VSIX...** in VS Code **1.125.0** or newer.
The exact development and release reference host is VS Code **1.138.0**; it does not raise the installation minimum.

## Work in Alpha

- Plan systems and changes in **Plan**, then implement, investigate, and debug in **Code**. Press `Shift+Tab` in the
  chat composer to switch modes.
- Search and edit files, run commands, and inspect whole-turn or per-file diffs in Alpha Diff.
- Keep concurrent task sessions and delegate bounded work to managed agents while other sessions run in the background.
- Use built-in skills, Alpha Tickets, the HTML document previewer, and scheduled tasks.
- Connect MCP servers and use automatic context compaction for longer tasks.

Choose **Ask**, **Auto**, or **Full Access** for tool approval behavior. Provider selection does not change the approval
policy or workspace protections.

Default Windows keyboard shortcuts:

| Shortcut                                | Action                               | Scope                                                |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `Ctrl+Alt+N`                            | New Chat                             | Anywhere; uses the focused Alpha view when available |
| `Ctrl+Alt+S`                            | Steer                                | Focused Alpha view                                   |
| `Alt+,` / `Alt+.`                       | Decrease / increase reasoning effort | Focused Alpha view                                   |
| `Ctrl+Alt+PageUp` / `Ctrl+Alt+PageDown` | Previous / next task                 | Focused Alpha view                                   |
| `Ctrl+Alt+Home`                         | Next task needing input              | Focused Alpha view                                   |
| `Ctrl+K Ctrl+A`                         | Add selection to chat context        | Text editor with a selection                         |
| `Ctrl+Alt+A`                            | Cycle Ask / Auto / Full Access       | Visible Alpha chat composer                          |
| `Shift+Tab`                             | Switch Plan / Code                   | Chat composer                                        |

Use VS Code's **Keyboard Shortcuts** editor and search `alpha.` to customize bindings, including **Focus Input** and
**Accept Input**, which have no default binding. The context-selection chord and approval toggle also have macOS and
Linux defaults; the other host shortcuts above are Windows-only. Enter behavior follows the chat setting.

Macro-pad keys **F13–F24** can be assigned to Alpha commands through VS Code's Keyboard Shortcuts editor or
`keybindings.json` (`"key": "f24"`, for example). Alpha leaves these keys available to VS Code, including while typing
in the composer. For commands with separate editor and sidebar bindings, customize both entries; retain
`"args": "sidebar"` on the sidebar entry so the shortcut targets that view.

Steer applies the oldest available queued message first (FIFO). Further presses advance through the remaining queue.
An empty queue does nothing; unsent composer text and images stay untouched. Existing bindings to `alpha.sendAndSteer`
use this queue-only action.

Cycle Approval Mode advances **Ask → Auto → Full Access → Ask** for the current chat or new-chat draft. The first
selection of Full Access requires its acknowledgment; cycling does not change the default approval mode for other chats.

Previous Task walks toward older saved chats in the current workspace; Next Task walks toward newer chats. Navigation
keeps a stable history order while browsing and stops at either end. It includes chats that are no longer loaded.

Enable **Settings → Auto-Approve → Wait indefinitely for question answers**, then **Save**, to keep questions open until
you answer, including in Full Access. Turning it off lets Full Access use first suggested answers after a configurable
delay. Ask and Auto always wait for your answers.

Mermaid diagrams keep readable text in chat; scroll large diagrams to see the rest. Select **Open diagram** for the
full editor SVG preview. Use **Zoom Out** and **Zoom In** in the editor toolbar. To fit the entire diagram again, select
the zoom percentage in the status bar, then **Whole Image**. **Save Image** exports a PNG.

Supported chat providers are native OpenAI, Sign in with ChatGPT, Anthropic, Gemini, xAI, Meta, Amazon Bedrock, OpenRouter,
GCP Vertex AI, VS Code LM API, Stellar, and OpenAI Compatible. Select the provider and model in Settings and click
**Save**. API-key providers use their own credentials. Bedrock supports the default AWS credential chain, a named AWS
profile, explicit AWS credentials, or a Bedrock API key. **Continue with ChatGPT** opens the browser for eligible ChatGPT
plan access; its account credentials remain in VS Code SecretStorage and are not exported with provider profiles.

Native providers and OpenRouter use a bundled catalog of frontier and very near-frontier models. ChatGPT and native
OpenAI share the same model shortlist. Extension updates can retire older choices; saved profiles keep their original
model IDs and report unsupported models without silently switching to a replacement. Choose reasoning separately in
the task composer; levels follow the selected model without a discovery request. OpenAI Compatible remains available
for explicitly configured custom endpoints and models.
Code indexing supports GCP Vertex AI and Gemini Developer API embeddings. Retired saved modes resume in Plan.

Enable optional local memory in **Settings → Context → Memories**, then **Save**. Use and generation have separate
controls; background generation uses the selected provider and can incur model usage. Memory uses eligible idle
conversations and stores `memory_summary.md` and `rollout_summaries/` under `~/.alpha/memories_v2/` (or
`$ALPHA_HOME/memories_v2/`). Use changes apply to new conversations; generation changes also apply to the displayed
conversation. Turning memory off retains its files. **Reset all memories** removes learned state without deleting
conversations. Optional memory tools provide scoped retrieval and user-requested remember, correct, or forget notes.

Alpha uses the GitHub CLI (`gh`) through its command tool. Install it where the extension runs and authenticate with
`gh auth login`. Commands use the selected approval policy.

The standalone Alpha CLI is retired. Development and evaluation commands run the real extension. Historical task and
evaluation records remain readable.

## Develop

Read [AGENTS.md](AGENTS.md) for engineering requirements. Use Node.js **24.21.0**, its pinned npm **11.19.0**, and
pnpm **11.24.0**. pnpm is the repository package manager.

```sh
git clone https://github.com/lukegob10/alpha.git
cd alpha
pnpm install --frozen-lockfile
pnpm --dir src rebuild @vscode/ripgrep
pnpm --filter @alpha-code/types build
pnpm harness doctor
```

Turbo orders workspace builds and reuses their outputs. Its ignored `.turbo/` data is disposable; local cache entries
are pruned at the start of runs using seven-day retention and a 2 GB size target.

Open the checkout in VS Code 1.138.0, select **Run Extension** in Run and Debug, and press `F5`. The
[launch configuration](.vscode/launch.json) starts the [watch tasks](.vscode/tasks.json) and opens an Extension Development
Host with webview hot reload. Extension code rebuilds automatically; restart the development host to load those changes.
Select **Run Extension (debugger)** when you need breakpoint debugging.

## Testing

Start with the focused tests and owning typecheck in the [validation matrix](AGENTS.md#validation-matrix).
Tooling checks execute workflow scripts with PowerShell 7 (`pwsh`), which must be on `PATH` on every platform.
Use `pnpm harness list` for available checks. Common extension checks use the same harness as CI:

```sh
pnpm harness run static
pnpm harness run unit
pnpm harness run host
```

Run build and host checks sequentially. The `host` lane runs the exact VS Code 1.138.0 smoke gate; minimum-host or
host-adapter changes also require the compatibility gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The `extended` lane covers instructions, HTML previews, storage recovery, and scheduled tasks; `confidence` runs the
broader core gate. Offline evaluator checks use `pnpm test:evals:offline`; the
[evaluator guide](packages/evals/README.md) covers service-backed checks and fixture authoring.

### Reviewed improvement loop

Run `pnpm --filter @alpha-code/evals benchmark:improve --help` for the evidence and feedback workflow. The
[operator guide](evals/problem-solving/improvement-loop.md) walks through human adjudication, draft regression
validation, ranked implementation handoffs, and fresh confirmation through the existing extension-host runner.
It distinguishes full evaluator evidence, retained host observations, and opt-in future native captures.
Offline controls and archived results do not establish live quality. Model review and live confirmation require
explicit configuration and budgets; reports and handoffs remain tool artifacts, and generated tasks require review.

### Live tests

Live provider runs supplement deterministic checks and require their own credentials and run budget. Use three separate
absolute profile, workspace, and artifact paths outside this checkout and normal VS Code data. Profile and workspace
directories must initially be empty or absent. Initialize a dedicated profile after building the extension and runner:

```sh
pnpm bundle
pnpm --filter @alpha-code/vscode-webview build
pnpm --dir apps/vscode-e2e compile
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.138.0 --profile-dir "<absolute-profile-root>" --workspace "<absolute-workspace>" --artifacts-dir "<absolute-artifacts-root>" --init-profile --setup
```

Sign in inside the dedicated host. After discovery, repeat setup with the exact returned `--model-id` and a supported
`--reasoning-effort`, then finish the readiness check. Omit `--init-profile` after initialization and `--setup` when
running tests. Setup and model discovery do not prove that a task passed. Never copy credentials between profiles or
reset unrelated editor data. See the [runner options](apps/vscode-e2e/src/runTest.ts) for current flags.

Claude has dedicated deterministic and live suites on VS Code 1.138.0. After the build commands above, run the
mechanical fixture without credentials, then run the live suite with the exact Claude model ID returned by discovery:

```sh
pnpm test:claude:mechanical
pnpm test:claude:live --model-id "<exact-copilot-claude-model-id>" --reasoning-effort high --profile-dir "<absolute-profile-root>" --workspace "<absolute-workspace>" --artifacts-dir "<absolute-artifacts-root>"
```

Use a supported reasoning effort for the selected Claude model. Both commands require every selected test to execute;
the live suite uses the signed-in dedicated profile and retains the actual model, host, request counts, and task results.
An unavailable Claude model cannot fall back to another model or count as a live pass.

The live model matrix runs the same complete suite sequentially with **GPT 6 Luna / max**, **Claude Haiku 5.5 / high**,
then **Grok 4.6 / low**, exclusively on **VS Code 1.138.0**. It prepares the build and deterministic host gates once,
uses fresh scenario workspaces, and retains separate model reports plus a combined `matrix-result.json`. Every model
must pass; missing models, unsupported effort, failed scenarios, and incomplete evidence cannot become a passing result.
Source/build changes or a changed Copilot implementation invalidate the comparison. Model IDs are exact; no fallback is allowed.

After completing dedicated-profile setup, preview the plan without creating a campaign or making live requests:

```sh
pnpm test:live:matrix --root "<absolute-campaign-root>" --profile-dir "<absolute-profile-root>" --dry-run
```

Run the matrix with the same paths and `--init-root` for a new empty campaign root. Omit `--init-root` on subsequent runs:

```sh
pnpm test:live:matrix --root "<absolute-campaign-root>" --profile-dir "<absolute-profile-root>" --init-root
```

Each model gets one sample per scenario by default. `--max-requests` sets a separate request cap for each model;
the preview shows their combined cap. `--samples` explicitly increases repetitions. Use `test:live:matrix:core` for
the smaller core suite or `test:live:matrix:reliability` for lifecycle and recovery coverage. An ordinary model failure
does not skip the remaining models; cancellation or changed comparison conditions stop further launches.

## Package and install a local build

```sh
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-<version>-<target>.vsix
```

Substitute the generated filename from `bin/`, then install it with **Extensions: Install from VSIX...**.
Local packages target the build host, such as `win32-x64` on Windows x64.

For an automated build and installation, run `pnpm install:vsix`. It installs frozen dependencies, cleans generated build
output, builds the VSIX, and asks before installing with `--force`. Use `--editor=code`, `--editor=code-insiders`, or
`--editor=cursor` to select an editor command; `-y` skips prompts. Restart the editor after installation.

The [release workflow](.github/workflows/release-vsix.yml) builds each target on a matching host and publishes all six
verified packages to GitHub Releases after its validation gates. Published downloads retain their target suffix:
`alpha-<version>-<target>.vsix`.

| Operating system | x64 target   | ARM64 target   |
| ---------------- | ------------ | -------------- |
| Windows          | `win32-x64`  | `win32-arm64`  |
| macOS            | `darwin-x64` | `darwin-arm64` |
| Linux            | `linux-x64`  | `linux-arm64`  |

Intel macOS supports core features and Qdrant code indexing; this LanceDB version has no Intel macOS native binding for
local indexing. Publication requires every target to pass packaging and verification. The workflow runs automatically
for `src/package.json` changes on `main` and supports manual dispatch on a selected release branch. It does not publish
to the VS Code Marketplace. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Resources and contributions

- [Engineering guide](AGENTS.md): architecture, compatibility, security, and validation requirements.
- [Evaluation inputs](evals/): suites, fixtures, measurement contracts, and historical evidence.
- [GitHub Issues](https://github.com/lukegob10/alpha/issues): bugs, feature requests, and development questions.

Open an issue before starting a substantial contribution and follow [AGENTS.md](AGENTS.md).
For intended agent behavior, compare current [Codex CLI source and tests](https://github.com/openai/codex) as required by
the engineering guide; keep Alpha's own approval and workspace protections.

## Disclaimer

**Please note** that Alpha, Inc does **not** make any representations or warranties regarding any code, models, or other tools provided or made available in connection with Alpha, any associated third-party tools, or any resulting outputs. You assume **all risks** associated with the use of any such tools or outputs; such tools are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include, without limitation, intellectual property infringement, cyber vulnerabilities or attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or damage, and/or personal injury. You are solely responsible for your use of any such tools or outputs (including, without limitation, the legality, appropriateness, and results thereof).

## License

[Apache 2.0 © 2025 Alpha, Inc.](./LICENSE)
