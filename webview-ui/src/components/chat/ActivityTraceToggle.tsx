import { ChevronRight } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import type { ActionActivityKind } from "./actionActivity"

interface ActivityTraceToggleProps {
	traceId: number
	kind: ActionActivityKind
	count: number
	expanded: boolean
	controls: string
	onToggle: () => void
}

export function ActivityTraceToggle({ traceId, kind, count, expanded, controls, onToggle }: ActivityTraceToggleProps) {
	const { t } = useAppTranslation()
	const label = t(
		`chat:activityTrace.${kind === "commands" ? "runningCommands" : kind === "edits" ? "editingFiles" : "working"}`,
	)

	return (
		<div className={cn("mx-[15px] my-1 pb-1", kind === "commands" && "border-b border-[var(--border-subtle)]")}>
			<button
				type="button"
				data-activity-trace-id={traceId}
				aria-expanded={expanded}
				aria-controls={controls}
				onClick={onToggle}
				className="flex max-w-full items-center gap-1 rounded-md py-1.5 text-sm text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
				<span>{label}</span>
				<span className="text-xs tabular-nums opacity-70">{count}</span>
				<ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", expanded && "rotate-90")} />
			</button>
		</div>
	)
}
