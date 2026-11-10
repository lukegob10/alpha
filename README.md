# Alpha Code

Alpha is a VS Code extension for planning, coding, debugging, and reviewing work with AI.

## Install

Download Alpha from [GitHub Releases](https://github.com/lukegob10/alpha/releases/latest). Choose the `.vsix` matching your
operating system and architecture, then run **Extensions: Install from VSIX...** in VS Code **1.125.0** or newer.
The exact development and release reference host is VS Code **1.141.0**; it does not raise the installation minimum.

## Work in Alpha

Start in **Settings → Providers**: choose a provider, sign in or enter its credentials, and select a model. Review
**Settings → Preferences → Permissions** for the default approval mode, then start a chat. The composer lets you choose permissions
for an individual chat.

Settings has four dedicated sections: **Providers**, **Tools & agents**, **Preferences**, and **Advanced**. Help buttons beside controls explain options on demand.
Manage skills, agent definitions, and MCP servers in **Tools & agents**. Permissions, chat, sound, and memory choices live
in **Preferences**; context tuning, checkpoint configuration, and terminal troubleshooting live in **Advanced**.
Click **Save** to apply preference edits. Skill-file and MCP-server management actions take effect immediately.
Open **About Alpha** from the settings footer for version information and settings import, export, or reset.

- Plan systems and changes in **Plan**, then implement, investigate, and debug in **Code**. Press `Shift+Tab` in the
  chat composer to switch modes.
- Search and edit files, run commands, and inspect whole-turn or per-file diffs in Alpha Diff. Agent file edits run in
  the background; open a file or diff whenever you want to review it.
- Keep concurrent task sessions and delegate bounded work to managed agents while other sessions run in the background.
- Use built-in skills, Alpha Tickets, the HTML document previewer, and scheduled tasks.
  Type `/skill-name` to invoke a skill, and manage reusable workflows in **Settings → Tools & agents → Skills**.
  Custom `.alpha/commands/*.md` files are no longer loaded.
- Connect MCP servers and use automatic context compaction for longer tasks.

Choose **Ask**, **Auto**, or **Full Access** for tool approval behavior. Provider selection does not change the approval
policy or workspace protections. Changing a task's approval mode also rechecks its pending permission prompt; the action
proceeds when the new choice and its existing protection rules allow it.

In **Alpha Tickets**, use **Overview** for the completion ring and progress chart, or **Tickets** to browse and select
work. **Export** saves selected tickets, all filtered matches, or the project as one ZIP of readable Markdown files;
child tickets can be included. **Import** accepts one or more bundles or original ticket Markdown files and previews
the changes before adding copies or updating matching IDs. Copies receive fresh local references, preserve relationships
within the import, and start in backlog by default. Conversations are not included. The chart records observed daily
counts from first use; parent tickets are not counted again as work, and canceled tickets are excluded from scope.

In chat, ask Alpha to list or delete tickets directly. A group deletion uses one approval and the revisions returned by
the ticket list; it preserves linked conversations and rejects stale or incomplete parent/child selections before
deleting anything.

Subagents share the parent task's working directory and inherit its approval policy, permissions, and workspace scope.
Their file changes are immediately visible to the parent and other agents, so assign separate files when delegating
editing work in parallel. Agent roles describe their assignments; they do not grant additional permissions. Separate
chats can still use an explicitly selected Git worktree. Saved isolated worker changes remain available for review.
Use the worktree control beside a new chat to **Create worktree** or open **Manage Worktrees**.

Streamable HTTP MCP servers supporting OAuth dynamic registration can request browser authorization. Alpha stores
their credentials in VS Code SecretStorage. Servers with configured authorization headers and SSE servers retain
their configured authentication.

Use **Alpha: Recover Task History** from the Command Palette to inspect malformed records in an inactive saved task.
Recovery requires explicit confirmation, preserves the original history, and does not resume the task automatically.
Incomplete JSON and uncertain tool transactions remain blocked.

Configure lifecycle hooks through `alpha.completionHooks` in VS Code user settings. Existing camelCase event arrays
remain supported; Codex event names and matcher groups are also accepted:

```json
"alpha.completionHooks": {
  "PostToolUse": [{
    "matcher": "^Bash$",
    "hooks": [{ "type": "mcp_tool", "server": "checks", "tool": "review", "input": { "command": "${tool_input.command}" } }]
  }],
  "Stop": [{ "command": "/absolute/path/to/validator", "args": [], "timeout": 600 }]
}
```

Command hooks use absolute executable paths and argument arrays without a shell. Most hooks default to 600 seconds;
`Interrupt` and `SessionEnd` default to one second, with a three-second maximum. Commands can use `async: true` to
deliver advisory output at a later model boundary; `SessionEnd` always runs synchronously. `PostToolUse` observes
completed commands, including nonzero exits, under the `Bash` name with `tool_input.command`. Deferred command completion
uses the original call identity. A `Stop` response with `decision: "block"` and a nonempty `reason` continues the same
turn; `continue: false` takes precedence. Large hook output includes a path to the full text. Hooks retain Alpha's
bounded execution and native approval protections; workspace configuration cannot install hooks. Declared acceptance
checks record advisory evidence rather than requiring an exact passing command before completion.
To accept completion, exit successfully with no output or `{}`; `decision: "allow"` is not a supported Stop output.

All matching handlers run in configuration order through a four-worker queue, with at most 256 configured handlers per
event; larger configurations fail visibly. Cleanup timeouts apply to each handler independently. `Interrupt` precedes
the canonical interrupted-turn record, and `SessionEnd` receives a separate allowance. A new fork's first activation
reports `SessionStart` source `fork`; later cold restores report `resume`. These contracts were checked against Codex CLI
[`be765f1`](https://github.com/openai/codex/tree/be765f1adeecace0a2aef0700b1d13b0a2043a9f). Alpha retains its bounded
queue and short `Interrupt` timeout. Providers without a developer role receive hook context in its original position
with an explicit origin label.

Project instructions share a 32 KiB UTF-8 budget. Set `alpha.projectDocMaxBytes` in user settings to change it, up to
1 MiB; `0` disables project instruction files. Alpha warns when it truncates a file or skips deeper guidance. Workspace
settings cannot widen this budget. Plan can discover and load skills while its tools continue to enforce read-only work.

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

When **Full Access** is selected in **Settings → Permissions**, expand **Advanced permissions** to configure question
waiting. **Wait indefinitely for question answers** is enabled by default. Turning it off and clicking **Save** lets
Full Access use first suggested answers after a configurable delay. Ask and Auto always wait for your answers.

Mermaid diagrams keep readable text in chat; scroll large diagrams to see the rest. Select **Open diagram** for the
full editor SVG preview. Use **Zoom Out** and **Zoom In** in the editor toolbar. To fit the entire diagram again, select
the zoom percentage in the status bar, then **Whole Image**. **Save Image** exports a PNG.

Supported chat providers are native OpenAI, Sign in with ChatGPT, Anthropic, Gemini, xAI, Meta, Amazon Bedrock, OpenRouter,
GCP Vertex AI, VS Code LM API, and OpenAI Compatible. Select the provider and model in **Settings → Providers** and click
**Save**. API-key providers use their own credentials. Bedrock supports the default AWS credential chain, a named AWS
profile, explicit AWS credentials, or a Bedrock API key. **Continue with ChatGPT** opens the browser for eligible ChatGPT
plan access; its account credentials remain in VS Code SecretStorage and are not exported with provider profiles.

Native providers and OpenRouter use a bundled catalog of frontier and very near-frontier models. ChatGPT and native
OpenAI share the same model shortlist. Extension updates can retire older choices; saved profiles keep their original
model IDs and report unsupported models without silently switching to a replacement. Choose reasoning separately in
the task composer; levels follow the selected model without a discovery request. OpenAI Compatible remains available
for explicitly configured custom endpoints and models.
Code indexing supports GCP Vertex AI, Gemini, OpenAI, OpenAI Compatible, OpenRouter, and Amazon Bedrock embeddings.
Vertex uses a Google Cloud project and region with Application Default Credentials, a service account key file, or JSON
credentials. Indexing API keys are stored separately from chat credentials. OpenAI Compatible requires an embeddings base
URL, model ID, and vector dimension for custom models. Bedrock uses an AWS profile, the default AWS credential chain, or a
Bedrock API key. Changing the embedding model or endpoint requires rebuilding the index. Retired saved modes resume in Plan.

Enable optional local memory in **Settings → Preferences → Memories**, then **Save**. Use and generation have separate
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

Open the checkout in VS Code 1.141.0, select **Run Extension** in Run and Debug, and press `F5`. The
[launch configuration](.vscode/launch.json) starts the [watch tasks](.vscode/tasks.json) and opens an Extension Development
Host with webview hot reload. Extension code rebuilds automatically; restart the development host to load those changes.
Select **Run Extension (debugger)** when you need breakpoint debugging.

### Isolated release maintenance

Keep the verified release commit and its VSIX available while developing a cleanup on a separate branch and worktree.
Give each parallel change its own branch and worktree, then integrate complete, tested changes into the cleanup branch.
Fix release bugs against the release version first and merge those fixes into cleanup before continuing integration.

Run the release and cleanup packages in separate VS Code 1.141.0 instances, each with its own `--user-data-dir` and
`--extensions-dir`. Scope `ALPHA_HOME` and the child process's home directory to each instance so global rules, skills,
and memory use separate filesystem roots. On Windows, a launcher-local `USERPROFILE` can provide that home without
changing the operating-system profile. Install each VSIX only into its matching extension directory. Initialize
credentials separately and use copies of task and configuration data for compatibility tests; keep the everyday
editor profile intact.

For automated extension-host runs, set `ALPHA_E2E_USER_HOME` to an owned absolute directory. The runner applies it only
to the editor child process, leaving pnpm and build-tool configuration in the runner's normal home.

The naming cleanup deliberately uses Alpha-only configuration paths, credential keys, serialized fields, and public
exports. Prior names and automatic compatibility aliases are removed. Configure a fresh cleanup profile and verify
saved-data handling before promoting it to a release. Returning to an earlier Git commit does not restore editor data;
use the retained release profile and package when investigating release bugs.

## Testing

Start with the focused tests and owning typecheck in the [validation matrix](AGENTS.md#validation-matrix).
The E2E runner uses the published VS Code 1.140.0 API declarations with the exact 1.141.0 test host; 1.141.0
declarations are unavailable. The production extension continues to compile against 1.125.0.
Tooling checks execute workflow scripts with PowerShell 7 (`pwsh`), which must be on `PATH` on every platform.
Use `pnpm harness list` for available checks. Common extension checks use the same harness as CI:

```sh
pnpm harness run static
pnpm harness run turns
pnpm harness run unit
pnpm harness run host
```

The `turns` gate checks the shared stopping, continuation, retry, command execution, and history contracts. QA and
release require its current execution receipts. It uses scripted responses to test Alpha's behavior; live model
decisions are evaluated separately below. Before repairing a failed expectation, check the intended behavior against
current Codex CLI source and explain any deliberate difference in the change description.

Run build and host checks sequentially. The `host` lane runs the exact VS Code 1.141.0 smoke gate; minimum-host or
host-adapter changes also require the compatibility gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The `extended` lane covers instructions, HTML previews, storage recovery, and scheduled tasks; `confidence` runs the
broader core gate. Offline evaluator checks use `pnpm test:evals:offline`; the
[evaluator guide](packages/evals/README.md) covers service-backed checks and fixture authoring.

Use `pnpm --config.verify-deps-before-run=false harness:audit --plan` to inspect the repeatable repository audit, then
the same command without `--plan` to run its
static, unused-file, unit, tooling, offline evaluator, deterministic performance, exact 1.141.0, managed-agent and
minimum 1.125.0 gates sequentially. `--profile offline` excludes editor hosts; `--profile performance` selects the
bounded performance fixtures and existing benchmark workloads. `--expensive` adds rendered, stress, confidence,
outcome and VSIX checks; dedicated test services and Docker additionally require `--services` and `--infrastructure`.
The default deadline is 180 minutes (`--timeout-minutes 1..240`). A failed or cancelled lane leaves later lanes unstarted.

Optional evidence inputs require absolute paths: `--codex-root` checks a clean external checkout at the pinned audit
SHA without fetching it, `--reports` validates exactly `01.json` through `30.json`, and `--baseline` compares a prior
`step-N.benchmark.json` from the benchmarks lane with the same runtime and workload. Audit summaries are saved under
`artifacts/harness/.audits/`, with links to the existing lane receipts. Timings remain diagnostic; source references
and review reports do not establish behavioral equivalence or general speed improvements. Unselected coverage stays explicit.

### Reviewed improvement loop

Run `pnpm --filter @alpha-code/evals benchmark:improve --help` for the evidence and feedback workflow. The
[operator guide](evals/problem-solving/improvement-loop.md) walks through human adjudication, draft regression
validation, ranked implementation handoffs, and fresh confirmation through the existing extension-host runner.
It distinguishes full evaluator evidence, retained host observations, and opt-in future native captures.
Offline controls and archived results do not establish live quality. Model review and live confirmation require
explicit configuration and budgets; reports and handoffs remain tool artifacts, and generated tasks require review.

### Live tests

An agent-behavior release needs one reviewed successful real task through the extension on one provider/model. Luna
qualifies; testing every live model is optional. Full deterministic release checks still run on VS Code 1.141.0, with
minimum-host coverage on 1.125.0. For a fresh live smoke, use the dedicated signed-in profile described below and run:

```sh
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.141.0 --model-id "<exact-luna-model-id>" --reasoning-effort "<supported-effort>" --profile-dir "<owned-profile-root>" --workspace "<owned-workspace-root>" --artifacts-dir "<artifacts-root>" --file live-quality.test --grep supported-total
```

Export that completed run's evidence. An earlier recorded pass can be explicitly reviewed and reused by adding
`--reuse-recorded true`. Its original host, date and source identity remain recorded; unknown source identity stays
unknown. The review identifies the release candidate without claiming the historical run executed that candidate:

```sh
node scripts/harness/release-quality.mjs verify-smoke --run-dir "<completed-run-artifacts>" --fixture supported-total --candidate "<full-candidate-sha>" --output "<private-output>/smoke.json" --dispatch-input "<private-output>/dispatch.json"
```

Submit the sanitized input to **Live quality evidence** on the candidate branch:

```powershell
Get-Content -Raw -LiteralPath "<private-output>/dispatch.json" | gh workflow run live-quality-evidence.yml --ref "<candidate-branch>" --json
```

Run **Release VSIX** on the same commit with `quality_evidence_run_id` set to the successful evidence review run ID.
Both workflows validate the live smoke facts, require their own repository and candidate identities, and retain only
sanitized evidence. Submitted facts are reviewed captured observations, not cryptographic proof of model execution.
Keep the original private host artifacts for investigation.

Release validation lanes run in separate checkouts while all six native package builds run alongside them after live
preflight. Publication waits for every validation and package job plus an evidence barrier. That barrier rechecks the
harness's source, toolchain, host, freshness and test-inventory contracts, and binds native build provenance to package
hashes for the same workflow attempt. Publication verifies the downloaded package bytes again before creating a release.

For an optional broader quality comparison, use clean, separately built baseline and candidate checkouts and the same
runner, profiles, models, effort and conditions. The comparison keeps its two-provider, three-sample workload unchanged:

```sh
pnpm quality:capture capture --label baseline --provider live-copilot --model-id "<exact-model-id>" --effort "<supported-effort>" --profile-dir "<owned-profile-root>" --extension-development-path "<clean-baseline-checkout>/src" --output "<new-baseline-output>" --samples 3
pnpm quality:capture capture --label baseline --provider live --saved-provider "<provider-id>" --model-id "<exact-model-id>" --effort "<supported-effort>" --profile-dir "<other-configured-profile-root>" --extension-development-path "<clean-baseline-checkout>/src" --output "<new-other-baseline-output>" --samples 3
```

Repeat both captures with `--label candidate`, the clean candidate extension path, and new output directories.
The generic route uses credentials already configured in its dedicated Alpha profile; it cannot silently fall back to
another provider or model. Both captures verify the loaded build and source before and after execution. Keep the same
machine, host, runner, and provider conditions; provider-side caching remains uncontrolled and is recorded as such.

```sh
pnpm quality:compare --live-quality --baseline "<baseline-output>/run.json" --baseline "<other-baseline-output>/run.json" --candidate "<candidate-output>/run.json" --candidate "<other-candidate-output>/run.json" --output "<private-output>/comparison.json"
```

Live provider runs supplement deterministic checks and require their own credentials and run budget. Use three separate
absolute profile, workspace, and artifact paths outside this checkout and normal VS Code data. Profile and workspace
directories must initially be empty or absent. Initialize a dedicated profile after building the extension and runner:

```sh
pnpm bundle
pnpm --filter @alpha-code/vscode-webview build
pnpm --dir apps/vscode-e2e compile
node apps/vscode-e2e/out/runTest.js --provider live-copilot --vscode-version 1.141.0 --profile-dir "<absolute-profile-root>" --workspace "<absolute-workspace>" --artifacts-dir "<absolute-artifacts-root>" --init-profile --setup
```

Sign in inside the dedicated host. After discovery, repeat setup with the exact returned `--model-id` and a supported
`--reasoning-effort`, then finish the readiness check. Omit `--init-profile` after initialization and `--setup` when
running tests. Setup and model discovery do not prove that a task passed. Never copy credentials between profiles or
reset unrelated editor data. See the [runner options](apps/vscode-e2e/src/runTest.ts) for current flags.

Claude has dedicated deterministic and live suites on VS Code 1.141.0. After the build commands above, run the
mechanical fixture without credentials, then run the live suite with the exact Claude model ID returned by discovery:

```sh
pnpm test:claude:mechanical
pnpm test:claude:live --model-id "<exact-copilot-claude-model-id>" --reasoning-effort high --profile-dir "<absolute-profile-root>" --workspace "<absolute-workspace>" --artifacts-dir "<absolute-artifacts-root>"
```

Use a supported reasoning effort for the selected Claude model. Both commands require every selected test to execute;
the live suite uses the signed-in dedicated profile and retains the actual model, host, request counts, and task results.
An unavailable Claude model cannot fall back to another model or count as a live pass.

To test normal conversational requests for a different-model subagent and a new chat, set
`ALPHA_E2E_ROUTING_TARGET_MODEL_ID` to an exact discovered Copilot model with catalog support for `high` reasoning.
Choose a different parent model and reasoning level, then run:

```sh
pnpm --filter @alpha-code/vscode-e2e test:model-selection:live --model-id "<exact-parent-model-id>" --reasoning-effort max --profile-dir "<absolute-profile-root>" --workspace "<absolute-workspace>" --artifacts-dir "<absolute-artifacts-root>"
```

Each case permits at most 12 task requests and records the actual parent and child model IDs, sent reasoning levels,
and completion counts. Both models run live; missing target capabilities fail before the conversational test starts.

The live model matrix runs the same complete suite sequentially with **GPT 6 Luna / max**, **Claude Haiku 5.5 / high**,
then **Grok 4.6 / low**, exclusively on **VS Code 1.141.0**. It prepares the build and deterministic host gates once,
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
