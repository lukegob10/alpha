import { memo, useEffect, useRef, useState } from "react"
import { PanelsTopLeft, Pencil } from "lucide-react"
import { getTaskDisplayName, type HistoryItem } from "@alpha-code/types"

import { Button, Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import HistoryPreview from "./HistoryPreview"
import { RenameTaskDialog } from "./RenameTaskDialog"
import TaskItemActionsMenu, { type TaskItemActionsMenuHandle } from "./TaskItemActionsMenu"
import { cn } from "@/lib/utils"

export type ChatHistorySwitcherProps = {
	currentTask?: HistoryItem
	onOpenTask: (taskId: string) => void
	onViewAll?: () => void
	className?: string
	isVisible?: boolean
}

/** Ephemeral navigation UI; opening and metadata changes remain owned by the extension. */
function ChatHistorySwitcher({
	currentTask,
	onOpenTask,
	onViewAll,
	className,
	isVisible = true,
}: ChatHistorySwitcherProps) {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [renameOpen, setRenameOpen] = useState(false)
	const titleRef = useRef<HTMLButtonElement>(null)
	const menuRef = useRef<TaskItemActionsMenuHandle>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	const name = currentTask ? getTaskDisplayName(currentTask) : t("history:chats")
	useEffect(() => {
		setOpen(false)
		setRenameOpen(false)
	}, [currentTask?.id, isVisible])

	// ChatView remains mounted behind secondary views; portals must follow its visibility.
	if (!isVisible) return null

	return (
		<div className={cn("chat-history-switcher flex min-w-0 flex-1 items-center gap-1", className)}>
			<Popover open={open} onOpenChange={setOpen}>
				<StandardTooltip content={t("history:switchChat")}>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6 shrink-0 rounded-md p-1"
							aria-label={t("history:switchChat")}>
							<PanelsTopLeft className="size-4" aria-hidden="true" />
						</Button>
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					ref={contentRef}
					align="start"
					className="w-[min(356px,calc(100vw-24px))] p-2"
					aria-label={t("history:switchChat")}
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						queueMicrotask(() =>
							contentRef.current?.querySelector<HTMLElement>("[data-testid^=task-item-]")?.focus(),
						)
					}}
					onInteractOutside={(event) => {
						// Row action dialogs and menus are portalled outside this popover.
						if (
							event.target instanceof Element &&
							event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
						)
							event.preventDefault()
					}}
					onKeyDown={(event) => {
						if (
							!(event.target instanceof HTMLElement) ||
							!event.target.dataset.testid?.startsWith("task-item-")
						)
							return
						const rows = Array.from(
							contentRef.current?.querySelectorAll<HTMLElement>('[data-testid^="task-item-"]') ?? [],
						)
						const current = rows.indexOf(event.target)
						const next =
							event.key === "Home"
								? 0
								: event.key === "End"
									? rows.length - 1
									: event.key === "ArrowDown"
										? (current + 1) % rows.length
										: event.key === "ArrowUp"
											? (current + rows.length - 1) % rows.length
											: -1
						if (next >= 0) {
							event.preventDefault()
							rows[next]?.focus()
						}
					}}>
					<div data-chat-switcher>
						<HistoryPreview
							onOpenTask={(taskId) => {
								setOpen(false)
								onOpenTask(taskId)
							}}
							onExpand={() => {
								setOpen(false)
								onViewAll?.()
							}}
						/>
					</div>
				</PopoverContent>
			</Popover>
			{currentTask && (
				<>
					<StandardTooltip content={t("history:renameChatNamed", { task: name })}>
						<button
							ref={titleRef}
							type="button"
							className="chat-history-current-title min-w-0 flex-1"
							aria-label={t("history:renameChatNamed", { task: name })}
							onClick={() => setRenameOpen(true)}
							onContextMenu={(event) => {
								event.preventDefault()
								menuRef.current?.openMenu()
							}}
							onKeyDown={(event) => {
								if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
									event.preventDefault()
									menuRef.current?.openMenu()
								}
							}}>
							<span className="min-w-0 truncate">{name}</span>
							<Pencil className="chat-history-rename-hint size-3 shrink-0" aria-hidden="true" />
						</button>
					</StandardTooltip>
					<TaskItemActionsMenu
						key={currentTask.id}
						ref={menuRef}
						item={currentTask}
						hideTrigger
						focusReturnRef={titleRef}
					/>
					{renameOpen && (
						<RenameTaskDialog
							item={currentTask}
							open
							onOpenChange={setRenameOpen}
							onCloseAutoFocus={(event) => {
								event.preventDefault()
								titleRef.current?.focus()
							}}
						/>
					)}
				</>
			)}
		</div>
	)
}

export default memo(ChatHistorySwitcher)
