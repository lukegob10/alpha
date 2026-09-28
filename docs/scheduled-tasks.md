# Scheduled task scope and ownership

Alpha stores scheduled task records in the VS Code profile's storage directory, including any configured custom storage path. Each record is assigned to an exact open workspace folder. The Scheduled Tasks view projects only records for folders open in that window. A window with no workspace folder cannot create or run a schedule.

Every extension host has a scheduler timer. Before a due occurrence runs, the host reloads the shared task and run files under a cross-process transaction lock. It writes the run record before advancing the schedule. A concurrently running second window sees the advanced schedule and does not launch the same due occurrence. Updates also reload under the lock so an older window snapshot cannot discard another window's changes. File changes refresh other windows' views, with the periodic tick as a fallback.

Active runs record their owning extension host. A live owner's lease prevents another window from treating its run as interrupted. An orphaned run is marked failed after the lease expires, at the next initialization or tick. An occurrence less than one normal tick interval overdue at startup remains due; older occurrences retain the existing missed-run behavior.

Older saved schedules without a workspace remain visible for reassignment. They do not run until the user opens the intended repository and saves the schedule there. Existing files and run history are retained.

Separate VS Code profiles or user-data directories have separate schedule stores and do not coordinate runs. If the same logical schedule is created independently in both profiles, each profile runs its own copy. Windows sharing one custom storage path coordinate through that path. Mixed Alpha versions are not a supported cross-window coordination contract; every window using a shared store should use this version or newer.

Focused validation:

```sh
pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskStore.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts
pnpm --dir webview-ui test src/components/scheduled-tasks/__tests__/ScheduledTasksView.spec.tsx
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```
