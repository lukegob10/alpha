import type { ReactNode } from "react"
import { Check, Copy, Edit, RotateCcw, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useCopyToClipboard } from "@/utils/clipboard"
import { LucideIconButton } from "./LucideIconButton"

interface MessageActionsProps {
	text: string
	onEdit?: () => void
	onRestart?: () => void
	onDelete?: () => void
	disabled?: boolean
	children?: ReactNode
}

export function MessageActions({ text, onEdit, onRestart, onDelete, disabled, children }: MessageActionsProps) {
	const { t } = useTranslation()
	const { copyWithFeedback, showCopyFeedback } = useCopyToClipboard()
	return (
		<div className="mt-1 flex flex-wrap items-center gap-1 text-vscode-descriptionForeground">
			<LucideIconButton
				icon={showCopyFeedback ? Check : Copy}
				title={t(showCopyFeedback ? "chat:messageActions.copied" : "chat:messageActions.copy")}
				onClick={(event) => void copyWithFeedback(text, event)}
				disabled={!text}
			/>
			{onEdit && (
				<LucideIconButton
					icon={Edit}
					title={t("chat:messageActions.edit")}
					onClick={onEdit}
					disabled={disabled}
				/>
			)}
			{onRestart && (
				<LucideIconButton
					icon={RotateCcw}
					title={t("chat:messageActions.restart")}
					onClick={onRestart}
					disabled={disabled}
				/>
			)}
			{onDelete && (
				<LucideIconButton
					icon={Trash2}
					title={t("common:confirmation.deleteMessage")}
					onClick={onDelete}
					disabled={disabled}
				/>
			)}
			{children}
		</div>
	)
}
