import { memo, useContext, type KeyboardEvent } from "react"
import { ArrowRight, Folder, LoaderCircle } from "lucide-react"
import { TaskLifecycleState, TaskStatus, type LiveTaskMetadata } from "@alpha-code/types"
import type { DisplayHistoryItem } from "./types"

import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { formatTimeAgo } from "@/utils/format"
import { useAppTranslation } from "@/i18n/TranslationContext"

import TaskItemFooter from "./TaskItemFooter"
import { StandardTooltip } from "../ui"
import { useTaskOpeningFeedback } from "./useTaskOpeningFeedback"

const formatStatusText = (value: string) =>
	value.replace(/[_-]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())

const getLiveTaskIndicator = (liveTask: LiveTaskMetadata) => {
	switch (liveTask.lifecycle) {
		case TaskLifecycleState.Completed:
			return { label: "Complete", className: "bg-green-500" }
		case TaskLifecycleState.Failed:
			return { label: "Failed", className: "bg-vscode-errorForeground" }
		case TaskLifecycleState.Closing:
			return { label: "Closing", className: "bg-vscode-descriptionForeground/70" }
		case TaskLifecycleState.Closed:
			return { label: "Closed", className: "bg-vscode-descriptionForeground/50" }
		case TaskLifecycleState.Waiting:
			if (liveTask.status === TaskStatus.Idle || liveTask.waitingReason === "idle") {
				return { label: "Idle", className: "bg-blue-500" }
			}

			if (liveTask.isWaitingForInput || liveTask.status === TaskStatus.Interactive) {
				return { label: "Waiting for input", className: "bg-yellow-500" }
			}

			return {
				label: liveTask.waitingReason ? formatStatusText(liveTask.waitingReason) : "Waiting",
				className: "bg-blue-500",
			}
		case TaskLifecycleState.Initializing:
			return { label: "Starting", className: "bg-vscode-progressBar-background" }
		case TaskLifecycleState.Running:
		default:
			return { label: liveTask.isStreaming ? "Running" : "Active", className: "bg-vscode-progressBar-background" }
	}
}

interface TaskItemProps {
	item: DisplayHistoryItem
	variant: "compact" | "full"
	showWorkspace?: boolean
	hasSubtasks?: boolean
	/** Render inside a TaskGroupItem-owned surface instead of creating a second card surface. */
	contained?: boolean
	isSelectionMode?: boolean
	isSelected?: boolean
	onToggleSelection?: (taskId: string, isSelected: boolean) => void
	onDelete?: (taskId: string) => void
	className?: string
}

const TaskItem = ({
	item,
	variant,
	showWorkspace = false,
	hasSubtasks = false,
	contained = false,
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	onDelete,
	className,
}: TaskItemProps) => {
	const { t } = useAppTranslation()
	const ageSeconds = Math.max(0, Math.floor((Date.now() - item.ts) / 1000))
	const ageUnit = (
		[
			["year", 31536000],
			["month", 2592000],
			["week", 604800],
			["day", 86400],
			["hour", 3600],
			["minute", 60],
		] as const
	).find(([, seconds]) => ageSeconds >= seconds)
	const compactAge = ageUnit
		? t(`history:age.${ageUnit[0]}`, { count: Math.floor(ageSeconds / ageUnit[1]) })
		: t("history:age.now")
	const { isOpening, openTask } = useTaskOpeningFeedback(item.id)
	const extensionState = useContext(ExtensionStateContext)
	const currentTaskId = extensionState?.currentTaskId
	const liveTasksById = extensionState?.liveTasksById
	const liveTask = liveTasksById?.[item.id]
	const liveTaskIndicator = liveTask ? getLiveTaskIndicator(liveTask) : undefined
	const isRunning =
		liveTask?.lifecycle === TaskLifecycleState.Running || liveTask?.lifecycle === TaskLifecycleState.Initializing
	const isActive = currentTaskId === item.id
	const liveTaskTooltip = liveTask
		? `${isActive ? "Selected" : "Background"} task: ${liveTaskIndicator?.label ?? formatStatusText(liveTask.lifecycle)}${
				liveTask.waitingReason && liveTaskIndicator?.label !== formatStatusText(liveTask.waitingReason)
					? ` (${formatStatusText(liveTask.waitingReason)})`
					: ""
			}`
		: undefined

	const handleClick = () => {
		if (isSelectionMode && onToggleSelection) {
			onToggleSelection(item.id, !isSelected)
			return
		}

		openTask()
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.currentTarget !== event.target) {
			return
		}

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			handleClick()
		}
	}

	const isCompact = variant === "compact"
	const taskContentClassName = cn(
		"min-w-0 flex-1 font-normal leading-5",
		isCompact
			? "truncate whitespace-nowrap text-base"
			: "overflow-hidden whitespace-pre-wrap text-ellipsis line-clamp-3 text-base",
		!isCompact && isSelectionMode && "mb-1",
	)
	const statusIndicator = liveTaskIndicator && (
		<StandardTooltip content={liveTaskTooltip ?? liveTaskIndicator.label}>
			<span
				className={cn("flex size-3.5 shrink-0 items-center justify-center", !isCompact && "mt-1.5")}
				aria-label={`Task status: ${liveTaskIndicator.label}`}
				data-testid="task-status-indicator">
				{isRunning ? (
					<LoaderCircle
						className="size-3.5 animate-spin motion-reduce:animate-none text-vscode-progressBar-background"
						aria-hidden="true"
					/>
				) : (
					<span className={cn("block size-2 rounded-full", liveTaskIndicator.className)} aria-hidden="true" />
				)}
			</span>
		</StandardTooltip>
	)

	return (
		<div
			key={item.id}
			data-testid={`task-item-${item.id}`}
			data-contained={contained ? "true" : "false"}
			className={cn(
				"cursor-pointer group relative overflow-hidden text-vscode-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder",
				contained
					? "bg-transparent transition-[color,background-color] duration-150 hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground"
					: "surface-raised transition-[color,background-color,border-color,box-shadow,transform] duration-150 hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground",
				isActive && "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)] text-vscode-foreground",
				isCompact ? "rounded-md" : hasSubtasks ? "rounded-t-xl" : "rounded-xl",
				className,
			)}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			role="button"
			tabIndex={0}
			aria-busy={isOpening}
			aria-current={isActive ? "page" : undefined}
			aria-label={`Open task: ${item.task}`}>
			<div
				className={cn(
					"flex min-w-0",
					isCompact ? "min-h-7 items-center gap-2 px-2 py-1" : "gap-3 px-4 py-3.5",
					!isCompact && isSelectionMode && "pb-3 pl-3",
				)}>
				{/* Selection checkbox - only in full variant */}
				{!isCompact && isSelectionMode && (
					<div
						className="task-checkbox mt-1"
						onClick={(e) => {
							e.stopPropagation()
						}}>
						<Checkbox
							checked={isSelected}
							onCheckedChange={(checked: boolean) => onToggleSelection?.(item.id, checked === true)}
							variant="description"
						/>
					</div>
				)}

				<div className={cn("min-w-0 flex-1", isCompact && "flex items-center gap-3")}>
					<div className={cn("flex gap-1", isCompact ? "min-w-0 flex-1 items-center" : "items-start")}>
						{item.highlight ? (
							<div
								className={taskContentClassName}
								data-testid="task-content"
								dangerouslySetInnerHTML={{ __html: item.highlight }}
							/>
						) : (
							<div className={taskContentClassName} data-testid="task-content">
								<StandardTooltip content={item.task}>
									<span>{item.task}</span>
								</StandardTooltip>
							</div>
						)}
						{isCompact ? (
							<div
								className="grid shrink-0 grid-cols-[0.875rem_3rem] items-center gap-1.5"
								data-testid="task-metadata">
								{statusIndicator ?? <span aria-hidden="true" />}
								<StandardTooltip content={new Date(item.ts).toLocaleString()}>
									<span
										className="w-12 shrink-0 whitespace-nowrap text-right text-xs text-vscode-descriptionForeground"
										title={new Date(item.ts).toLocaleString()}
										aria-label={formatTimeAgo(item.ts)}
										data-testid="task-time-ago">
										{compactAge}
									</span>
								</StandardTooltip>
							</div>
						) : (
							statusIndicator
						)}
						{/* Arrow icon that appears on hover */}
						{isOpening ? (
							<span
								className="codicon codicon-loading codicon-modifier-spin size-4 shrink-0"
								data-testid="task-opening-indicator"
								aria-hidden="true"
							/>
						) : (
							<ArrowRight
								className={cn(
									"shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100",
									isCompact ? "size-3.5" : "size-4",
								)}
							/>
						)}
					</div>

					{showWorkspace && item.workspace && (
						<div className="flex items-center font-mono gap-1 text-vscode-descriptionForeground text-xs mt-1">
							<Folder className="size-3" />
							<span>{item.workspace}</span>
						</div>
					)}

					{!isCompact && (
						<TaskItemFooter
							item={item}
							variant={variant}
							isSelectionMode={isSelectionMode}
							isSubtask={item.isSubtask}
							onDelete={onDelete}
						/>
					)}
				</div>
			</div>
		</div>
	)
}

export default memo(TaskItem)
