import { useId, type ReactNode } from "react"
import { ChevronRight, Files } from "lucide-react"
import { cn } from "@/lib/utils"

interface SearchResultsListProps {
	label: string
	isExpanded: boolean
	onToggleExpand: () => void
	children: ReactNode
}

export function SearchResultsList({ label, isExpanded, onToggleExpand, children }: SearchResultsListProps) {
	const detailsId = useId()
	return (
		<div className="min-w-0 pl-6">
			<div className="overflow-hidden rounded-lg border border-[var(--vscode-contrastBorder,var(--vscode-panel-border))]">
				<button
					type="button"
					aria-expanded={isExpanded}
					aria-controls={detailsId}
					onClick={onToggleExpand}
					className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-vscode-focusBorder">
					<Files className="size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
					<span className="min-w-0 flex-1 break-words font-medium">{label}</span>
					<ChevronRight
						className={cn("size-3.5 shrink-0 text-vscode-descriptionForeground", isExpanded && "rotate-90")}
						aria-hidden="true"
					/>
				</button>
				<ul
					id={detailsId}
					hidden={!isExpanded}
					aria-label={label}
					className="m-0 max-h-96 list-none overflow-y-auto overscroll-contain border-t border-[var(--vscode-contrastBorder,var(--vscode-panel-border))] p-1">
					{children}
				</ul>
			</div>
		</div>
	)
}
