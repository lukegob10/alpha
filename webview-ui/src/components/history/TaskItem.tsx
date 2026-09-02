import { memo, useContext, type KeyboardEvent } from "react"
import { ArrowRight, Folder } from "lucide-react"
import { TaskLifecycleState, TaskStatus, type LiveTaskMetadata } from "@alpha-code/types"
import type { DisplayHistoryItem } from "./types"

import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"

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
	const { isOpening, openTask } = useTaskOpeningFeedback(item.id)
	const extensionState = useContext(ExtensionStateContext)
	const currentTaskId = extensionState?.currentTaskId
	const liveTasksById = extensionState?.liveTasksById
	const liveTask = liveTasksById?.[item.id]
	const liveTaskIndicator = liveTask ? getLiveTaskIndicator(liveTask) : undefined
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

	return (
		<div
			key={item.id}
			data-testid={`task-item-${item.id}`}
			data-contained={contained ? "true" : "false"}
			className={cn(
				"cursor-pointer group relative overflow-hidden text-vscode-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--alpha-accent)]",
				contained
					? "bg-transparent transition-[color,background-color] duration-150 hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground"
					: "surface-raised transition-[color,background-color,border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground hover:shadow-[var(--shadow-accent)]",
				isActive && "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)] text-vscode-foreground",
				hasSubtasks ? "rounded-t-xl" : "rounded-xl",
				className,
			)}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			role="button"
			tabIndex={0}
			aria-busy={isOpening}
			aria-current={isActive ? "page" : undefined}
			aria-label={`Open task: ${item.task}`}>
			<div className={cn("flex gap-3 px-4 py-3.5", !isCompact && isSelectionMode && "pb-3 pl-3")}>
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

				<div className="flex-1 min-w-0">
					<div className="flex items-start gap-1">
						{item.highlight ? (
							<div
								className={cn(
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-normal leading-5 text-ellipsis line-clamp-3",
									{
										"text-base": !isCompact,
									},
									!isCompact && isSelectionMode ? "mb-1" : "",
								)}
								data-testid="task-content"
								dangerouslySetInnerHTML={{ __html: item.highlight }}
							/>
						) : (
							<div
								className={cn(
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-normal leading-5 text-ellipsis line-clamp-3",
									{
										"text-base": !isCompact,
									},
									!isCompact && isSelectionMode ? "mb-1" : "",
								)}
								data-testid="task-content">
								<StandardTooltip content={item.task}>
									<span>{item.task}</span>
								</StandardTooltip>
							</div>
						)}
						{liveTaskIndicator && (
							<StandardTooltip content={liveTaskTooltip ?? liveTaskIndicator.label}>
								<span
									className="mt-1.5 flex size-3.5 shrink-0 items-center justify-center"
									aria-label={`Task status: ${liveTaskIndicator.label}`}
									data-testid="task-status-indicator">
									<span
										className={cn("block size-2 rounded-full", liveTaskIndicator.className)}
										aria-hidden="true"
									/>
								</span>
							</StandardTooltip>
						)}
						{/* Arrow icon that appears on hover */}
						{isOpening ? (
							<span
								className="codicon codicon-loading codicon-modifier-spin size-4 shrink-0"
								data-testid="task-opening-indicator"
								aria-hidden="true"
							/>
						) : (
							<ArrowRight className="size-4 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100" />
						)}
					</div>

					{showWorkspace && item.workspace && (
						<div className="flex items-center font-mono gap-1 text-vscode-descriptionForeground text-xs mt-1">
							<Folder className="size-3" />
							<span>{item.workspace}</span>
						</div>
					)}

					<TaskItemFooter
						item={item}
						variant={variant}
						isSelectionMode={isSelectionMode}
						isSubtask={item.isSubtask}
						onDelete={onDelete}
					/>
				</div>
			</div>
		</div>
	)
}

export default memo(TaskItem)
