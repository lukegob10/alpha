# Alpha project configuration paths

Reviewed on 2026-10-01 against Codex CLI commit
[`b707714ae4200db0a0385da24b3981d99139fa62`](https://github.com/openai/codex/tree/b707714ae4200db0a0385da24b3981d99139fa62).
Codex configuration loading distinguishes user and project configuration and uses a project-owned `.codex` directory:
see `codex-rs/config/src/loader/mod.rs` and `config_layer_source.rs`. Alpha deliberately retains its extension-native
configuration formats and uses `.alpha` as its project folder. No Rust, Codex runtime, or sandbox implementation is imported.

## Owning contract

The existing `src/services/config-paths` module defines the canonical project directory and its compatibility readers.
Project MCP configuration is `.alpha/mcp.json`. `McpHub`, the project-settings editor, marketplace installation/removal,
and marketplace installation detection resolve this same path; the MCP watcher watches `.alpha/mcp.json`.

When the canonical MCP file is absent and `.roo/mcp.json` exists, Alpha preserves its bytes in an exclusive copy to
`.alpha/mcp.json`. The source remains intact. Repeated resolution preserves subsequent Alpha edits. If both files exist,
the Alpha file is authoritative, including an intentionally empty server map. `COPYFILE_EXCL` prevents overwriting a file
created concurrently. Unexpected I/O errors propagate rather than initializing an empty replacement. Opening project MCP
settings creates a default file with exclusive `wx` creation so an existing or concurrently created file is preserved.

New project slash commands and imported project mode rules are written under `.alpha`. Command listing and direct command
lookup give Alpha commands priority while retaining legacy commands with distinct names. Mode-rule checks and exports
prefer the Alpha rules directory and fall back to the existing `.roo` directory. Explicit mode replacement/deletion clears
both matching project rule directories to prevent legacy fallback from restoring removed instructions. Custom-tool
discovery through the runtime and settings refresh includes `.alpha/tools` after legacy project tools so the canonical
definition wins. Prompt rule discovery and skill discovery already support `.alpha` and retain their existing behavior.

The `.alphamodes` format, global configuration roots, shared `.agents` skills, protected-file policy, and persisted task
formats remain unchanged. Existing extension features continue through their existing managers and shared tool surface.

## Verification

The MCP watcher regression was run before implementation and failed because it watched `.roo/mcp.json` instead of
`.alpha/mcp.json`. Focused tests cover project MCP edit paths, first-use preservation, repeated resolution, canonical
precedence, concurrent file creation, I/O failures, project settings and command creation, command discovery precedence,
legacy mode-rule reads, rule replacement, marketplace paths, and custom-tool catalog discovery.

```sh
pnpm --dir src test services/config-paths services/mcp/__tests__/McpHub.spec.ts services/marketplace core/config/__tests__/CustomModesManager core/webview/__tests__/webviewMessageHandler.spec.ts services/command core/task/__tests__/tool-catalog-invalidation.spec.ts
```

Result: 17 test files passed; 360 tests passed and one existing test was skipped.

The parent integration task runs extension type checking and the exact VS Code 1.125.0 host gate after the combined
completion-loop and project-configuration changes are ready.
