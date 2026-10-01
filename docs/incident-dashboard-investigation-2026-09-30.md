# Dashboard overview and source-task investigations

The dashboard now shows activity from a rolling 24-hour window, preserving the existing caps of 12 tasks, 12 alerts,
and 64 turns. A turn is recent when its last observed event is inside that window, including turns that started earlier.
Filtering is presentation-only: persisted history and retained turn details are not deleted. History hydration skips old
inactive tasks before reading their journals. Counts describe the bounded snapshot, not all historical activity.

The overview retains the turn table and outcome totals. Attention items occupy a full-width panel; technical alert
references and per-task timelines require explicit expansion. Chat titles come from the existing history task label,
normalized to a single line and capped at 200 characters, and are rendered as text. The optional `chatTitle` wire field
keeps old anonymous snapshots readable. Titles are added at the local webview adapter; lifecycle projections and exported
diagnostic evidence remain content-free. A longer-term trend chart is deferred pending an explicit aggregation contract.

## Investigation root cause and change

Previously, both launch paths created Plan tasks with `diagnosticSession: true`. That immutable flag limits their tools
to the redacted evidence reader, even after a user switches to Code. Launch prompts also prohibited looking beyond hashed
summary references. Consequently, the model could describe lifecycle facts without reading the actual request or trace.

New launches create ordinary Code tasks and persist the source-task association. Their prompts identify the validated
source storage directory, UI conversation, canonical/legacy provider transcript, and lifecycle journals. They explicitly
request inspection before conclusions, bounded reads, and correlation with the selected turn. File/command access uses
the existing tools, workspace rules, and approval policy; no allowlist or security gate is widened. Outside-workspace
storage reads may require the normal approval. A prompt is guidance, not a guarantee of model compliance.

New investigation identities use `investigate:` so existing constrained diagnostic chats are not silently promoted.
Duplicate launches and reopening use the new identities. Both old diagnostics and new investigations are excluded from
dashboard activity, including persistence/resync alerts, to avoid self-generated incident loops. Source files are not
copied into the launch prompt or modified by the launcher. Existing diagnostic reader behavior remains available to old
sessions.

## Reference

Inspected Codex CLI commit `33aea33b39a5e35c78de75c332106479b16c6994` on 2026-09-30:

- [Plan collaboration template](https://github.com/openai/codex/blob/33aea33b39a5e35c78de75c332106479b16c6994/codex-rs/collaboration-mode-templates/templates/plan.md)
  permits non-mutating exploration and requires grounding in actual files before planning.
- [Collaboration instruction tests](https://github.com/openai/codex/blob/33aea33b39a5e35c78de75c332106479b16c6994/codex-rs/core/tests/suite/collaboration_instructions.rs)
  exercise host-selected collaboration settings and instruction delivery.

Alpha's incident dashboard is an extension-specific capability. Starting the user-requested investigation in Code is a
host action; it does not add a model-controlled mode switch. The native TypeScript runtime and approval boundaries stay
in place.

## Validation

- Focused extension tests: 27 passed across the incident monitor, launch/hydration adapters, and panel.
- Dashboard interaction tests: 10 passed; shared dashboard schema tests: 3 passed.
- Extension, webview, and shared-types checks passed. Extension bundle and production webview build passed.
- All 12 suites in the VS Code 1.122.1 smoke gate passed. The initial host launch inherited
  `ELECTRON_RUN_AS_NODE=1` from Windows and failed before preflight; clearing that variable for the host-only rerun
  resolved the environment issue. The exact-host version was retained.
- Inspected a rendered browser preview with representative named chats and an alert. This was a presentation preview,
  not a live-model investigation or manual interaction with the dashboard inside VS Code. Removed repeated section
  labels after preview and reran the dashboard interaction tests and webview typecheck.

Commands: `pnpm --dir src test core/agent/__tests__/AgentIncidentMonitor.spec.ts
core/webview/__tests__/AlphaProvider.incident-debugging.spec.ts
core/webview/__tests__/AlphaProvider.incident-dashboard-loading.spec.ts core/webview/__tests__/IncidentPanel.spec.ts`,
`pnpm --dir webview-ui test src/components/incidents/__tests__/IncidentsView.spec.tsx`,
`pnpm --filter @alpha-code/types test src/__tests__/incident-dashboard.test.ts`, the three package `check-types` scripts,
and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` followed by `test:smoke:1221:run` with the corrected environment.

## Project labels

Dashboard tasks and turns also carry the optional saved `HistoryItem.workspace` path (bounded to 4096 characters).
The UI displays its final folder component as the project name in the table, attention cards, task cards, and selected
turn details. Both slash styles and trailing separators are handled independently of the current OS. The unchanged full
path is available on hover to distinguish projects with the same folder name. Missing historical workspace information
is shown as “Not recorded”; it is never replaced with the currently open workspace. This is presentation metadata and
does not change path permissions or export full paths into the incident monitor's redacted evidence.
