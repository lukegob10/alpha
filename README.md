<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=AlphaInc.alpha"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
</p>

# Alpha

> Your AI-Powered Dev Team, Right in Your Editor

## Welcome to Alpha v2.1.3 Preview

Alpha v2.1.3 focuses everyday agent work on a clean Plan and Code workflow without changing the proven Code loop.

- Plan and Code are the only ordinary user-facing mode choices
- `Shift+Tab` switches modes while the chat composer is focused
- Code and Plan stay in the same task and provider configuration
- Existing legacy and custom-mode tasks remain compatible without cluttering new work

<details>
  <summary>🌐 Available languages</summary>

- [English](README.md)
- [Català](locales/ca/README.md)
- [Deutsch](locales/de/README.md)
- [Español](locales/es/README.md)
- [Français](locales/fr/README.md)
- [हिंदी](locales/hi/README.md)
- [Bahasa Indonesia](locales/id/README.md)
- [Italiano](locales/it/README.md)
- [日本語](locales/ja/README.md)
- [한국어](locales/ko/README.md)
- [Nederlands](locales/nl/README.md)
- [Polski](locales/pl/README.md)
- [Português (BR)](locales/pt-BR/README.md)
- [Русский](locales/ru/README.md)
- [Türkçe](locales/tr/README.md)
- [Tiếng Việt](locales/vi/README.md)
- [简体中文](locales/zh-CN/README.md)
- [繁體中文](locales/zh-TW/README.md)
- ...

</details>

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
- **[GitHub Issues](https://github.com/AlphaInc/Alpha/issues):** Report bugs and track development.
- **[Feature Requests](https://github.com/AlphaInc/Alpha/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Have an idea? Share it with the developers.

---

## Local Setup & Development

### Release Automation

Pull requests now produce a VSIX artifact automatically in GitHub Actions, so reviewers can download the packaged extension from the PR workflow run instead of building or uploading one by hand.

When a PR is merged into `main`, the release workflow creates a version bump PR. If the merged PR does not include a changeset, the workflow generates a patch changeset by default. Add a `v2` or `release:v2` label, or put `[v2]` or `release: v2` in the PR title, when the release should be a major version bump instead.

1. **Clone** the repo:

```sh
git clone https://github.com/AlphaInc/Alpha.git
```

2. **Install dependencies**:

```sh
pnpm install
```

3. **Run the extension**:

There are several ways to run the Alpha extension:

### Development Mode (F5)

For active development, use VSCode's built-in debugging:

Press `F5` (or go to **Run** → **Start Debugging**) in VSCode. This will open a new VSCode window with the Alpha extension running.

- Changes to the webview will appear immediately.
- Changes to the core extension will also hot reload automatically.

### Automated VSIX Installation

To build and install the extension as a VSIX package directly into VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

This command will:

- Ask which editor command to use (code/cursor/code-insiders) - defaults to 'code'
- Uninstall any existing version of the extension.
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
