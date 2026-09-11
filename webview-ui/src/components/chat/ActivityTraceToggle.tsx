import { ChevronRight } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"

interface ActivityTraceToggleProps {
	traceId: number
	durationMs: number
	expanded: boolean
	controls: string
	onToggle: () => void
}

export function ActivityTraceToggle({ traceId, durationMs, expanded, controls, onToggle }: ActivityTraceToggleProps) {
	const { t, i18n } = useAppTranslation()
	const totalSeconds = Math.floor(durationMs / 1000)
	const units = [
		{ unit: "hour", value: Math.floor(totalSeconds / 3600) },
		{ unit: "minute", value: Math.floor((totalSeconds % 3600) / 60) },
		{ unit: "second", value: totalSeconds % 60 },
	]
	const duration = units
		.filter(({ value, unit }) => value > 0 || (totalSeconds === 0 && unit === "second"))
		.map(({ value, unit }) =>
			new Intl.NumberFormat(i18n.language, { style: "unit", unit, unitDisplay: "narrow" }).format(value),
		)
		.join(" ")

	return (
		<div className="mx-[15px] my-2 border-b border-[var(--border-subtle)] pb-2">
			<button
				type="button"
				data-activity-trace-id={traceId}
				aria-expanded={expanded}
				aria-controls={controls}
				onClick={onToggle}
				className="flex max-w-full items-center gap-1 rounded-md py-1.5 text-sm text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
				<span>{t("chat:activityTrace.workedFor", { duration })}</span>
				<ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", expanded && "rotate-90")} />
			</button>
		</div>
	)
}
