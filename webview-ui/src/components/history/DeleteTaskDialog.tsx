import { useCallback, type ComponentProps } from "react"
import { AlertDialogProps } from "@radix-ui/react-alert-dialog"

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { vscode } from "@/utils/vscode"

interface DeleteTaskDialogProps extends AlertDialogProps {
	taskId: string
	/** Number of subtasks that will also be deleted (for cascade delete warning) */
	subtaskCount?: number
	onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"]
}

export const DeleteTaskDialog = ({ taskId, subtaskCount = 0, onCloseAutoFocus, ...props }: DeleteTaskDialogProps) => {
	const { t } = useAppTranslation()

	const { onOpenChange } = props

	const onDelete = useCallback(() => {
		if (taskId) {
			vscode.postMessage({ type: "deleteTaskWithId", text: taskId })
			onOpenChange?.(false)
		}
	}, [taskId, onOpenChange])

	// Determine the message to show
	const message =
		subtaskCount > 0 ? t("history:deleteWithSubtasks", { count: subtaskCount }) : t("history:deleteTaskMessage")

	return (
		<AlertDialog {...props}>
			<AlertDialogContent onEscapeKeyDown={() => onOpenChange?.(false)} onCloseAutoFocus={onCloseAutoFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("history:deleteTask")}</AlertDialogTitle>
					<AlertDialogDescription>{message}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="secondary">{t("history:cancel")}</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="destructive" onClick={onDelete}>
							{t("history:delete")}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
