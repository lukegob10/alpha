import { Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ActivityStep } from "./ActivityStep"

interface CodebaseSearchActivityProps {
	query?: string
	path?: string
	isExpanded: boolean
	onToggleExpand: () => void
}

export function CodebaseSearchActivity({ query, path, isExpanded, onToggleExpand }: CodebaseSearchActivityProps) {
	const { t } = useTranslation("chat")
	return (
		<ActivityStep
			isExpanded={isExpanded}
			onToggleExpand={onToggleExpand}
			summary={
				<>
					<Search className="size-4 shrink-0" aria-hidden="true" />
					<span className="font-normal">{t("codebaseSearch.title")}</span>
				</>
			}>
			<div className="ml-6 min-w-0 border-l border-[var(--vscode-contrastBorder,var(--vscode-panel-border))] py-1 pl-3">
				<p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-vscode-foreground [overflow-wrap:anywhere]">
					{query}
				</p>
				{path && (
					<p className="mb-0 mt-2 break-words font-mono text-xs text-vscode-descriptionForeground [overflow-wrap:anywhere]">
						{path}
					</p>
				)}
			</div>
		</ActivityStep>
	)
}
