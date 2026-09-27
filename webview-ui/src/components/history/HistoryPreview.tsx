import { memo, useEffect, useId, useMemo, useRef, useState } from "react"
import { MoreHorizontal, Search, X } from "lucide-react"
import { Virtuoso } from "react-virtuoso"
import { Button, Checkbox } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useTaskSearch } from "./useTaskSearch"
import { useGroupedTasks } from "./useGroupedTasks"
import TaskGroupItem from "./TaskGroupItem"
import TaskItem from "./TaskItem"
import { DeleteTaskDialog } from "./DeleteTaskDialog"
import { BatchDeleteTaskDialog } from "./BatchDeleteTaskDialog"
import { useExtensionState } from "@/context/ExtensionStateContext"

type HistoryPreviewProps = {
	focusRequest?: number
	expanded?: boolean
	onExpand?: () => void
	onClose?: () => void
}

const HistoryPreview = ({ focusRequest = 0, expanded = false, onExpand, onClose }: HistoryPreviewProps) => {
	const {
		tasks,
		searchQuery,
		setSearchQuery,
		sortOption,
		setSortOption,
		setLastNonRelevantSort,
		showAllWorkspaces,
		setShowAllWorkspaces,
	} = useTaskSearch(true)
	const { taskHistory } = useExtensionState()
	const { groups, flatTasks, toggleExpand, isSearchMode } = useGroupedTasks(tasks, searchQuery)
	const { t } = useAppTranslation()
	const headingId = useId()
	const searchRef = useRef<HTMLInputElement>(null)
	const [isManaging, setIsManaging] = useState(false)
	const [isSelectionMode, setIsSelectionMode] = useState(false)
	const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
	const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
	const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState(false)
	useEffect(() => {
		if (expanded) searchRef.current?.focus()
	}, [expanded, focusRequest])
	useEffect(() => {
		if (!expanded) {
			setSearchQuery("")
			setSortOption("newest")
			setShowAllWorkspaces(true)
			setIsManaging(false)
			setIsSelectionMode(false)
			setSelectedTaskIds([])
		}
	}, [expanded, setSearchQuery, setSortOption, setShowAllWorkspaces])
	// Filtering clears selection so hidden chats cannot be deleted accidentally.
	useEffect(() => {
		setSelectedTaskIds([])
	}, [searchQuery, showAllWorkspaces])
	const visibleIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks])
	const selectedIds = selectedTaskIds.filter((id) => visibleIds.has(id))
	const deleteSubtaskCount = useMemo(() => {
		if (!deleteTaskId) return 0
		const children = new Map<string, string[]>()
		for (const task of taskHistory) {
			if (task.parentTaskId) {
				const siblings = children.get(task.parentTaskId) ?? []
				siblings.push(task.id)
				children.set(task.parentTaskId, siblings)
			}
		}
		const descendants = new Set([deleteTaskId])
		const pending = [deleteTaskId]
		while (pending.length) {
			for (const id of children.get(pending.pop()!) ?? []) {
				if (!descendants.has(id)) {
					descendants.add(id)
					pending.push(id)
				}
			}
		}
		return descendants.size - 1
	}, [deleteTaskId, taskHistory])
	const toggleTaskSelection = (id: string, selected: boolean) =>
		setSelectedTaskIds((ids) => (selected ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id)))
	const rowProps = {
		variant: isManaging ? ("full" as const) : ("compact" as const),
		showWorkspace: isManaging && showAllWorkspaces,
		isSelectionMode,
		onToggleSelection: toggleTaskSelection,
		onDelete: setDeleteTaskId,
	}
	const selectClass =
		"min-w-0 rounded-md border-0 bg-transparent px-1 py-1 text-xs text-vscode-descriptionForeground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder [&>option]:bg-vscode-dropdown-background [&>option]:text-vscode-dropdown-foreground"
	if (!expanded) {
		return (
			<section className="flex w-full min-w-0 flex-col gap-1" aria-labelledby={headingId}>
				<div className="flex min-h-7 items-center justify-between gap-2">
					<h2 id={headingId} className="m-0 text-sm font-medium text-vscode-descriptionForeground">
						{t("history:chats")}
					</h2>
				</div>
				<div className="min-w-0" data-testid="history-preview-list">
					{groups.slice(0, 5).map((group) => (
						<TaskItem key={group.parent.id} item={group.parent} variant="compact" contained />
					))}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="ml-2 h-auto self-start px-0 py-1 text-xs font-normal text-vscode-descriptionForeground"
					data-testid="history-view-all"
					onClick={onExpand}
					aria-label={t("history:viewAllHistory", { count: tasks.length })}>
					{t("history:viewAllHistory", { count: tasks.length })}
				</Button>
			</section>
		)
	}
	return (
		<section className="flex w-full min-w-0 flex-col gap-2" aria-labelledby={headingId}>
			<div className="flex min-h-7 items-center justify-between gap-2">
				<h2 id={headingId} className="m-0 text-sm font-medium text-vscode-descriptionForeground">
					{t("history:chats")}
				</h2>
				{onClose && (
					<Button
						variant="ghost"
						size="icon"
						onClick={onClose}
						data-testid="history-close"
						aria-label={t("history:closeChats")}>
						<X />
					</Button>
				)}
			</div>
			<div
				className="surface-raised min-w-0 overflow-hidden rounded-2xl px-2 pb-2 pt-1"
				data-testid="history-preview-list">
				<div className="mx-1 flex min-w-0 items-center gap-2 border-b border-[var(--border-subtle)] px-1 py-2">
					<Search className="size-3.5 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
					<input
						ref={searchRef}
						type="search"
						value={searchQuery}
						aria-label={t("history:searchPlaceholder")}
						placeholder={t("history:searchPlaceholder")}
						data-testid="history-search-input"
						className="min-w-0 flex-1 border-0 bg-transparent text-sm text-vscode-foreground placeholder:text-vscode-descriptionForeground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
						onChange={(event) => {
							const value = event.target.value
							setSearchQuery(value)
							if (value && !searchQuery && sortOption !== "mostRelevant") {
								setLastNonRelevantSort(sortOption)
								setSortOption("mostRelevant")
							}
						}}
					/>
					{searchQuery && (
						<Button
							variant="ghost"
							size="icon"
							className="size-5"
							aria-label={t("history:clearSearch")}
							onClick={() => {
								setSearchQuery("")
								searchRef.current?.focus()
							}}>
							<X />
						</Button>
					)}
				</div>
				<div className="flex min-w-0 items-center justify-between gap-2 px-1 py-1">
					<select
						className={selectClass}
						aria-label={t("history:filterChats")}
						value={showAllWorkspaces ? "all" : "current"}
						onChange={(event) => setShowAllWorkspaces(event.target.value === "all")}>
						<option value="all">{t("history:allChats")}</option>
						<option value="current">{t("history:currentWorkspace")}</option>
					</select>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 shrink-0 text-vscode-descriptionForeground"
						aria-label={t("history:manageChats")}
						aria-expanded={isManaging}
						onClick={() => {
							setIsManaging(!isManaging)
							setIsSelectionMode(false)
							setSelectedTaskIds([])
						}}>
						<MoreHorizontal />
					</Button>
				</div>
				{isManaging && (
					<div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-1 pb-2">
						<select
							className={selectClass}
							aria-label={t("history:sort.prefix")}
							value={sortOption}
							onChange={(event) => setSortOption(event.target.value as typeof sortOption)}>
							{(["newest", "oldest", "mostExpensive", "mostTokens", "mostRelevant"] as const).map(
								(option) => (
									<option
										key={option}
										value={option}
										disabled={option === "mostRelevant" && !searchQuery}>
										{t(`history:sort.${option}`)}
									</option>
								),
							)}
						</select>
						<Button
							variant="ghost"
							size="sm"
							data-testid="toggle-selection-mode-button"
							onClick={() => {
								setIsSelectionMode(!isSelectionMode)
								setSelectedTaskIds([])
							}}>
							{t(isSelectionMode ? "history:exitSelection" : "history:selectionMode")}
						</Button>
					</div>
				)}
				{isSelectionMode && (
					<div className="flex flex-wrap items-center gap-2 px-2 py-2 text-xs">
						<Checkbox
							aria-label={t("history:selectAll")}
							checked={tasks.length > 0 && selectedIds.length === tasks.length}
							onCheckedChange={(checked) =>
								setSelectedTaskIds(checked === true ? tasks.map((task) => task.id) : [])
							}
						/>
						<span>{t("history:selectedItems", { selected: selectedIds.length, total: tasks.length })}</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={!selectedIds.length}
							onClick={() => setShowBatchDeleteDialog(true)}>
							{t("history:deleteSelected")}
						</Button>
					</div>
				)}
				{tasks.length === 0 ? (
					<p className="m-0 px-2 py-7 text-center text-sm text-vscode-descriptionForeground" role="status">
						{t(searchQuery ? "history:noResults" : "history:noChats")}
					</p>
				) : (isSearchMode && flatTasks ? flatTasks.length : groups.length) <= 10 ? (
					<div
						className="overflow-y-auto"
						style={{ maxHeight: "min(280px, 40vh)" }}
						data-testid="history-expanded-list">
						{isSearchMode && flatTasks
							? flatTasks.map((item) => (
									<TaskItem
										key={item.id}
										{...rowProps}
										item={item}
										isSelected={selectedIds.includes(item.id)}
										contained
										className={isManaging ? "my-1" : undefined}
									/>
								))
							: groups.map((group) => (
									<TaskGroupItem
										key={group.parent.id}
										{...rowProps}
										group={group}
										isSelected={selectedIds.includes(group.parent.id)}
										onToggleExpand={() => toggleExpand(group.parent.id)}
										onToggleSubtaskExpand={toggleExpand}
										className={isManaging ? "my-1" : undefined}
									/>
								))}
					</div>
				) : isSearchMode && flatTasks ? (
					<Virtuoso
						style={{ height: "min(280px, 40vh)" }}
						data={flatTasks}
						data-testid="virtuoso-container"
						computeItemKey={(_index, item) => item.id}
						itemContent={(_index, item) => (
							<TaskItem
								{...rowProps}
								item={item}
								isSelected={selectedIds.includes(item.id)}
								contained
								className={isManaging ? "my-1" : undefined}
							/>
						)}
					/>
				) : (
					<Virtuoso
						style={{ height: "min(280px, 40vh)" }}
						data={groups}
						data-testid="virtuoso-container"
						computeItemKey={(_index, group) => group.parent.id}
						itemContent={(_index, group) => (
							<TaskGroupItem
								{...rowProps}
								group={group}
								isSelected={selectedIds.includes(group.parent.id)}
								onToggleExpand={() => toggleExpand(group.parent.id)}
								onToggleSubtaskExpand={toggleExpand}
								className={isManaging ? "my-1" : undefined}
							/>
						)}
					/>
				)}
			</div>
			{deleteTaskId && (
				<DeleteTaskDialog
					taskId={deleteTaskId}
					subtaskCount={deleteSubtaskCount}
					open
					onOpenChange={(open) => {
						if (!open) setDeleteTaskId(null)
					}}
				/>
			)}
			{showBatchDeleteDialog && (
				<BatchDeleteTaskDialog
					taskIds={selectedIds}
					open
					onOpenChange={(open) => {
						if (!open) {
							setShowBatchDeleteDialog(false)
							setSelectedTaskIds([])
							setIsSelectionMode(false)
						}
					}}
				/>
			)}
		</section>
	)
}
export default memo(HistoryPreview)
