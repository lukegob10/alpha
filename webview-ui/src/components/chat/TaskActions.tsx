import { useState } from "react"
import { useTranslation } from "react-i18next"

import type { HistoryItem } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"

import { DeleteTaskDialog } from "../history/DeleteTaskDialog"
import { DownloadIcon, Trash2Icon } from "lucide-react"
import { LucideIconButton } from "./LucideIconButton"

interface TaskActionsProps {
	item?: HistoryItem
	buttonsDisabled: boolean
}

export const TaskActions = ({ item, buttonsDisabled }: TaskActionsProps) => {
	const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
	const { t } = useTranslation()

	return (
		<div className="flex flex-row items-center -ml-0.5 mt-1 gap-1">
			<LucideIconButton
				icon={DownloadIcon}
				title={t("chat:task.export")}
				onClick={() => vscode.postMessage({ type: "exportCurrentTask", taskId: item?.id })}
			/>

			{!!item?.size && item.size > 0 && (
				<>
					<LucideIconButton
						icon={Trash2Icon}
						title={t("chat:task.delete")}
						disabled={buttonsDisabled}
						onClick={(e) => {
							e.stopPropagation()
							if (e.shiftKey) {
								vscode.postMessage({ type: "deleteTaskWithId", text: item.id })
							} else {
								setDeleteTaskId(item.id)
							}
						}}
					/>
					{deleteTaskId && (
						<DeleteTaskDialog
							taskId={deleteTaskId}
							onOpenChange={(open) => !open && setDeleteTaskId(null)}
							open
						/>
					)}
				</>
			)}
		</div>
	)
}
