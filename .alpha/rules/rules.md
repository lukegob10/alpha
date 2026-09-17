# Code Quality Rules

1. Test Coverage:

    - Before attempting completion, always make sure that any code changes have test coverage
    - Ensure all tests pass before submitting changes
    - The vitest framework is used for testing; the `vi`, `describe`, `test`, `it`, etc functions are defined by default in `tsconfig.json` and therefore don't need to be imported from `vitest`
    - Use the repository package manager and workspace scripts rather than invoking `npx`:
        - Default extension checks: `pnpm test`
        - Backend tests: `pnpm --dir src test -- path/to/test-file` (don't include `src/` in the path)
        - UI tests: `pnpm --dir webview-ui test -- src/path/to/test-file`
        - VS Code E2E unit tests: `pnpm --filter @alpha-code/vscode-e2e test:unit`
    - Run focused tests from the owning workspace so its dependencies and configuration are loaded.

2. Lint Rules:

    - Never disable any lint rules without explicit user approval

3. Styling Guidelines:

    - Use Tailwind CSS classes instead of inline style objects for new markup
    - VSCode CSS variables must be added to webview-ui/src/index.css before using them in Tailwind classes
    - Example: `<div className="text-md text-vscode-descriptionForeground mb-2" />` instead of style objects
