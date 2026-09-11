import React, { memo } from "react"
import { SquareArrowOutUpRight } from "lucide-react"

import { vscode } from "@src/utils/vscode"
import { hasComplexMarkdown } from "@src/utils/markdown"
import { StandardTooltip } from "@src/components/ui"

interface OpenMarkdownPreviewButtonProps {
	markdown: string | undefined
	className?: string
}

export const OpenMarkdownPreviewButton = memo(({ markdown, className }: OpenMarkdownPreviewButtonProps) => {
	if (!hasComplexMarkdown(markdown)) {
		return null
	}

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation()
		if (markdown) {
			vscode.postMessage({
				type: "openMarkdownPreview",
				text: markdown,
			})
		}
	}

	return (
		<StandardTooltip content="Open in preview">
			<button
				type="button"
				onClick={handleClick}
				className={`flex size-6 items-center justify-center rounded-md text-vscode-descriptionForeground hover:bg-vscode-list-hoverBackground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder cursor-pointer ${className ?? ""}`}
				aria-label="Open markdown in preview">
				<SquareArrowOutUpRight className="w-4 h-4" />
			</button>
		</StandardTooltip>
	)
})
