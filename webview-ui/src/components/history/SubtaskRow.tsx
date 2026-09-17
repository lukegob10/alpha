import { memo } from "react"
import { ArrowRight, ChevronRight, CornerDownRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppTranslation } from "@/i18n/TranslationContext"
import type { SubtaskTreeNode } from "./types"
import { countAllSubtasks } from "./types"
import { useTaskOpeningFeedback } from "./useTaskOpeningFeedback"
import { StandardTooltip } from "../ui"

interface SubtaskRowProps {
	/** The subtask tree node to display */
	node: SubtaskTreeNode
	/** Nesting depth (1 = direct child of parent group) */
	depth: number
	/** Callback when expand/collapse is toggled for a node */
	onToggleExpand: (taskId: string) => void
	/** Optional className for styling */
	className?: string
}

/**
 * Displays a subtask row with recursive nesting support.
 * Leaf nodes render just the task row. Nodes with children show
 * a collapsible section that can be expanded to reveal nested subtasks.
 */
const SubtaskRow = ({ node, depth, onToggleExpand, className }: SubtaskRowProps) => {
	const { t } = useAppTranslation()
	const { item, children, isExpanded } = node
	const { isOpening, openTask } = useTaskOpeningFeedback(item.id)
	const hasChildren = children.length > 0
	const descendantCount = hasChildren ? countAllSubtasks(children) : 0
	const childListId = `subtask-${item.id}-children`
	const rowIndent = 12 + Math.max(0, depth - 1) * 16

	const handleClick = () => {
		openTask()
	}

	return (
		<div data-testid={`subtask-row-${item.id}`} className={className}>
			<div
				data-testid={`subtask-item-row-${item.id}`}
				className={cn(
					"group flex min-h-9 items-center gap-1.5 pr-2 transition-colors",
					"text-vscode-foreground/70 hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground",
				)}
				style={{ paddingLeft: `${rowIndent}px` }}>
				<CornerDownRight
					className="size-3.5 shrink-0 text-[var(--alpha-accent)] opacity-45"
					aria-hidden="true"
				/>
				<button
					type="button"
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)]"
					onClick={handleClick}
					aria-busy={isOpening}
					aria-label={`Open task: ${item.task}`}>
					<StandardTooltip content={item.task} delay={600}>
						<span className="min-w-0 flex-1 truncate text-sm">{item.task}</span>
					</StandardTooltip>
					{isOpening ? (
						<span
							className="codicon codicon-loading codicon-modifier-spin size-3 shrink-0"
							data-testid="subtask-opening-indicator"
							aria-hidden="true"
						/>
					) : (
						<ArrowRight className="size-3 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100" />
					)}
				</button>

				{hasChildren && (
					<button
						type="button"
						data-testid="subtask-collapsible-row"
						className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-vscode-descriptionForeground transition-colors hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)]"
						onClick={() => onToggleExpand(item.id)}
						aria-expanded={isExpanded}
						aria-controls={childListId}
						aria-label={isExpanded ? t("history:collapseSubtasks") : t("history:expandSubtasks")}>
						<ChevronRight
							className={cn("size-3 transition-transform duration-150", isExpanded && "rotate-90")}
						/>
						<span>{t("history:subtasks", { count: descendantCount })}</span>
					</button>
				)}
			</div>

			{/* Expanded nested subtasks */}
			{hasChildren && (
				<div
					id={childListId}
					data-testid="nested-subtask-list"
					role="group"
					hidden={!isExpanded}
					className="relative">
					<span
						className="pointer-events-none absolute top-0 bottom-1 w-px bg-[var(--border-subtle)]"
						style={{ left: `${rowIndent + 6}px` }}
						aria-hidden="true"
					/>
					{children.map((child) => (
						<SubtaskRow
							key={child.item.id}
							node={child}
							depth={depth + 1}
							onToggleExpand={onToggleExpand}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export default memo(SubtaskRow)
