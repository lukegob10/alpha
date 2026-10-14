import { memo, useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowRight, MoreHorizontal, Search, Trash2, X } from "lucide-react"
import { Virtuoso } from "react-virtuoso"
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useTaskSearch } from "./useTaskSearch"
import { useGroupedTasks } from "./useGroupedTasks"
import TaskGroupItem from "./TaskGroupItem"
import TaskItem from "./TaskItem"
import { DeleteTaskDialog } from "./DeleteTaskDialog"
import { BatchDeleteTaskDialog } from "./BatchDeleteTaskDialog"
import { useExtensionState } from "@/context/ExtensionStateContext"

const sortOptions = ["newest", "oldest", "mostExpensive", "mostTokens", "mostRelevant"] as const

type HistoryPreviewProps = {
	focusRequest?: number
	expanded?: boolean
	onExpand?: () => void
	onClose?: () => void
}

const HistoryPreview = ({ focusRequest = 0, expanded = false, onExpand, onClose }: HistoryPreviewProps) => {
	const { tasks, searchQuery, setSearchQuery, sortOption, setSortOption, setLastNonRelevantSort } = useTaskSearch()
	const { taskHistory, cwd } = useExtensionState()
	const { groups, flatTasks, toggleExpand, isSearchMode } = useGroupedTasks(tasks, searchQuery)
	const { t } = useAppTranslation()
	const headingId = useId()
	const searchRef = useRef<HTMLInputElement>(null)
	const selectionButtonRef = useRef<HTMLButtonElement>(null)
	const deleteSelectionButtonRef = useRef<HTMLButtonElement>(null)
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
			setIsSelectionMode(false)
			setSelectedTaskIds([])
		}
	}, [expanded, setSearchQuery, setSortOption])
	// Filtering clears selection so hidden chats cannot be deleted accidentally.
	useEffect(() => {
		setSelectedTaskIds([])
	}, [searchQuery])
	useEffect(() => {
		setSearchQuery("")
		setSelectedTaskIds([])
		setDeleteTaskId(null)
		setShowBatchDeleteDialog(false)
	}, [cwd, setSearchQuery])
	const visibleIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks])
	const selectedIds = useMemo(() => selectedTaskIds.filter((id) => visibleIds.has(id)), [selectedTaskIds, visibleIds])
	const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
	const allSelected = tasks.length > 0 && selectedIds.length === tasks.length
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
		variant: "compact" as const,
		isSelectionMode,
		onToggleSelection: toggleTaskSelection,
		onDelete: setDeleteTaskId,
	}
	const restoreHistoryFocus = (event: Event) => {
		event.preventDefault()
		const target = isSelectionMode
			? (deleteSelectionButtonRef.current ?? selectionButtonRef.current)
			: searchRef.current
		target?.focus()
	}
	const historyHeading = (
		<div className="new-task-history-heading relative pr-9">
			<h2 id={headingId} className="m-0 font-medium">
				{t("history:chats")}
			</h2>
			{expanded && onClose && (
				<Button
					variant="ghost"
					size="icon"
					className="absolute top-1/2 right-0 -translate-y-1/2"
					onClick={onClose}
					data-testid="history-close"
					aria-label={t("history:closeChats")}>
					<X />
				</Button>
			)}
		</div>
	)
	if (!expanded) {
		return (
			<section className="new-task-history flex w-full min-w-0 flex-col" aria-labelledby={headingId}>
				{historyHeading}
				<div className="new-task-history-list surface-raised min-w-0" data-testid="history-preview-list">
					{groups.slice(0, 5).map((group) => (
						<TaskItem
							key={group.parent.id}
							item={group.parent}
							variant="compact"
							contained
							className="new-task-history-row"
						/>
					))}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="mt-2 mr-1 h-auto shrink-0 self-end px-0 py-1 text-xs font-normal text-vscode-textLink-foreground"
					data-testid="history-view-all"
					onClick={onExpand}
					aria-label={t("history:viewAllHistory", { count: tasks.length })}>
					{t("history:viewAllHistory", { count: tasks.length })}
					<ArrowRight className="size-3" aria-hidden="true" />
				</Button>
			</section>
		)
	}
	return (
		<section className="new-task-history flex w-full min-w-0 flex-col" aria-labelledby={headingId}>
			{historyHeading}
			<div
				className="new-task-history-list new-task-history-compact surface-raised min-w-0 overflow-hidden"
				data-testid="history-preview-list">
				<div className="flex min-w-0 items-center gap-2 border-b border-[var(--border-subtle)] py-2">
					<Search className="size-3.5 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
					<input
						ref={searchRef}
						type="search"
						value={searchQuery}
						aria-label={t("history:searchPlaceholder")}
						placeholder={t("history:searchPlaceholder")}
						data-testid="history-search-input"
						className="new-task-history-search min-w-0 flex-1 border-0 bg-transparent text-base leading-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
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
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-1">
					{isSelectionMode ? (
						<div className="flex min-w-0 items-center gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-1.5 text-xs font-normal text-vscode-descriptionForeground"
								disabled={!tasks.length}
								onClick={() => setSelectedTaskIds(allSelected ? [] : tasks.map((task) => task.id))}>
								{t(allSelected ? "history:deselectAll" : "history:selectAll")}
							</Button>
							<span className="sr-only" aria-live="polite" aria-atomic="true">
								{t("history:selectedCount", { count: selectedIds.length })}
							</span>
						</div>
					) : (
						<span className="truncate text-xs text-vscode-descriptionForeground">
							{t("history:currentWorkspace")}
						</span>
					)}
					<div className="ml-auto flex shrink-0 items-center gap-1">
						{isSelectionMode && selectedIds.length > 0 && (
							<Button
								ref={deleteSelectionButtonRef}
								variant="ghost"
								size="sm"
								className="h-7 px-1.5 text-xs font-normal text-vscode-errorForeground hover:text-vscode-errorForeground"
								onClick={() => setShowBatchDeleteDialog(true)}>
								<Trash2 className="size-3.5" aria-hidden="true" />
								{t("history:deleteSelectedCount", { count: selectedIds.length })}
							</Button>
						)}
						<Button
							ref={selectionButtonRef}
							variant="ghost"
							size="sm"
							className="h-7 px-1.5 text-xs font-normal text-vscode-descriptionForeground"
							data-testid="toggle-selection-mode-button"
							aria-label={t(isSelectionMode ? "history:exitSelection" : "history:selectionMode")}
							aria-pressed={isSelectionMode}
							disabled={!isSelectionMode && !tasks.length}
							onClick={() => {
								setIsSelectionMode((selected) => !selected)
								setSelectedTaskIds([])
							}}>
							{t(isSelectionMode ? "history:done" : "history:select")}
						</Button>
						{!isSelectionMode && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-7 text-vscode-descriptionForeground"
										aria-label={t("history:sortChats")}>
										<MoreHorizontal aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuLabel>{t("history:sort.prefix")}</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										value={sortOption}
										onValueChange={(value) => {
											const option = sortOptions.find((option) => option === value)
											if (option) setSortOption(option)
										}}>
										{sortOptions.map((option) => (
											<DropdownMenuRadioItem
												key={option}
												value={option}
												disabled={option === "mostRelevant" && !searchQuery}>
												{t(`history:sort.${option}`)}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				</div>
				{tasks.length === 0 ? (
					<p className="m-0 px-2 py-7 text-center text-sm text-vscode-descriptionForeground" role="status">
						{t(searchQuery ? "history:noResults" : "history:noChats")}
					</p>
				) : (isSearchMode && flatTasks ? flatTasks.length : groups.length) <= 10 ? (
					<div
						className="new-task-history-items overflow-y-auto"
						style={{ maxHeight: "min(280px, 40vh)" }}
						data-testid="history-expanded-list">
						{isSearchMode && flatTasks
							? flatTasks.map((item) => (
									<TaskItem
										key={item.id}
										{...rowProps}
										item={item}
										isSelected={selectedIdSet.has(item.id)}
										contained
										className="new-task-history-row"
									/>
								))
							: groups.map((group) => (
									<TaskGroupItem
										key={group.parent.id}
										{...rowProps}
										group={group}
										isSelected={selectedIdSet.has(group.parent.id)}
										selectedTaskIds={selectedIdSet}
										onToggleExpand={() => toggleExpand(group.parent.id)}
										onToggleSubtaskExpand={toggleExpand}
										className="new-task-history-group"
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
								isSelected={selectedIdSet.has(item.id)}
								contained
								className="new-task-history-row"
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
								isSelected={selectedIdSet.has(group.parent.id)}
								selectedTaskIds={selectedIdSet}
								onToggleExpand={() => toggleExpand(group.parent.id)}
								onToggleSubtaskExpand={toggleExpand}
								className="new-task-history-group"
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
					onCloseAutoFocus={restoreHistoryFocus}
					onOpenChange={(open) => {
						if (!open) setDeleteTaskId(null)
					}}
				/>
			)}
			{showBatchDeleteDialog && (
				<BatchDeleteTaskDialog
					taskIds={selectedIds}
					open
					onConfirm={() => setSelectedTaskIds([])}
					onCloseAutoFocus={restoreHistoryFocus}
					onOpenChange={(open) => {
						if (!open) {
							setShowBatchDeleteDialog(false)
						}
					}}
				/>
			)}
		</section>
	)
}
export default memo(HistoryPreview)
