import { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"
import { FoldVertical } from "lucide-react"

import type { ContextCondense } from "@alpha-code/types"

import { Markdown } from "../Markdown"

interface CondensationResultRowProps {
	data: ContextCondense
}

/**
 * Displays the result of a successful context condensation operation.
 * Shows token reduction, cost, and an expandable summary section.
 */
export function CondensationResultRow({ data }: CondensationResultRowProps) {
	const { t } = useTranslation()
	const [isExpanded, setIsExpanded] = useState(false)

	const { cost, prevContextTokens, newContextTokens, summary } = data

	// Handle null/undefined token values to prevent crashes
	const prevTokens = prevContextTokens ?? 0
	const newTokens = newContextTokens ?? 0
	const displayCost = cost ?? 0
	if (data.outcome === "unchanged") {
		return (
			<div className="mb-2 flex flex-wrap items-center gap-2 text-vscode-descriptionForeground" role="status">
				<FoldVertical size={16} aria-hidden="true" />
				<span>{t("chat:contextManagement.condensation.unchanged")}</span>
				<span className="text-sm">
					{newTokens.toLocaleString()} {t("chat:contextManagement.tokens")}
				</span>
				{displayCost > 0 && <VSCodeBadge>${displayCost.toFixed(2)}</VSCodeBadge>}
			</div>
		)
	}

	return (
		<div className="mb-2">
			<div
				className="flex items-center justify-between cursor-pointer select-none"
				onClick={() => setIsExpanded(!isExpanded)}>
				<div className="flex items-center gap-2 flex-grow">
					<FoldVertical size={16} className="text-vscode-foreground" />
					<span className="font-bold text-vscode-foreground">
						{t("chat:contextManagement.condensation.title")}
					</span>
					<span className="text-vscode-descriptionForeground text-sm">
						{prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
						{t("chat:contextManagement.tokens")}
					</span>
					<VSCodeBadge className={displayCost > 0 ? "opacity-100" : "opacity-0"}>
						${displayCost.toFixed(2)}
					</VSCodeBadge>
				</div>
				<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"}`}></span>
			</div>

			{isExpanded && (
				<div className="mt-2 ml-0 p-4 bg-vscode-editor-background rounded text-vscode-foreground text-sm">
					<Markdown markdown={summary} />
				</div>
			)}
		</div>
	)
}
