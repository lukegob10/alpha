import { useMemo } from "react"
import { ArrowUpRight, Square } from "lucide-react"
import { useTranslation } from "react-i18next"

import { TaskLifecycleState, type HistoryItem, type LiveTaskMetadata } from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

interface CrossTaskPanelProps {
	parentTaskId: string
	taskHistory: HistoryItem[]
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
	onOpen: (taskId: string) => void
}

type CrossTaskRow = {
	id: string
	objective: string
	workspaceMode: "shared" | "worktree"
	lifecycle: TaskLifecycleState
}

const lifecycleFromHistory = (item: HistoryItem): TaskLifecycleState => {
	switch (item.status) {
		case "completed":
			return TaskLifecycleState.Completed
		case "failed":
			return TaskLifecycleState.Failed
		case "cancelled":
		case "timed_out":
		case "interrupted":
			return TaskLifecycleState.Closed
		case "active":
			return TaskLifecycleState.Running
		default:
			return TaskLifecycleState.Waiting
	}
}

const lifecycleLabel = (lifecycle: TaskLifecycleState, t: (key: string) => string): string => {
	switch (lifecycle) {
		case TaskLifecycleState.Initializing:
			return t("crossTasks.status.starting")
		case TaskLifecycleState.Running:
			return t("crossTasks.status.running")
		case TaskLifecycleState.Waiting:
			return t("crossTasks.status.waiting")
		case TaskLifecycleState.Completed:
			return t("crossTasks.status.completed")
		case TaskLifecycleState.Failed:
			return t("crossTasks.status.failed")
		case TaskLifecycleState.Closing:
			return t("crossTasks.status.stopping")
		case TaskLifecycleState.Closed:
			return t("crossTasks.status.stopped")
	}
}

const isTerminal = (lifecycle: TaskLifecycleState): boolean =>
	lifecycle === TaskLifecycleState.Completed ||
	lifecycle === TaskLifecycleState.Failed ||
	lifecycle === TaskLifecycleState.Closed

export function CrossTaskPanel({ parentTaskId, taskHistory, liveTasksById, onOpen }: CrossTaskPanelProps) {
	const { t } = useTranslation("chat")
	const tasks = useMemo(() => {
		const rows = new Map<string, CrossTaskRow>()
		for (const item of taskHistory) {
			if (item.orchestrationParentTaskId !== parentTaskId || item.taskKind === "subagent") continue
			const live = liveTasksById?.[item.id]
			rows.set(item.id, {
				id: item.id,
				objective: item.task,
				workspaceMode: live?.orchestrationWorkspaceMode ?? item.orchestrationWorkspaceMode ?? "shared",
				lifecycle: live?.lifecycle ?? lifecycleFromHistory(item),
			})
		}
		for (const live of Object.values(liveTasksById ?? {})) {
			if (live.orchestrationParentTaskId !== parentTaskId || rows.has(live.id)) continue
			rows.set(live.id, {
				id: live.id,
				objective: live.orchestrationObjective || t("crossTasks.untitled"),
				workspaceMode: live.orchestrationWorkspaceMode ?? "shared",
				lifecycle: live.lifecycle,
			})
		}
		// Independent task IDs are UUIDv7, so their order stays stable as live timestamps change.
		return Array.from(rows.values()).sort((left, right) => left.id.localeCompare(right.id))
	}, [liveTasksById, parentTaskId, t, taskHistory])

	if (tasks.length === 0) return null

	return (
		<nav aria-label={t("crossTasks.title")} className="mx-3 mb-2 flex min-w-0 items-center gap-2 text-xs">
			<span className="shrink-0 text-vscode-descriptionForeground">{t("crossTasks.title")}</span>
			<ul className="flex min-w-0 items-center gap-1 overflow-x-auto">
				{tasks.map((task, index) => {
					const terminal = isTerminal(task.lifecycle)
					const threadLabel = `${t("crossTasks.thread")} ${index + 2}`
					return (
						<li key={task.id} className="flex shrink-0 items-center gap-0.5">
							<button
								type="button"
								aria-label={t("crossTasks.openTask", {
									thread: threadLabel,
									objective: task.objective,
								})}
								title={`${task.objective} · ${t(`crossTasks.workspace.${task.workspaceMode}`)} · ${lifecycleLabel(task.lifecycle, t)}`}
								onClick={() => onOpen(task.id)}
								className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-vscode-foreground hover:bg-[var(--alpha-accent-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
								<span
									className={`size-1.5 shrink-0 rounded-full ${
										task.lifecycle === TaskLifecycleState.Completed
											? "bg-vscode-testing-iconPassed"
											: task.lifecycle === TaskLifecycleState.Failed
												? "bg-vscode-testing-iconFailed"
												: task.lifecycle === TaskLifecycleState.Waiting
													? "bg-vscode-editorWarning-foreground"
													: terminal
														? "bg-vscode-descriptionForeground"
														: "animate-pulse bg-vscode-progressBar-background"
									}`}
									aria-hidden="true"
								/>
								<span>{threadLabel}</span>
								<ArrowUpRight className="size-3 shrink-0 opacity-50" aria-hidden="true" />
							</button>
							{!terminal && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={t("crossTasks.stopTask", { objective: task.objective })}
									title={t("crossTasks.stop")}
									onClick={() =>
										vscode.postMessage({
											type: "stopIndependentTask",
											parentTaskId,
											taskId: task.id,
										})
									}
									className="size-6 text-vscode-descriptionForeground hover:text-vscode-errorForeground">
									<Square className="size-3" aria-hidden="true" />
								</Button>
							)}
						</li>
					)
				})}
			</ul>
		</nav>
	)
}
