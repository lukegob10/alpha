# Alpha Code

Alpha is a VS Code extension for planning, coding, debugging, and reviewing work with AI.

## Install

Download the Windows x64 `.vsix` for Intel/AMD PCs from [GitHub Releases](https://github.com/lukegob10/alpha/releases/latest),
then run **Extensions: Install from VSIX...** in VS Code **1.125.0** or newer.
The exact development and release reference host is VS Code **1.138.0**; it does not raise the installation minimum.

## Work in Alpha

- Plan systems and changes in **Plan**, then implement, investigate, and debug in **Code**. Press `Shift+Tab` in the
  chat composer to switch modes.
- Search and edit files, run commands, and inspect whole-turn or per-file diffs in Alpha Diff.
- Keep concurrent task sessions and delegate bounded work to managed agents while other sessions run in the background.
- Use built-in skills, Alpha Tickets, the [HTML document previewer](docs/html-documents.md), and
  [scheduled tasks](docs/scheduled-tasks.md).
- Connect MCP servers and use automatic context compaction for longer tasks.

Choose **Ask**, **Auto**, or **Full Access** for tool approval behavior. Read the
[approval policy](docs/approval-mode-policy.md) and [command and workspace protections](docs/command-sandbox.md) before
granting broader access. Provider selection does not change the approval policy or workspace protections.

Supported chat providers are GCP Vertex AI, VS Code LM API, Stellar, and OpenAI Compatible.
Code indexing supports GCP Vertex AI and Gemini Developer API embeddings. See
[provider recovery](docs/provider-reduction.md) for removed-provider configurations and
[mode compatibility](docs/mode-retirement.md) for retired saved modes, which resume in Plan.

Alpha uses the GitHub CLI (`gh`) through its command tool. Install and authenticate it where the extension runs;
[GitHub CLI setup](docs/github-cli.md) describes the workflow and approval boundary.

The standalone Alpha CLI is retired. Development and evaluation commands run the real extension;
[CLI compatibility](docs/cli-retirement.md) covers saved evaluation data.

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

## Validate

Start with the focused tests and owning typecheck in the [validation matrix](AGENTS.md#validation-matrix).
The [testing workflow](docs/testing-harness.md) documents prerequisites, additional lanes, and evaluator setup.
Common extension checks use the same harness as CI:

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

See the [host compatibility contract](docs/vscode-1.138-migration.md) and
[live-profile guide](docs/vscode-live-test-profiles.md). Live provider runs supplement deterministic checks and require
their own credentials and run budget. Offline evaluator checks use `pnpm test:evals:offline`; the
[evaluator guide](packages/evals/README.md) covers service-backed checks and fixture authoring.

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

The [release workflow](.github/workflows/release-vsix.yml) publishes verified Windows x64 packages to GitHub Releases
after its validation gates. It runs automatically for `src/package.json` changes on `main` and supports manual dispatch
on a selected release branch. It does not publish to the VS Code Marketplace. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Resources and contributions

- [Project documentation](docs/README.md): compatibility, safety, recovery, and operating guides.
- [Evaluation inputs](evals/README.md): suites, fixtures, measurement contracts, and historical evidence.
- [GitHub Issues](https://github.com/lukegob10/alpha/issues): bugs, feature requests, and development questions.

Open an issue before starting a substantial contribution and follow [AGENTS.md](AGENTS.md).
For intended agent behavior, compare current [Codex CLI source and tests](https://github.com/openai/codex) as required by
the engineering guide; keep Alpha's own approval and workspace protections.

## Disclaimer

**Please note** that Alpha, Inc does **not** make any representations or warranties regarding any code, models, or other tools provided or made available in connection with Alpha, any associated third-party tools, or any resulting outputs. You assume **all risks** associated with the use of any such tools or outputs; such tools are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include, without limitation, intellectual property infringement, cyber vulnerabilities or attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or damage, and/or personal injury. You are solely responsible for your use of any such tools or outputs (including, without limitation, the legality, appropriateness, and results thereof).

## License

[Apache 2.0 © 2025 Alpha, Inc.](./LICENSE)
