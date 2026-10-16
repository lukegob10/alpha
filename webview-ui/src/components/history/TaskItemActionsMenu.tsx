import { forwardRef, useContext, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react"
import { Copy, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { getTaskDisplayName, type HistoryItem } from "@alpha-code/types"
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { copyToClipboard } from "@/utils/clipboard"
import { vscode } from "@/utils/vscode"
import { RenameTaskDialog } from "./RenameTaskDialog"
import { DeleteTaskDialog } from "./DeleteTaskDialog"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { countTaskDescendants } from "./types"

type TaskItemActionsMenuProps = {
	item: HistoryItem
	onDelete?: (taskId: string) => void
	hideTrigger?: boolean
	focusReturnRef?: RefObject<HTMLElement>
}

export type TaskItemActionsMenuHandle = { openMenu: () => void }

const TaskItemActionsMenu = forwardRef<TaskItemActionsMenuHandle, TaskItemActionsMenuProps>(
	({ item, onDelete, hideTrigger, focusReturnRef }, ref) => {
		const { t } = useAppTranslation()
		const dialogRequested = useRef(false)
		const triggerRef = useRef<HTMLButtonElement>(null)
		const [open, setOpen] = useState(false)
		const [renameOpen, setRenameOpen] = useState(false)
		const [deleteOpen, setDeleteOpen] = useState(false)
		const taskHistory = useContext(ExtensionStateContext)?.taskHistory
		const subtaskCount = useMemo(
			() => (deleteOpen && taskHistory ? countTaskDescendants(taskHistory, item.id) : 0),
			[deleteOpen, taskHistory, item.id],
		)
		useImperativeHandle(ref, () => ({ openMenu: () => setOpen(true) }), [])
		const restoreFocus = (event: Event) => {
			event.preventDefault()
			const target = focusReturnRef?.current ?? triggerRef.current
			target?.focus()
		}

		return (
			<div className="flex shrink-0" onClick={(event) => event.stopPropagation()}>
				<DropdownMenu open={open} onOpenChange={setOpen}>
					<DropdownMenuTrigger asChild>
						<Button
							ref={triggerRef}
							tabIndex={hideTrigger ? -1 : undefined}
							aria-hidden={hideTrigger || undefined}
							variant="ghost"
							size="icon"
							className={
								hideTrigger
									? "sr-only"
									: "history-chat-actions size-5 p-0 text-vscode-descriptionForeground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
							}
							aria-label={t("history:chatActions", { task: getTaskDisplayName(item) })}>
							<MoreHorizontal className="size-3.5" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						onCloseAutoFocus={(event) => {
							// A requested dialog takes focus after the menu closes.
							if (dialogRequested.current) event.preventDefault()
							else if (focusReturnRef?.current) {
								event.preventDefault()
								focusReturnRef.current.focus()
							}
							dialogRequested.current = false
						}}>
						<DropdownMenuItem
							onSelect={() => {
								dialogRequested.current = true
								setRenameOpen(true)
							}}>
							<Pencil aria-hidden="true" />
							{t("history:renameChat")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copyToClipboard(item.task)}>
							<Copy aria-hidden="true" />
							{t("history:copyPrompt")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => vscode.postMessage({ type: "exportTaskWithId", text: item.id })}>
							<Download aria-hidden="true" />
							{t("history:exportTask")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-vscode-errorForeground focus:text-vscode-errorForeground"
							onSelect={() => {
								dialogRequested.current = true
								if (onDelete) onDelete(item.id)
								else setDeleteOpen(true)
							}}>
							<Trash2 aria-hidden="true" />
							{t("history:deleteTask")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				{renameOpen && (
					<RenameTaskDialog item={item} open onOpenChange={setRenameOpen} onCloseAutoFocus={restoreFocus} />
				)}
				{deleteOpen && (
					<DeleteTaskDialog
						taskId={item.id}
						subtaskCount={subtaskCount}
						open
						onOpenChange={setDeleteOpen}
						onCloseAutoFocus={restoreFocus}
					/>
				)}
			</div>
		)
	},
)
TaskItemActionsMenu.displayName = "TaskItemActionsMenu"

export default TaskItemActionsMenu
