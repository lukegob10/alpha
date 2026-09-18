<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=AlphaInc.alpha"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
</p>

# Alpha

> Your AI-Powered Dev Team, Right in Your Editor

## Welcome to Alpha v2.1.48

Alpha v2.1.48 keeps automatic compaction within the configured resume budget and lets the model recover from stale or out-of-range file-read selections without turning them into task-level errors.

- One-million-token contexts at 30–35% compaction profiles now finish within the configured resume budget

- Invalid file offsets return actionable tool feedback so the model can correct the read and continue

- Rewording a check or reordering its unchanged input files preserves passing evidence so finished tasks can complete

- Vertex Gemini Embedding 2 requests use the model's `:embedContent` endpoint while Gemini 001 keeps its existing contract

- Optional acceptance checks reuse passing evidence while their declared inputs remain unchanged
- Tasks can wait for, send input to, and stop their own background commands under existing approval rules
- Saved task context retains constraints and skill identities across reload and compaction
- Chat includes improved edit and restart actions, reasoning summaries, and provider selection after completion
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

### Release Automation

The stable workflow runs on `main` and publishes a verified VSIX GitHub release after the exact VS Code 1.122.1 host gate,
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

The repository pins Node.js 20.19.2 and pnpm 10.8.1. Use those versions for reproducible builds and checks.

3. **Run the extension**:

There are several ways to run the Alpha extension:

### Development Mode (F5)

For active development, use VSCode's built-in debugging:

Press `F5` (or go to **Run** → **Start Debugging**) in VSCode. This will open a new VSCode window with the Alpha extension running.

- Changes to the webview will appear immediately.
- Changes to the core extension will also hot reload automatically.

### Core checks

The default checks cover the extension, webview, and VS Code E2E dependency graph:

```sh
pnpm lint
pnpm check-types
pnpm test
```

The release-host contract runs on VS Code 1.122.1:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
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
