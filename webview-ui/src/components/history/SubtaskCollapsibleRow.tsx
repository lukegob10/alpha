import { memo } from "react"
import { ChevronRight } from "lucide-react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"

interface SubtaskCollapsibleRowProps {
	/** Number of subtasks */
	count: number
	/** Whether the subtask list is expanded */
	isExpanded: boolean
	/** Callback when the row is clicked to toggle expand/collapse */
	onToggle: () => void
	/** ID of the controlled subtask region. */
	controlsId?: string
	/** Optional className for styling */
	className?: string
}

/**
 * A clickable row that displays the subtask count with an expand/collapse chevron.
 * Clicking this row toggles the visibility of the subtask list.
 */
const SubtaskCollapsibleRow = ({ count, isExpanded, onToggle, controlsId, className }: SubtaskCollapsibleRowProps) => {
	const { t } = useAppTranslation()

	if (count === 0) {
		return null
	}

	return (
		<button
			type="button"
			data-testid="subtask-collapsible-row"
			className={cn(
				"flex min-h-10 w-full cursor-pointer items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-2 text-left text-xs font-medium",
				"bg-[color-mix(in_srgb,var(--surface-sunken)_82%,transparent)] text-vscode-descriptionForeground transition-[color,background-color,border-color]",
				"hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--alpha-accent)]",
				isExpanded && "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)] text-vscode-foreground",
				className,
			)}
			onClick={(e) => {
				e.stopPropagation()
				onToggle()
			}}
			aria-expanded={isExpanded}
			aria-controls={controlsId}
			aria-label={isExpanded ? t("history:collapseSubtasks") : t("history:expandSubtasks")}>
			<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--alpha-accent-soft)] text-[var(--alpha-accent)]">
				<ChevronRight className={cn("size-3.5 transition-transform duration-150", isExpanded && "rotate-90")} />
			</span>
			<span className="min-w-0 flex-1 truncate">{t("history:subtasks", { count })}</span>
		</button>
	)
}

export default memo(SubtaskCollapsibleRow)
