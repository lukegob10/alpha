import { memo, useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronUp, ChevronDown, FoldVertical, ArrowLeft, CircleAlert } from "lucide-react"

import type { HistoryItem, LiveTaskMetadata, ProviderSettings, TodoItem } from "@alpha-code/types"

import { StandardTooltip, Button, Popover, PopoverTrigger, PopoverContent } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { SubagentModelStamp } from "@/components/agents/SubagentModelStamp"

import { TodoListDisplay } from "./TodoListDisplay"
import { LucideIconButton } from "./LucideIconButton"
import { ContextMeter, ContextUsageTooltip } from "./ContextMeter"
import { ContextDetails } from "./ContextDetails"
import { useTaskContextUsage } from "./useTaskContextUsage"

export interface TaskHeaderProps {
	apiConfiguration?: ProviderSettings
	currentTaskItem?: HistoryItem | null
	taskModel?: LiveTaskMetadata["model"]
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	aggregatedCost?: number
	hasSubtasks?: boolean
	parentTaskId?: string
	launcherTaskId?: string
	isManagedSubagent?: boolean
	costBreakdown?: string
	contextTokens: number
	buttonsDisabled: boolean
	handleCondenseContext: (taskId: string) => void
	onShowTask?: (taskId: string) => void
	todos?: TodoItem[]
	onExpandedChange?: () => void
	presentation?: "header" | "composer" | "identity"
	isVisible?: boolean
}

const TaskHeader = ({
	apiConfiguration,
	currentTaskItem,
	taskModel,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	totalCost,
	aggregatedCost,
	hasSubtasks,
	parentTaskId,
	launcherTaskId,
	isManagedSubagent,
	costBreakdown,
	contextTokens,
	buttonsDisabled,
	handleCondenseContext,
	onShowTask,
	todos,
	onExpandedChange,
	presentation = "header",
	isVisible = true,
}: TaskHeaderProps) => {
	const { t } = useTranslation()
	const usage = useTaskContextUsage({ apiConfiguration, taskModel, contextTokens })
	const contextPercentage = usage.percentage
	const [isTaskExpanded, setIsTaskExpanded] = useState(false)
	useEffect(() => setIsTaskExpanded(false), [currentTaskItem?.id, isVisible])
	const detailsId = useId()
	const subagentModelRoute = isManagedSubagent ? currentTaskItem?.subagentModelRoute : undefined
	const isWorkerSubagent = isManagedSubagent && currentTaskItem?.subagentRole === "worker"
	const subagentRoleLabel =
		currentTaskItem?.subagentRole === "explore"
			? "Explorer"
			: currentTaskItem?.subagentRole === "review"
				? "Reviewer"
				: currentTaskItem?.subagentRole === "worker"
					? "Worker"
					: "Sub-agent"
	const subagentIdentityLabel = currentTaskItem?.subagentNickname
		? `${currentTaskItem.subagentNickname} · ${subagentRoleLabel}`
		: subagentRoleLabel
	const workerLifecycleLabel = currentTaskItem?.subagentChangeSet
		? currentTaskItem.subagentChangeSet.status === "pending_review" ||
			currentTaskItem.subagentChangeSet.status === "conflicted"
			? "quarantined change set"
			: currentTaskItem.subagentChangeSet.status === "applied"
				? "applied change set"
				: currentTaskItem.subagentChangeSet.status === "discarded"
					? "discarded change set"
					: "captured worker result"
		: undefined

	const contextTooltip = <ContextUsageTooltip usage={usage} />

	const hasTodos = todos && Array.isArray(todos) && todos.length > 0

	// Determine if this is a subtask (has a parent)
	const returnTaskId = parentTaskId ?? launcherTaskId
	const isSubtask = !!returnTaskId

	const handleBackToParent = () => {
		if (returnTaskId) {
			if (onShowTask) onShowTask(returnTaskId)
			else vscode.postMessage({ type: "showTaskWithId", text: returnTaskId })
		}
	}

	const toggleTaskExpanded = () => {
		onExpandedChange?.()
		setIsTaskExpanded((expanded) => !expanded)
	}
	const details = (
		<ContextDetails
			currentTaskItem={currentTaskItem}
			tokensIn={tokensIn}
			tokensOut={tokensOut}
			cacheWrites={cacheWrites}
			cacheReads={cacheReads}
			totalCost={totalCost}
			aggregatedCost={aggregatedCost}
			hasSubtasks={hasSubtasks}
			costBreakdown={costBreakdown}
			buttonsDisabled={buttonsDisabled}
			handleCondenseContext={handleCondenseContext}
			todos={presentation === "composer" ? todos : undefined}
			usage={presentation === "composer" ? usage : undefined}
			showCondense={presentation === "composer"}
		/>
	)

	if (presentation === "composer") {
		return (
			<Popover
				open={isVisible && isTaskExpanded}
				onOpenChange={(open) => {
					onExpandedChange?.()
					setIsTaskExpanded(open)
				}}>
				<PopoverTrigger asChild>
					<ContextMeter
						usage={usage}
						aria-label={
							isTaskExpanded ? t("chat:task.collapseContextDetails") : t("chat:task.expandContextDetails")
						}
					/>
				</PopoverTrigger>
				<PopoverContent
					side="top"
					align="start"
					className="max-h-[min(60vh,480px)] w-[min(340px,calc(100vw-24px))] overflow-y-auto p-3"
					aria-label={t("chat:task.taskDetails")}>
					{details}
				</PopoverContent>
			</Popover>
		)
	}
	if (presentation === "identity" && !isSubtask) return null

	return (
		<div className="chat-column max-h-[40%] shrink-0 overflow-y-auto px-[15px] pt-2 pb-1">
			{isSubtask && (
				<div className="mb-2" onClick={(e) => e.stopPropagation()}>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleBackToParent}
						className="flex items-center gap-1.5 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground">
						<ArrowLeft className="size-3" />
						{launcherTaskId && !parentTaskId
							? t("chat:crossTasks.backToLauncher")
							: isManagedSubagent
								? "Return to parent"
								: t("chat:task.backToParentTask")}
					</Button>
					{isManagedSubagent && (
						<div className="mt-1 space-y-1 px-2 text-xs text-vscode-descriptionForeground">
							<div className="font-medium text-vscode-foreground">{subagentIdentityLabel}</div>
							<div>
								{isWorkerSubagent && workerLifecycleLabel
									? `Parent-managed editing worker · ${workerLifecycleLabel}`
									: t("chat:subagentRow.inheritedPermissions")}
							</div>
							{isWorkerSubagent && currentTaskItem?.subagentWriteScope && (
								<div>Write scope: {currentTaskItem.subagentWriteScope.join(", ")}</div>
							)}
							{subagentModelRoute && (
								<div>
									<SubagentModelStamp modelRoute={subagentModelRoute} includeProfile />
								</div>
							)}
							{subagentModelRoute?.resolution === "fallback" && (
								<div
									className="flex items-start gap-1 text-vscode-editorWarning-foreground"
									role="status">
									<CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
									<span>
										Using parent profile because the configured sub-agent profile is unavailable.
									</span>
								</div>
							)}
						</div>
					)}
				</div>
			)}
			{presentation !== "identity" && (
				<section className="task-context-card rounded-lg px-3 py-2" aria-label={t("chat:task.contextUsage")}>
					<div className="flex min-w-0 items-center gap-2">
						<StandardTooltip content={contextTooltip} side="top" sideOffset={8}>
							<button
								type="button"
								onClick={toggleTaskExpanded}
								aria-label={
									isTaskExpanded
										? t("chat:task.collapseContextDetails")
										: t("chat:task.expandContextDetails")
								}
								aria-expanded={isTaskExpanded}
								aria-controls={detailsId}
								className="group flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
								{isTaskExpanded ? (
									<ChevronUp
										className="size-3.5 shrink-0 text-vscode-descriptionForeground group-hover:text-vscode-foreground"
										aria-hidden="true"
									/>
								) : (
									<ChevronDown
										className="size-3.5 shrink-0 text-vscode-descriptionForeground group-hover:text-vscode-foreground"
										aria-hidden="true"
									/>
								)}
								<span className="shrink-0 text-xs font-medium text-vscode-descriptionForeground group-hover:text-vscode-foreground">
									{t("chat:task.contextUsage")}
								</span>
								<span
									role="progressbar"
									aria-label={t("chat:task.contextUsage")}
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={contextPercentage}
									className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_14%,transparent)]">
									<span
										className="block h-full rounded-full bg-[var(--vscode-progressBar-background,var(--vscode-focusBorder))] transition-[width] duration-300 motion-reduce:transition-none"
										style={{ width: contextPercentage + "%" }}
									/>
								</span>
							</button>
						</StandardTooltip>
						<LucideIconButton
							title={t("chat:task.condenseContext")}
							icon={FoldVertical}
							disabled={buttonsDisabled || !currentTaskItem}
							className="size-7 shrink-0 rounded-md p-0 [&_svg]:size-3.5"
							onClick={() => currentTaskItem && handleCondenseContext(currentTaskItem.id)}
						/>
						<span
							data-testid="context-usage-percent"
							className="min-w-10 shrink-0 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-1.5 py-1 text-center text-xs font-semibold tabular-nums text-vscode-foreground">
							{contextPercentage}%
						</span>
					</div>
					<div id={detailsId} hidden={!isTaskExpanded}>
						{isTaskExpanded && (
							<div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">{details}</div>
						)}
					</div>
					{hasTodos && (
						<div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">
							<TodoListDisplay todos={todos ?? []} />
						</div>
					)}
				</section>
			)}
		</div>
	)
}

export default memo(TaskHeader)
