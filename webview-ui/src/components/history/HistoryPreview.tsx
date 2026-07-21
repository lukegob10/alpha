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
		<div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-4">
			<div className="mb-1 flex flex-wrap items-center justify-between">
				<h2 className="m-0 flex grow items-center gap-2 text-lg font-semibold">
					<span className="h-4 w-1 rounded-full bg-[linear-gradient(var(--alpha-accent),var(--alpha-brand-teal))]" />
					{t("history:recentTasks")}
				</h2>
				<button
					onClick={handleViewAllHistory}
					className="accent-chip cursor-pointer rounded-lg px-2.5 py-1 text-sm transition-colors hover:bg-[var(--alpha-accent-soft)]"
					aria-label={t("history:viewAllHistory")}>
					{t("history:viewAllHistory")}
				</button>
			</div>
			{displayGroups.length !== 0 && (
				<>
					{displayGroups.map((group) => (
						<TaskGroupItem
							key={group.parent.id}
							group={group}
							variant="compact"
							onToggleExpand={() => toggleExpand(group.parent.id)}
							onToggleSubtaskExpand={toggleExpand}
						/>
					))}
				</>
			)}
		</div>
	)
}

export default memo(HistoryPreview)
