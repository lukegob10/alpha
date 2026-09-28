import { ChevronRight } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import type { ActionActivityKind } from "./actionActivity"

interface ActivityTraceToggleProps {
	traceId: number
	kind: ActionActivityKind
	count: number
	durationMs?: number
	expanded: boolean
	controls: string
	onToggle: () => void
}

function formatWorkedDuration(durationMs: number): string {
	const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
	const totalSeconds = Math.max(1, Math.ceil(safeDurationMs / 1_000))
	if (totalSeconds < 60) return `${totalSeconds}s`

	const totalMinutes = Math.floor(totalSeconds / 60)
	if (totalMinutes < 60) return `${totalMinutes}m`

	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

export function ActivityTraceToggle({
	traceId,
	kind,
	count,
	durationMs,
	expanded,
	controls,
	onToggle,
}: ActivityTraceToggleProps) {
	const { t } = useAppTranslation()
	const label =
		kind === "worked"
			? t("chat:activityTrace.workedFor", { duration: formatWorkedDuration(durationMs ?? 0) })
			: t(
					`chat:activityTrace.${kind === "commands" ? "runningCommands" : kind === "edits" ? "editingFiles" : "working"}`,
				)

	return (
		<div className="mx-[15px] my-1 pb-1">
			<button
				type="button"
				data-activity-trace-id={traceId}
				aria-expanded={expanded}
				aria-controls={controls}
				onClick={onToggle}
				className="flex max-w-full items-center gap-1 rounded-md py-1.5 text-sm text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
				<span>{label}</span>
				{kind !== "worked" && <span className="text-xs tabular-nums opacity-70">{count}</span>}
				<ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", expanded && "rotate-90")} />
			</button>
		</div>
	)
}
