import { useRef } from "react"
import { Copy, Download, MoreHorizontal, Trash2 } from "lucide-react"
import type { HistoryItem } from "@alpha-code/types"
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

type TaskItemActionsMenuProps = {
	item: HistoryItem
	onDelete: (taskId: string) => void
}

const TaskItemActionsMenu = ({ item, onDelete }: TaskItemActionsMenuProps) => {
	const { t } = useAppTranslation()
	const deleteRequested = useRef(false)

	return (
		<div className="flex shrink-0" onClick={(event) => event.stopPropagation()}>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="history-chat-actions size-5 p-0 text-vscode-descriptionForeground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
						aria-label={t("history:chatActions", { task: item.task })}>
						<MoreHorizontal className="size-3.5" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					onCloseAutoFocus={(event) => {
						// The confirmation dialog owns focus while a delete request is open.
						if (deleteRequested.current) event.preventDefault()
						deleteRequested.current = false
					}}>
					<DropdownMenuItem onSelect={() => void copyToClipboard(item.task)}>
						<Copy aria-hidden="true" />
						{t("history:copyPrompt")}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => vscode.postMessage({ type: "exportTaskWithId", text: item.id })}>
						<Download aria-hidden="true" />
						{t("history:exportTask")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						className="text-vscode-errorForeground focus:text-vscode-errorForeground"
						onSelect={() => {
							deleteRequested.current = true
							onDelete(item.id)
						}}>
						<Trash2 aria-hidden="true" />
						{t("history:deleteTask")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

export default TaskItemActionsMenu
