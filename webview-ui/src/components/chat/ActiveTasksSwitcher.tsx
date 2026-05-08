import React from "react"
import { Bell, CircleDot, GitBranch, Minimize2, PauseCircle, PlayCircle, X } from "lucide-react"

import type { LiveTaskSummary, TaskRuntimeStatus } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

const statusIcon: Record<TaskRuntimeStatus, React.ReactNode> = {
	queued: <PauseCircle className="size-3.5" />,
	running: <PlayCircle className="size-3.5" />,
	interactive: <Bell className="size-3.5" />,
	resumable: <CircleDot className="size-3.5" />,
	idle: <CircleDot className="size-3.5" />,
	completed: <CircleDot className="size-3.5" />,
	aborted: <X className="size-3.5" />,
}

const statusLabel: Record<TaskRuntimeStatus, string> = {
	queued: "Queued",
	running: "Running",
	interactive: "Needs input",
	resumable: "Resumable",
	idle: "Idle",
	completed: "Done",
	aborted: "Aborted",
}

const currency = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 4,
})

const compact = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
})

function basename(value?: string) {
	if (!value) {
		return "workspace"
	}

	const normalized = value.replace(/\/+$/, "")
	return normalized.split("/").pop() || normalized
}

function costSummary(task: LiveTaskSummary) {
	const parts: string[] = []

	if ((task.tokensIn ?? 0) + (task.tokensOut ?? 0) > 0) {
		parts.push(`${compact.format((task.tokensIn ?? 0) + (task.tokensOut ?? 0))} tok`)
	}

	if (typeof task.totalCost === "number") {
		parts.push(currency.format(task.totalCost))
	}

	return parts.join(" / ")
}

export function ActiveTasksSwitcher({
	liveTasks,
	focusedTaskId,
}: {
	liveTasks: LiveTaskSummary[]
	focusedTaskId?: string
}) {
	if (liveTasks.length === 0) {
		return null
	}

	const isTaskFocused = (task: LiveTaskSummary) =>
		task.id === focusedTaskId || task.currentTaskId === focusedTaskId || task.isFocused
	const focusedTask = liveTasks.find(isTaskFocused)
	const focusOrDockTask = (task: LiveTaskSummary) => {
		vscode.postMessage({
			type: isTaskFocused(task) ? "dockTask" : "focusTask",
			taskId: task.currentTaskId,
		})
	}

	return (
		<div className="border-b border-border bg-vscode-sideBar-background px-2 py-1.5">
			<div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-vscode-descriptionForeground">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="font-medium text-vscode-foreground">Active Tasks</span>
					<span className="rounded border border-border px-1 leading-4">{liveTasks.length}</span>
				</div>
				{focusedTask && (
					<button
						type="button"
						title="Return current task to pool"
						aria-label="Return current task to pool"
						className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-vscode-toolbar-hoverBackground"
						onClick={() => vscode.postMessage({ type: "dockTask", taskId: focusedTask.currentTaskId })}>
						<Minimize2 className="size-3.5" />
						<span>Return</span>
					</button>
				)}
			</div>
			<div className="flex gap-1.5 overflow-x-auto pb-0.5">
				{liveTasks.map((task) => {
					const isFocused = isTaskFocused(task)
					const summary = costSummary(task)

					return (
						<div
							key={task.id}
							role="button"
							tabIndex={0}
							aria-label={`${isFocused ? "Return to pool" : "Focus task"} ${task.title}`}
							title={isFocused ? "Return to task pool" : "Focus task"}
							onClick={() => focusOrDockTask(task)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault()
									focusOrDockTask(task)
								}
							}}
							className={`min-w-[220px] max-w-[320px] shrink-0 rounded border px-2 py-1.5 text-xs ${
								isFocused
									? "border-vscode-focusBorder bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
									: "border-border bg-vscode-editor-background text-vscode-foreground"
							}`}>
							<div className="flex items-start gap-2">
								<div className="mt-0.5 shrink-0" title={statusLabel[task.status]}>
									{statusIcon[task.status]}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<div className="truncate font-medium" title={task.title}>
											{task.title}
										</div>
										{task.unreadCount > 0 && (
											<span className="shrink-0 rounded bg-vscode-badge-background px-1 text-[10px] leading-4 text-vscode-badge-foreground">
												{task.unreadCount}
											</span>
										)}
										{task.queueSize > 0 && (
											<span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4">
												Q {task.queueSize}
											</span>
										)}
									</div>
									<div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] opacity-80">
										<span className="shrink-0">{statusLabel[task.status]}</span>
										<span className="truncate">
											{task.isolation.mode === "worktree" ? (
												<span className="inline-flex items-center gap-1">
													<GitBranch className="size-3" />
													{basename(task.workspacePath)}
												</span>
											) : (
												basename(task.workspacePath)
											)}
										</span>
									</div>
									{summary && <div className="mt-1 truncate text-[11px] opacity-70">{summary}</div>}
								</div>
								{isFocused && (
									<button
										type="button"
										title="Return task to pool"
										aria-label="Return task to pool"
										className="shrink-0 rounded p-0.5 hover:bg-vscode-toolbar-hoverBackground"
										onClick={(event) => {
											event.stopPropagation()
											vscode.postMessage({ type: "dockTask", taskId: task.currentTaskId })
										}}>
										<Minimize2 className="size-3.5" />
									</button>
								)}
								<button
									type="button"
									title="Cancel task"
									aria-label="Cancel task"
									className="shrink-0 rounded p-0.5 hover:bg-vscode-toolbar-hoverBackground"
									onClick={(event) => {
										event.stopPropagation()
										vscode.postMessage({ type: "cancelTask", taskId: task.currentTaskId })
									}}>
									<X className="size-3.5" />
								</button>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}
