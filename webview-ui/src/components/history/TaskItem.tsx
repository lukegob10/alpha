import { memo, useContext, type KeyboardEvent } from "react"
import { ArrowRight, Folder } from "lucide-react"
import { TaskLifecycleState, TaskStatus, type LiveTaskMetadata } from "@alpha-code/types"
import type { DisplayHistoryItem } from "./types"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"

import TaskItemFooter from "./TaskItemFooter"
import { StandardTooltip } from "../ui"

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
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	onDelete,
	className,
}: TaskItemProps) => {
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
		} else {
			vscode.postMessage({ type: "showTaskWithId", text: item.id })
		}
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
			className={cn(
				"cursor-pointer group relative overflow-hidden",
				"text-vscode-foreground/80 hover:text-vscode-foreground transition-colors",
				hasSubtasks ? "rounded-t-xl" : "rounded-xl",
				className,
			)}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			role="button"
			tabIndex={0}
			aria-label={`Open task: ${item.task}`}>
			<div className={(!isCompact && isSelectionMode ? "pl-3 pb-3" : "pl-4") + " flex gap-3 px-3 pt-3 pb-1"}>
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
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-light text-ellipsis line-clamp-3",
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
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-light text-ellipsis line-clamp-3",
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
						<ArrowRight className="size-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
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
