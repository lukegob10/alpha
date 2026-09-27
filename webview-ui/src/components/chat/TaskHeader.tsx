import { memo, useId, useState, useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
	ChevronUp,
	ChevronDown,
	HardDriveDownload,
	HardDriveUpload,
	FoldVertical,
	ArrowLeft,
	CircleAlert,
} from "lucide-react"
import prettyBytes from "pretty-bytes"

import type { HistoryItem, LiveTaskMetadata, ProviderSettings } from "@alpha-code/types"

import { getModelReservedOutputTokens } from "@alpha/api"

import { formatLargeNumber } from "@src/utils/format"
import { StandardTooltip, Button } from "@src/components/ui"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { vscode } from "@src/utils/vscode"

import { TaskActions } from "./TaskActions"
import { TodoListDisplay } from "./TodoListDisplay"
import { LucideIconButton } from "./LucideIconButton"

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
	isManagedSubagent?: boolean
	costBreakdown?: string
	contextTokens: number
	buttonsDisabled: boolean
	handleCondenseContext: (taskId: string) => void
	onShowTask?: (taskId: string) => void
	todos?: any[]
	onExpandedChange?: () => void
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
	isManagedSubagent,
	costBreakdown,
	contextTokens,
	buttonsDisabled,
	handleCondenseContext,
	onShowTask,
	todos,
	onExpandedChange,
}: TaskHeaderProps) => {
	const { t } = useTranslation()
	const selectedModel = useSelectedModel(apiConfiguration)
	const { id: modelId, info: model } = taskModel ?? selectedModel
	const [isTaskExpanded, setIsTaskExpanded] = useState(false)
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
		: "isolated worktree"
	const subagentModelLabel = subagentModelRoute
		? [
				subagentModelRoute.profileName,
				[subagentModelRoute.provider, subagentModelRoute.modelId].filter(Boolean).join(" · "),
			]
				.filter(Boolean)
				.join(" · ")
		: undefined

	const contextWindow = model?.contextWindow || 0

	// Calculate maxTokens (reserved for output) once for reuse in percentage and tooltip
	const maxTokens = useMemo(
		() =>
			model
				? getModelReservedOutputTokens({
						modelId,
						model,
						settings: apiConfiguration,
					})
				: 0,
		[model, modelId, apiConfiguration],
	)
	const reservedForOutput = maxTokens || 0
	const availableInputSpace = contextWindow - reservedForOutput
	const contextPercentage =
		availableInputSpace > 0
			? Math.min(100, Math.max(0, Math.round(((contextTokens || 0) / availableInputSpace) * 100)))
			: 0
	const availableSpace = Math.max(0, contextWindow - contextTokens - reservedForOutput)
	const contextTooltip = (
		<div className="space-y-1 text-xs">
			<div>
				{t("chat:tokenProgress.tokensUsed", {
					used: formatLargeNumber(contextTokens || 0),
					total: formatLargeNumber(contextWindow),
				})}
			</div>
			{reservedForOutput > 0 && (
				<div>
					{t("chat:tokenProgress.reservedForResponse", { amount: formatLargeNumber(reservedForOutput) })}
				</div>
			)}
			<div>{t("chat:tokenProgress.availableSpace", { amount: formatLargeNumber(availableSpace) })}</div>
		</div>
	)
	const safeTotalCost = Number.isFinite(totalCost) ? totalCost : 0
	const costTooltip = hasSubtasks ? (
		<div>
			<div>{t("chat:costs.totalWithSubtasks", { cost: (aggregatedCost ?? safeTotalCost).toFixed(2) })}</div>
			{costBreakdown && <div className="mt-1 text-xs">{costBreakdown}</div>}
		</div>
	) : (
		t("chat:costs.total", { cost: safeTotalCost.toFixed(2) })
	)

	const hasTodos = todos && Array.isArray(todos) && todos.length > 0

	// Determine if this is a subtask (has a parent)
	const isSubtask = !!parentTaskId

	const handleBackToParent = () => {
		if (parentTaskId) {
			if (onShowTask) onShowTask(parentTaskId)
			else vscode.postMessage({ type: "showTaskWithId", text: parentTaskId })
		}
	}

	const toggleTaskExpanded = () => {
		onExpandedChange?.()
		setIsTaskExpanded((expanded) => !expanded)
	}

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
						{isManagedSubagent ? "Return to parent" : t("chat:task.backToParentTask")}
					</Button>
					{isManagedSubagent && (
						<div className="mt-1 space-y-1 px-2 text-xs text-vscode-descriptionForeground">
							<div className="font-medium text-vscode-foreground">{subagentIdentityLabel}</div>
							<div>
								{isWorkerSubagent
									? `Parent-managed editing worker · ${workerLifecycleLabel}`
									: "Parent-managed read-only sub-agent"}
							</div>
							{isWorkerSubagent && currentTaskItem?.subagentWriteScope && (
								<div>Write scope: {currentTaskItem.subagentWriteScope.join(", ")}</div>
							)}
							{subagentModelLabel && <div>{subagentModelLabel}</div>}
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
						<div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">
							<div className="flex min-h-7 items-center justify-between gap-2">
								<h3 className="text-xs font-semibold text-vscode-descriptionForeground">
									{t("chat:task.taskDetails")}
								</h3>
								<TaskActions item={currentTaskItem ?? undefined} buttonsDisabled={buttonsDisabled} />
							</div>
							<dl className="task-context-metrics mt-2 text-xs">
								<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
									<dt className="mb-1 text-vscode-descriptionForeground">{t("chat:task.tokens")}</dt>
									<dd className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums text-sm font-medium text-vscode-foreground">
										<span className="inline-flex items-center gap-1.5">
											<span
												className="font-semibold text-[var(--vscode-charts-blue,var(--vscode-focusBorder))]"
												aria-hidden="true">
												↑
											</span>
											<span className="sr-only">{t("chat:task.inputTokens")}: </span>
											{formatLargeNumber(tokensIn || 0)}
										</span>
										<span className="inline-flex items-center gap-1.5">
											<span
												className="font-semibold text-[var(--vscode-charts-orange,var(--vscode-descriptionForeground))]"
												aria-hidden="true">
												↓
											</span>
											<span className="sr-only">{t("chat:task.outputTokens")}: </span>
											{formatLargeNumber(tokensOut || 0)}
										</span>
									</dd>
								</div>
								{((typeof cacheReads === "number" && cacheReads > 0) ||
									(typeof cacheWrites === "number" && cacheWrites > 0)) && (
									<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
										<dt className="mb-1 text-vscode-descriptionForeground">
											{t("chat:task.cache")}
										</dt>
										<dd className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums text-sm font-medium text-vscode-foreground">
											{typeof cacheWrites === "number" && cacheWrites > 0 && (
												<span className="inline-flex items-center gap-1">
													<HardDriveDownload className="size-3" aria-hidden="true" />
													{formatLargeNumber(cacheWrites)}
												</span>
											)}
											{typeof cacheReads === "number" && cacheReads > 0 && (
												<span className="inline-flex items-center gap-1">
													<HardDriveUpload className="size-3" aria-hidden="true" />
													{formatLargeNumber(cacheReads)}
												</span>
											)}
										</dd>
									</div>
								)}
								{!!totalCost && (
									<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
										<dt className="mb-1 text-vscode-descriptionForeground">
											{t("chat:task.apiCost")}
										</dt>
										<dd className="tabular-nums text-sm font-medium text-vscode-foreground">
											<StandardTooltip content={costTooltip} side="top" sideOffset={8}>
												<span>
													{"$"}
													{(aggregatedCost ?? totalCost).toFixed(2)}
													{hasSubtasks && (
														<span
															className="ml-1 text-xs"
															title={t("chat:costs.includesSubtasks")}>
															*
														</span>
													)}
												</span>
											</StandardTooltip>
										</dd>
									</div>
								)}
								{!!currentTaskItem?.size && currentTaskItem.size > 0 && (
									<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
										<dt className="mb-1 text-vscode-descriptionForeground">
											{t("chat:task.size")}
										</dt>
										<dd className="tabular-nums text-sm font-medium text-vscode-foreground">
											{prettyBytes(currentTaskItem.size)}
										</dd>
									</div>
								)}
							</dl>
						</div>
					)}
				</div>
				{hasTodos && (
					<div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">
						<TodoListDisplay todos={todos ?? []} />
					</div>
				)}
			</section>
		</div>
	)
}

export default memo(TaskHeader)
