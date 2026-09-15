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

import { getModelReservedOutputTokens } from "@alpha/api"

import { formatLargeNumber } from "@src/utils/format"
import { StandardTooltip, Button, Table, TableBody, TableRow, TableCell, CircularProgress } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { vscode } from "@src/utils/vscode"

import { TaskActions } from "./TaskActions"
import { ContextWindowProgress } from "./ContextWindowProgress"
import { TodoListDisplay } from "./TodoListDisplay"
import { LucideIconButton } from "./LucideIconButton"

export interface TaskHeaderProps {
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
	todos?: any[]
	onExpandedChange?: () => void
}

const TaskHeader = ({
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
	todos,
	onExpandedChange,
}: TaskHeaderProps) => {
	const { t } = useTranslation()
	const { apiConfiguration, currentTaskItem } = useExtensionState()
	const { id: modelId, info: model } = useSelectedModel(apiConfiguration)
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

	const contextWindow = model?.contextWindow || 1

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

	const condenseButton = (
		<LucideIconButton
			title={t("chat:task.condenseContext")}
			icon={FoldVertical}
			disabled={buttonsDisabled}
			onClick={() => currentTaskItem && handleCondenseContext(currentTaskItem.id)}
		/>
	)

	const hasTodos = todos && Array.isArray(todos) && todos.length > 0

	// Determine if this is a subtask (has a parent)
	const isSubtask = !!parentTaskId

	const handleBackToParent = () => {
		if (parentTaskId) {
			vscode.postMessage({ type: "showTaskWithId", text: parentTaskId })
		}
	}

	const toggleTaskExpanded = () => {
		onExpandedChange?.()
		setIsTaskExpanded((expanded) => !expanded)
	}

	return (
		<div className="chat-column max-h-[40%] shrink-0 overflow-y-auto px-[15px] pt-3 pb-2">
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
			<section
				className="task-context-card flex flex-col gap-1.5 rounded-xl px-4 py-2.5"
				aria-label={t("chat:task.title")}>
				<button
					type="button"
					onClick={toggleTaskExpanded}
					aria-label={isTaskExpanded ? t("chat:task.collapse") : t("chat:task.expand")}
					aria-expanded={isTaskExpanded}
					aria-controls={detailsId}
					className="flex min-h-6 w-full cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
					<span className="font-bold">{t("chat:task.title")}</span>
					{isTaskExpanded ? (
						<ChevronUp size={16} aria-hidden="true" />
					) : (
						<ChevronDown size={16} aria-hidden="true" />
					)}
				</button>
				{contextWindow > 0 && (
					<div className="flex items-center justify-between text-sm text-vscode-descriptionForeground">
						<div className="flex items-center gap-2">
							<StandardTooltip
								content={(() => {
									const availableSpace = contextWindow - (contextTokens || 0) - reservedForOutput

									return (
										<Table className="text-base ml-1.5">
											<TableBody>
												<TableRow>
													<TableCell className="font-medium whitespace-nowrap">
														{t("chat:tokenProgress.tokensUsedLabel")}
													</TableCell>
													<TableCell className="text-right text-[0.9em] font-mono">
														{formatLargeNumber(contextTokens || 0)} /{" "}
														{formatLargeNumber(contextWindow)}
													</TableCell>
												</TableRow>
												{reservedForOutput > 0 && (
													<TableRow>
														<TableCell className="font-medium whitespace-nowrap">
															{t("chat:tokenProgress.reservedForResponseLabel")}
														</TableCell>
														<TableCell className="text-right text-[0.9em] font-mono">
															{formatLargeNumber(reservedForOutput)}
														</TableCell>
													</TableRow>
												)}
												{availableSpace > 0 && (
													<TableRow>
														<TableCell className="font-medium whitespace-nowrap">
															{t("chat:tokenProgress.availableSpaceLabel")}
														</TableCell>
														<TableCell className="text-right text-[0.9em] font-mono">
															{formatLargeNumber(availableSpace)}
														</TableCell>
													</TableRow>
												)}
											</TableBody>
										</Table>
									)
								})()}
								side="top"
								sideOffset={8}>
								<span className="flex items-center gap-1.5">
									{(() => {
										// Calculate percentage of available input space used
										// Available input space = context window - reserved for output
										const availableInputSpace = contextWindow - reservedForOutput
										const percentage =
											availableInputSpace > 0
												? Math.round(((contextTokens || 0) / availableInputSpace) * 100)
												: 0
										return (
											<>
												<CircularProgress percentage={percentage} />
												<span>{percentage}%</span>
											</>
										)
									})()}
								</span>
							</StandardTooltip>
						</div>
					</div>
				)}
				<div id={detailsId} hidden={!isTaskExpanded}>
					{isTaskExpanded && (
						<>
							<div onClick={(e) => e.stopPropagation()}>
								<TaskActions item={currentTaskItem} buttonsDisabled={buttonsDisabled} />
							</div>

							<div className="pt-3 mt-2 -mx-2.5 px-2.5 border-t border-vscode-sideBar-background">
								<table className="w-full text-sm">
									<tbody>
										{contextWindow > 0 && (
											<tr>
												<th
													className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]"
													data-testid="context-window-label">
													{t("chat:task.contextWindow")}
												</th>
												<td className="font-light align-top">
													<div className={`max-w-md -mt-1.5 flex flex-nowrap gap-1`}>
														<ContextWindowProgress
															contextWindow={contextWindow}
															contextTokens={contextTokens || 0}
															maxTokens={maxTokens || undefined}
														/>
														{condenseButton}
													</div>
												</td>
											</tr>
										)}

										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
												{t("chat:task.tokens")}
											</th>
											<td className="font-light align-top">
												<div className="flex items-center gap-1 flex-wrap">
													{typeof tokensIn === "number" && tokensIn > 0 && (
														<span>↑ {formatLargeNumber(tokensIn)}</span>
													)}
													{typeof tokensOut === "number" && tokensOut > 0 && (
														<span>↓ {formatLargeNumber(tokensOut)}</span>
													)}
												</div>
											</td>
										</tr>

										{((typeof cacheReads === "number" && cacheReads > 0) ||
											(typeof cacheWrites === "number" && cacheWrites > 0)) && (
											<tr>
												<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
													{t("chat:task.cache")}
												</th>
												<td className="font-light align-top">
													<div className="flex items-center gap-1 flex-wrap">
														{typeof cacheWrites === "number" && cacheWrites > 0 && (
															<>
																<HardDriveDownload className="size-2.5" />
																<span>{formatLargeNumber(cacheWrites)}</span>
															</>
														)}
														{typeof cacheReads === "number" && cacheReads > 0 && (
															<>
																<HardDriveUpload className="size-2.5" />
																<span>{formatLargeNumber(cacheReads)}</span>
															</>
														)}
													</div>
												</td>
											</tr>
										)}

										{!!totalCost && (
											<tr>
												<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
													{t("chat:task.apiCost")}
												</th>
												<td className="font-light align-top">
													<StandardTooltip
														content={
															hasSubtasks ? (
																<div>
																	<div>
																		{t("chat:costs.totalWithSubtasks", {
																			cost: (aggregatedCost ?? totalCost).toFixed(
																				2,
																			),
																		})}
																	</div>
																	{costBreakdown && (
																		<div className="text-xs mt-1">
																			{costBreakdown}
																		</div>
																	)}
																</div>
															) : (
																<div>
																	{t("chat:costs.total", {
																		cost: totalCost.toFixed(2),
																	})}
																</div>
															)
														}
														side="top"
														sideOffset={8}>
														<span>
															${(aggregatedCost ?? totalCost).toFixed(2)}
															{hasSubtasks && (
																<span
																	className="text-xs ml-1"
																	title={t("chat:costs.includesSubtasks")}>
																	*
																</span>
															)}
														</span>
													</StandardTooltip>
												</td>
											</tr>
										)}

										{/* Size display */}
										{!!currentTaskItem?.size && currentTaskItem.size > 0 && (
											<tr>
												<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-2 h-[20px]">
													{t("chat:task.size")}
												</th>
												<td className="font-light align-top">
													{prettyBytes(currentTaskItem.size)}
												</td>
											</tr>
										)}
									</tbody>
								</table>
							</div>
						</>
					)}
				</div>
				{/* Todo list - always shown at bottom when todos exist */}
				{hasTodos && <TodoListDisplay todos={todos ?? []} />}
			</section>
		</div>
	)
}

export default memo(TaskHeader)
