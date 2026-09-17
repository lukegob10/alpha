import { useTranslation } from "react-i18next"
import CodebaseSearchResult from "./CodebaseSearchResult"
import { SearchResultsList } from "./SearchResultsList"

export interface CodebaseSearchMatch {
	filePath: string
	score: number
	startLine: number
	endLine: number
	context?: string
	codeChunk: string
}

interface CodebaseSearchResultsDisplayProps {
	results: CodebaseSearchMatch[]
	isExpanded: boolean
	onToggleExpand: () => void
}

export default function CodebaseSearchResultsDisplay({
	results,
	isExpanded: expanded,
	onToggleExpand,
}: CodebaseSearchResultsDisplayProps) {
	const { t } = useTranslation("chat")
	const label = t("codebaseSearch.didSearch", { count: results.length })

	if (!results.length) {
		return <div className="pl-6 text-sm text-vscode-descriptionForeground">{label}</div>
	}

	return (
		<SearchResultsList label={label} isExpanded={expanded} onToggleExpand={onToggleExpand}>
			{expanded &&
				results.map((result, index) => (
					<li key={`${result.filePath}:${result.startLine}:${result.endLine}:${index}`}>
						<CodebaseSearchResult
							filePath={result.filePath}
							startLine={result.startLine}
							endLine={result.endLine}
							context={result.context}
							snippet={result.codeChunk}
						/>
					</li>
				))}
		</SearchResultsList>
	)
}
