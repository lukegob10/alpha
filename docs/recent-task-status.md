# Recent task status

Compact history rows use one fixed, right-aligned metadata slot. A task with live session metadata shows its status in
that slot instead of a timestamp; a saved task without live metadata shows its relative age. Removing live metadata
restores the age without changing the slot width. The same `TaskItem` serves the recent preview and expanded history.

| Live state          | Indicator                                                     |
| ------------------- | ------------------------------------------------------------- |
| Starting or running | Animated circle, static when reduced motion is requested      |
| Needs input         | Blue dot using the VS Code link foreground                    |
| Complete            | Green dot using the VS Code green chart color                 |
| Failed              | Circle with an exclamation mark using the VS Code error color |

Lifecycle determines whether the indicator spins. Late streaming or input flags cannot turn a waiting, completed, or
failed task back into a spinner. Existing idle, closing, and closed labels remain available. Full history cards retain
their timestamp footer while sharing the status labels and symbols. Status tooltips and accessible names use the
English history locale. This is a presentation change; lifecycle, session ownership, and persisted contracts are unchanged.

## Validation

```sh
pnpm --dir webview-ui test src/components/history/__tests__
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The task-row regressions cover the shared slot, restoration of timestamps, both display variants, and delayed flags
during transitions to Needs input, Complete, and Failed. Motion must also be checked against the built webview styles:
JSDOM cannot verify that a CSS animation advances.
