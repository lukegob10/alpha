# Activity edge tracer

The collapsed activity indicator uses the selected Edge Tracer design: a quiet theme-colored surface with a thin accent
traveling around its border every 4.5 seconds. Expanded and inactive indicators stop animating. Completed traces are idle
even if an older caller supplies `active: true`. Reduced motion retains a static border accent; forced colors use a static
system highlight. The implementation uses CSS rather than introducing an animation timer or another task-state source.

`ActivityTraceToggle` retains the existing Working, Running commands, Editing files, and Worked for labels and counts.
`ActivityStep` applies the same border treatment to active collapsed reasoning details. Both continue to project the
existing task lifecycle. Task history, provider data, tool policy, and expansion preferences keep their existing contracts.

Thinking and API request headers share a 14px disclosure column, an 8px gap, a fixed 16px icon, and an 8px gap before the
label. API request and pacing rows reserve the disclosure space even though they do not have a disclosure control. This
fixes the previous 20px label offset. Reasoning icons and elapsed time are vertically centered without a manual offset.

## References

Inspected on October 12, 2026: Codex CLI main commit `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458`,
[`status_indicator_widget.rs`](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/status_indicator_widget.rs)
and its inline tests. Codex uses Working for general activity and honors motion preferences. Alpha deliberately retains
inline expandable activity groups and uses the user-selected border animation in its VS Code presentation.

CSS contracts checked on the same date:
[`@property`](https://drafts.css-houdini.org/css-properties-values-api/#at-property-rule) and
[`mask-composite`](https://drafts.csswg.org/css-masking-1/#the-mask-composite). Unsupported mask composition has a static
border fallback. No proposed VS Code API is required.

## Validation

Focused webview tests cover expansion, completed-state activity, and unchanged reasoning behavior. The existing rendered
reasoning fixture adds activity checks on exact VS Code 1.125.0 for dark, light, and high-contrast themes: changing border
angle, no glow shadow, reduced motion, keyboard disclosure, detail-row alignment at widths up to 320px, and cancellation.

```sh
pnpm --dir webview-ui test src/components/chat/__tests__/ActivityTraceToggle.spec.tsx src/components/chat/__tests__/ActivityStep.spec.tsx src/components/chat/__tests__/ReasoningBlock.spec.tsx src/components/chat/__tests__/ChatRow.activity.spec.tsx src/components/chat/__tests__/ChatRow.rate-limit-wait.spec.tsx src/components/chat/__tests__/ChatView.spec.tsx
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e test:reasoning:1250
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The rendered fixture writes `ui-activity-edge*-alignment.json` and collapsed, expanded, reduced-motion, and stopped
screenshots alongside its existing reasoning evidence.

Recorded on October 13, 2026: 221 focused webview tests passed, both affected type checks and touched-file lint passed,
and the exact 1.125.0 smoke gate passed. The rendered UI run `ui-67b72bc8-d448-4c26-97ed-813402e975d6` passed all activity
stages using a local scripted HTTP provider and an isolated Alpha-owned profile. At the host's 299px sidebar width, both
labels started at x=71 and both icons at x=47 in all three themes, with no overflow. Screenshots were visually reviewed.
