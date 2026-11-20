import { useCallback } from "react"

import { Button, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { useCopyToClipboard } from "@/utils/clipboard"

type CopyButtonProps = {
	itemTask: string
}

export const CopyButton = ({ itemTask }: CopyButtonProps) => {
	const { showCopyFeedback: isCopied, copyWithFeedback } = useCopyToClipboard()
	const { t } = useAppTranslation()

	const onCopy = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()

			if (!isCopied && itemTask) {
				void copyWithFeedback(itemTask)
			}
		},
		[isCopied, copyWithFeedback, itemTask],
	)

	return (
		<StandardTooltip content={t("history:copyPrompt")}>
			<Button
				variant="ghost"
				size="icon"
				onClick={onCopy}
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				data-testid="copy-prompt-button">
				<span className={cn("codicon scale-80", { "codicon-check": isCopied, "codicon-copy": !isCopied })} />
			</Button>
		</StandardTooltip>
	)
}
