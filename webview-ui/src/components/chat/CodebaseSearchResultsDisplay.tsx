import { useTranslation } from "react-i18next"
import type { CodebaseSearchDiagnostics, CodebaseSearchMatch } from "@alpha-code/types"
import CodebaseSearchResult from "./CodebaseSearchResult"
import { SearchResultsList } from "./SearchResultsList"

export type { CodebaseSearchMatch } from "@alpha-code/types"

interface CodebaseSearchResultsDisplayProps {
	results: CodebaseSearchMatch[]
	diagnostics?: CodebaseSearchDiagnostics
	isExpanded: boolean
	onToggleExpand: () => void
}

export default function CodebaseSearchResultsDisplay({
	results,
	diagnostics,
	isExpanded: expanded,
	onToggleExpand,
}: CodebaseSearchResultsDisplayProps) {
	const { t } = useTranslation("chat")
	const label = t("codebaseSearch.didSearch", { count: results.length })
	const partial = [diagnostics?.semanticStatus, diagnostics?.lexicalStatus, diagnostics?.freshStatus].some(
		(status) => status && status !== "complete",
	)
	const incompleteIndex = diagnostics?.indexFreshness && diagnostics.indexFreshness !== "current"
	const coverageNote =
		partial || incompleteIndex ? (
			<p className="pl-6 text-xs text-vscode-descriptionForeground">{t("codebaseSearch.partialCoverageNote")}</p>
		) : null

	if (!results.length) {
		return (
			<>
				<div className="pl-6 text-sm text-vscode-descriptionForeground">{label}</div>
				{coverageNote}
			</>
		)
	}

	return (
		<>
			{coverageNote}
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
			{expanded && diagnostics && (diagnostics.skippedBudget > 0 || diagnostics.remainingCandidates > 0) && (
				<p className="pl-6 text-xs text-vscode-descriptionForeground">
					{t(
						diagnostics.skippedBudget > 0
							? "codebaseSearch.contextBudgetNote"
							: "codebaseSearch.resultLimitNote",
					)}
				</p>
			)}
		</>
	)
}
