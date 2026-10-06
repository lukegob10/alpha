# Agent hotkeys

Alpha exposes these actions as VS Code commands so a keyboard or programmable macro pad can use the same operations.
Bindings can be reassigned in **Preferences: Open Keyboard Shortcuts** by searching for the command ID.

| Action                  | Windows           | Command                         |
| ----------------------- | ----------------- | ------------------------------- |
| New task                | Ctrl+Alt+N        | `alpha.plusButtonClicked`       |
| Send and steer          | Ctrl+Alt+S        | `alpha.sendAndSteer`            |
| Reasoning minus         | Alt+,             | `alpha.decreaseReasoningEffort` |
| Reasoning plus          | Alt+.             | `alpha.increaseReasoningEffort` |
| Previous task           | Ctrl+Alt+PageUp   | `alpha.previousTask`            |
| Next task               | Ctrl+Alt+PageDown | `alpha.nextTask`                |
| Next task needing input | Ctrl+Alt+Home     | `alpha.nextTaskNeedingInput`    |

Default bindings are scoped to Windows. New task works outside Alpha and reveals its sidebar when necessary. Other
default bindings apply while Alpha's sidebar or editor panel has focus. The webview reports iframe focus through a
validated message, and the host publishes `alpha.focusedWebview` for VS Code's keybinding resolver. The sidebar's built-in
`focusedView` context does not follow focus into its webview overlay in VS Code 1.125.0. Sidebar bindings explicitly address
the sidebar provider; editor bindings use the focused visible editor provider. Late blur notifications cannot clear another
view's focus, and hidden or disposed views release it. Custom macro-pad bindings may invoke these commands directly; pass
`"sidebar"` as the command argument to target the sidebar explicitly. Ordinary Enter submission and the existing Shift+Tab
Plan/Code control retain their current behavior.

Send and steer submits a nonempty, visible composer draft through `Task.steerUserMessageDurably` with a stable receipt ID.
Input is durably queued before the current turn is interrupted. A rejected admission preserves the draft. If an approval or
other boundary prevents the handoff after admission, the accepted message remains queued and the composer reports that
outcome. At an idle or waiting-input boundary, the command uses ordinary message submission. It never activates an
approval button merely because the draft is empty. Managed-child chats continue to use their parent's steering controls.

Reasoning keys advance the selected task's acknowledged next-step choice through only its supported levels, without
wrapping at the endpoints. Binary models use on/off; budget-only, custom-token, and unavailable controls do not change.
The configuration queue serializes rapid presses. In-flight requests and retries retain their captured settings. A blank
composer changes the preference for new tasks; changing an existing task does not rewrite its saved provider profile.

Task navigation cycles in runtime registration order, including registered completed tasks, and excludes managed
subagents and aborted/abandoned tasks. It selects a task through the existing provider navigation path, preserves each
task's composer draft, and leaves other tasks and other views' selections running independently. Next needing input
filters the existing lifecycle projection for input or approval waits; completion reviews are skipped. With no eligible
task, selection remains unchanged.

## Reference behavior and compatibility

Reviewed Codex CLI commit `d63a9b8344cfe58bc78bbe319b560378fc8756ef` on October 5, 2026:

- [Keymap](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/tui/src/keymap.rs):
  distinct reasoning decrease/increase actions and distinct composer submit/queue actions.
- [Composer tests](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/tui/src/bottom_pane/chat_composer.rs):
  separate submitted and queued outcomes with draft retirement after submission.

Alpha intentionally keeps Enter as its existing send/queue action and adds an explicit steering command. VS Code task
navigation uses Alpha's shared session registry rather than the CLI's terminal navigation. No execution policy or
approval authority changes.

The implementation uses stable command, webview messaging, and keybinding contracts for VS Code **1.125.0**. Consulted
[VS Code keybindings](https://code.visualstudio.com/docs/configure/keybindings) and
[contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.keybindings) on
October 5, 2026, and [when-clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts) and
[webview messaging](https://code.visualstudio.com/api/extension-guides/webview#passing-messages-from-a-webview-to-an-extension)
on October 6, 2026. Reproduced the failed Alt+Period dispatch using trusted keyboard input in the exact Windows 1.125.0
host, and inspected that host's sidebar overlay and key forwarding code. Validate with focused command, reasoning,
registry, focus, message-handler, and composer tests, package and consumer typechecks, then
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`. The rendered reasoning fixture additionally tests trusted keypresses
with `pnpm --filter @alpha-code/vscode-e2e test:reasoning:1250`.

The Windows fixture presses reasoning minus/plus inside both composers and navigates both views. Its sidebar stages also
verify that Enter retains input without interrupting a held HTTP request, steering cancels that request and delivers both
queued and steered input, next-needing-input selects an unresolved approval, and new task preserves existing work. Host
assertions independently verify task IDs and model request payloads, while the renderer records focus and screenshots.
