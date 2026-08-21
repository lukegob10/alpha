# Changelog

## 2.1.0

### Minor Changes

- Add managed subagent lifecycle control, nested delegation, follow-up delivery, recovery, and monitoring UX.

## 2.0.7

### Patch Changes

- Eliminate end-of-chat scroll bouncing by converging bottom detection and correction on the physical scroller boundary.
- Preserve deliberate history browsing during late row measurement and nested code-block scrolling.

## 2.0.6

### Patch Changes

- Keep transcript wheel scrolling active when the pointer is over the floating bottom-navigation controls.
- Replace the full-width bottom-navigation bar with compact controls that no longer obscure completed-task output.

## 2.0.5

### Patch Changes

- Make the virtualized list the single owner of appended-message and viewport-resize following, and route streamed row growth through its built-in bottom-follow path.
- Add a 32px physical gap between the transcript scrollbar and composer while preserving the existing space below the newest message.

## 2.0.4

### Patch Changes

- Fix virtualized long chats opening away from the newest message and preserve the transcript viewport when recovery controls appear.
- Keep bottom-following stable while late Markdown, image, and row-height measurements settle without interrupting manual history browsing.

## 2.0.3

### Patch Changes

- Stabilize long-chat bottom following by coalescing streamed row-growth corrections into a single exact-bottom scroll.
- Add comfortable space beneath the latest response while preserving manual history browsing.

## 1.1.6

### Patch Changes

- [codex] Fix completed parallel task follow-up routing and refresh skill discovery from `.agents/skills`.

## 1.1.5

### Patch Changes

- [codex] Fix extension command auto-approval settings.
- [codex] Clean up GitHub Copilot Claude model handling, including Opus 4.7 reasoning support and duplicate picker entries.

## 1.1.2

### Patch Changes

- [codex] Package and publish the Alpha VSIX release for v1.1.2.

## 1.1.1

### Patch Changes

- [codex] Fix task lane mode and provider isolation when switching modes from tools or slash commands
- [codex] Ensure delegated child tasks use the provider profile mapped to the child mode
- [codex] Keep focused lane state aligned with that lane's provider settings

## 1.1.0

### Minor Changes

- [codex] Fix corporate gateway native tool event handling for orchestrator and mode delegation
- [codex] Ensure gateway streamed tool calls complete before task recovery logic runs

## 1.0.9

### Patch Changes

- [codex] Reissue the orchestrator native tool delegation fix from merged `main`
- [codex] Preserve streamed `new_task` arguments so orchestrator can create mode-specific subtasks

## 1.0.6

### Patch Changes

- [codex] Fix Orchestrator delegation recovery for mode-specific subtasks

## 1.0.5

### Patch Changes

- [codex] Fix orchestration delegation recovery loops
- Add scheduled task agents

## 1.0.4

### Patch Changes

- [codex] Fix release workflow automation

All notable changes to Alpha will be documented in this file starting from the Alpha rebrand baseline.

## Unreleased

- Reset release history for the Alpha-branded codebase.
- Removed the legacy marketing website app from the monorepo.
- Renamed internal packages to the `@alpha-code/*` scope.
- Renamed the CLI binary to `alpha`.
