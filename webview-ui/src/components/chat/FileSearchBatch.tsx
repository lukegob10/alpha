import { useId, useState } from "react"
import { ChevronRight, Search } from "lucide-react"
import type { ClineSayTool } from "@alpha-code/types"
import { cn } from "@/lib/utils"
import CodeBlock from "../common/CodeBlock"
import { SearchResultsList } from "./SearchResultsList"

type FileSearch = NonNullable<ClineSayTool["batchSearches"]>[number]

interface FileSearchBatchProps {
	searches: FileSearch[]
	label: string
	isExpanded: boolean
	onToggleExpand: () => void
}

function FileSearchItem({ search }: { search: FileSearch }) {
	const [isExpanded, setIsExpanded] = useState(false)
	const detailsId = useId()
	const path = search.path + (search.filePattern ? `/(${search.filePattern})` : "")
	return (
		<li className="min-w-0">
			<button
				type="button"
				title={path}
				aria-expanded={isExpanded}
				aria-controls={detailsId}
				onClick={() => setIsExpanded((value) => !value)}
				className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-vscode-focusBorder">
				<Search className="size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
				<ChevronRight
					className={cn("size-3.5 shrink-0 text-vscode-descriptionForeground", isExpanded && "rotate-90")}
					aria-hidden="true"
				/>
			</button>
			<div id={detailsId} hidden={!isExpanded} className="mb-2 ml-8 mr-2 min-w-0">
				{isExpanded && (
					<>
						<code
							className="mb-2 block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]"
							style={{ color: "var(--vscode-foreground)" }}>
							{search.regex}
						</code>
						{search.content && <CodeBlock source={search.content} language="shellsession" />}
					</>
				)}
			</div>
		</li>
	)
}

export function FileSearchBatch({ searches, ...disclosureProps }: FileSearchBatchProps) {
	return (
		<SearchResultsList {...disclosureProps}>
			{searches.map((search, index) => (
				<FileSearchItem
					key={`${search.path}:${search.regex}:${search.filePattern ?? ""}:${index}`}
					search={search}
				/>
			))}
		</SearchResultsList>
	)
}
