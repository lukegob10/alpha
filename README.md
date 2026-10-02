<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=AlphaInc.alpha"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
</p>

# Alpha

> Your AI-Powered Dev Team, Right in Your Editor

## Welcome to Alpha v3.1.2

Alpha v3.1.2 keeps delegated work visible, prevents search loops, and makes active traces easier to follow.

- One TypeScript turn engine coordinates model steps, tool calls, approvals, and delegated work across supported providers
- Ask, Auto, and Full Access policies apply consistently to tool calls and child tasks
- Alpha Tickets stays available as an eager, integrated set of agent tools
- Completed work folds into a **Worked for** summary; expand it to inspect the full activity trace
- Review the whole turn or open a per-file diff in Alpha Diff, with added and removed line counts
- Automatic context compaction runs at safe boundaries when its configured threshold is reached
- Managed-agent tasks open only after launch and retain accurate terminal reasons when startup fails
- Repeated search-only steps trigger bounded evidence consolidation and concrete-action recovery
- Folded command and edit traces pulse subtly while work is still running, with reduced-motion support
- Plan tools, command outcomes, model prompts, and turn sequencing align more closely with Codex CLI
- The standalone Alpha CLI is retired; Alpha continues as a VS Code extension

---

## What Can Alpha Do For YOU?

- Generate Code from natural language descriptions and specs
- Keep day-to-day work focused with Plan and Code modes
- Refactor & Debug existing code
- Write & Update documentation
- Answer Questions about your codebase
- Automate repetitive tasks
- Run parallel task sessions so one agent can continue in the background while you start or inspect another
- Utilize MCP Servers

Developer note: the implementation and future swarm plan are documented in [Multi-Agent Concurrency Spec](docs/multi-agent-concurrency-spec.md).

Supported chat providers are GCP Vertex AI, VS Code LM API, Stellar, and OpenAI Compatible.
Code indexing uses GCP Vertex AI embeddings. See [provider compatibility and recovery](docs/provider-reduction.md)
for saved configurations that reference a removed provider.

## Modes

Alpha keeps the normal chat workflow focused:

- Plan Mode: plan systems, specs, and migrations
- Code Mode: everyday coding, investigation, debugging, orchestration, edits, and file operations

Press `Shift+Tab` while the chat composer is focused to switch between Plan and Code.

Existing custom-mode, Ask, Debug, and Orchestrator tasks and stored configurations remain compatible, but they are no longer offered in the normal mode selectors.

## Resources

- **[Project Docs](docs/):** Local technical documentation for Alpha internals and planned work.
- **[GitHub Issues](https://github.com/lukegob10/alpha/issues):** Report bugs, feature requests, and development questions.

---

## Local Setup & Development

### GitHub access

Alpha uses the GitHub CLI (`gh`) through its normal command tool. Install and authenticate `gh` in the environment
where the extension runs; see [GitHub CLI setup and compatibility](docs/github-cli.md). Command approvals and workspace
restrictions still apply.

### Release Automation

The stable workflow runs on `main` and publishes a verified VSIX GitHub release after the exact VS Code 1.125.0 host gate,
outside-path command checks, packaging, and source-asset verification. The V2 preview workflow runs on `main-v2`, creates
a GitHub prerelease, and does not publish to the VS Code Marketplace. Both workflows are defined in
[`.github/workflows`](.github/workflows/).

1. **Clone** the repo:

```sh
git clone https://github.com/lukegob10/alpha.git
```

2. **Install dependencies**:

```sh
pnpm install
```

The repository pins Node.js 24.14.1, npm 11.11.0, and pnpm 11.24.0. Use those versions for reproducible builds and
checks. pnpm remains the package manager; npm is pinned for bootstrap and CI tooling. The development runtime does not
change the extension's VS Code 1.125.0 compatibility contract.

3. **Run the extension**:

There are several ways to run the Alpha extension:

### Development Mode (F5)

For active development, use VSCode's built-in debugging:

Press `F5` (or go to **Run** → **Start Debugging**) in VSCode. This will open a new VSCode window with the Alpha extension running.

- Changes to the webview will appear immediately.
- Changes to the core extension rebuild automatically; restart the development host to load them.

If both Alpha Code and Alpha Tickets stay gray, select **Run Extension** in Run and Debug, then press `F5`. The
standard profile runs the development build with webview hot reload without attaching a breakpoint debugger. You can
also use **Run → Run Without Debugging** (`Ctrl+F5`). The optional **Run Extension (debugger)** profile is available
when debugger attachment is working.

The Windows VS Code 1.139.1 / bundled JavaScript Debugger 1.117.0 combination was observed on 2026-09-26 failing
before Alpha activation: the debugger reported `ECONNREFUSED ::1:<port>`, followed by the development host's
60-second ready-message timeout. The debugger's [extension-host attachment code](https://github.com/microsoft/vscode-js-debug/blob/main/src/targets/node/extensionHostAttacher.ts)
uses `localhost`, while the host inspector listens on IPv4 loopback. Running without the debugger avoids this
attachment failure; it does not change Alpha's VS Code 1.125.0 compatibility requirement.

### Core checks

The default checks cover the extension, webview, and VS Code E2E dependency graph:

```sh
pnpm lint
pnpm check-types
pnpm test
```

The release-host contract runs on VS Code 1.125.0:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

Optional retained workspace and evaluator checks are explicit:

```sh
pnpm lint:all
pnpm check-types:all
pnpm test:all
```

Use `pnpm test:evals` or `pnpm test:evals:offline` for the evaluator package. Evaluator runs execute the real Alpha
extension through VS Code; see [`packages/evals/README.md`](packages/evals/README.md) for their service prerequisites.

### Automated VSIX Installation

To build and install the extension as a VSIX package directly into VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

This command will:

- Ask which editor command to use (code/cursor/code-insiders) - defaults to 'code'
- Replace any installed copy of the same extension version with VS Code's `--force` install option.
- Build the latest VSIX package.
- Install the newly built VSIX.
- Prompt you to restart VS Code for changes to take effect.

Options:

- `-y`: Skip all confirmation prompts and use defaults
- `--editor=<command>`: Specify the editor command (e.g., `--editor=cursor` or `--editor=code-insiders`)

### Manual VSIX Installation

If you prefer to install the VSIX package manually:

1.  First, build the VSIX package:
    ```sh
    pnpm vsix
    ```
2.  A `.vsix` file will be generated in the `bin/` directory (e.g., `bin/alpha-<version>.vsix`).
3.  Install it manually using the VSCode CLI:
    ```sh
    code --install-extension bin/alpha-<version>.vsix
    ```

---

We use [changesets](https://github.com/changesets/changesets) for versioning and publishing. Check our `CHANGELOG.md` for release notes.

---

## Disclaimer

**Please note** that Alpha, Inc does **not** make any representations or warranties regarding any code, models, or other tools provided or made available in connection with Alpha, any associated third-party tools, or any resulting outputs. You assume **all risks** associated with the use of any such tools or outputs; such tools are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include, without limitation, intellectual property infringement, cyber vulnerabilities or attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or damage, and/or personal injury. You are solely responsible for your use of any such tools or outputs (including, without limitation, the legality, appropriateness, and results thereof).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the short issue-first contribution flow.

---

## License

[Apache 2.0 © 2025 Alpha, Inc.](./LICENSE)

---

**Enjoy Alpha!** Whether you keep it on a short leash or let it roam autonomously, we can’t wait to see what you build.
