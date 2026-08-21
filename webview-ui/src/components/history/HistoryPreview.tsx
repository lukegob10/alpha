import { memo } from "react"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import { useTaskSearch } from "./useTaskSearch"
import { useGroupedTasks } from "./useGroupedTasks"
import TaskGroupItem from "./TaskGroupItem"

const HistoryPreview = () => {
	const { tasks, searchQuery } = useTaskSearch()
	const { groups, toggleExpand } = useGroupedTasks(tasks, searchQuery)
	const { t } = useAppTranslation()

	const handleViewAllHistory = () => {
		vscode.postMessage({ type: "switchTab", tab: "history" })
	}

	// Show up to 4 groups (parent + subtasks count as 1 block)
	const displayGroups = groups.slice(0, 4)

	return (
		<section
			className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-5"
			aria-labelledby="recent-tasks-heading">
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-1">
				<h2
					id="recent-tasks-heading"
					className="m-0 flex grow items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-vscode-foreground">
					<span className="h-4 w-1 rounded-full bg-[linear-gradient(var(--alpha-accent),var(--alpha-brand-teal))]" />
					{t("history:recentTasks")}
				</h2>
				<button
					type="button"
					onClick={handleViewAllHistory}
					className="accent-chip cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-[background-color,border-color] hover:border-[var(--alpha-accent)] hover:bg-[var(--alpha-accent-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)]"
					aria-label={t("history:viewAllHistory")}>
					{t("history:viewAllHistory")}
				</button>
			</div>
			{displayGroups.length !== 0 && (
				<div className="flex flex-col gap-3" data-testid="history-preview-list">
					{displayGroups.map((group) => (
						<TaskGroupItem
							key={group.parent.id}
							group={group}
							variant="compact"
							onToggleExpand={() => toggleExpand(group.parent.id)}
							onToggleSubtaskExpand={toggleExpand}
						/>
					))}
				</div>
			)}
		</section>
	)
}

export default memo(HistoryPreview)
