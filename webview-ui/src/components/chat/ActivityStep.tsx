import { useId, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

interface ActivityStepProps {
	summary: ReactNode
	children: ReactNode
	isExpanded: boolean
	onToggleExpand: () => void
}

/** Keep tool listeners and approval state mounted while the reader hides the details. */
export function ActivityStep({ summary, children, isExpanded, onToggleExpand }: ActivityStepProps) {
	const detailsId = useId()
	return (
		<div>
			<button
				type="button"
				aria-expanded={isExpanded}
				aria-controls={detailsId}
				onClick={onToggleExpand}
				className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
				<ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", isExpanded && "rotate-90")} />
				<span className="flex min-w-0 flex-1 items-center gap-2 [&>span]:truncate">{summary}</span>
			</button>
			<div id={detailsId} hidden={!isExpanded} className="mt-2">
				{children}
			</div>
		</div>
	)
}
