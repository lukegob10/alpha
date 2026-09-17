import type { SubagentRunStatus } from "@alpha-code/types"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

type SubagentTaskLinkStatus = SubagentRunStatus | "unknown"

const statusLabels: Record<SubagentTaskLinkStatus, string> = {
	pending: "Starting",
	running: "Working",
	cancelling: "Stopping",
	completed: "Completed",
	blocked: "Blocked",
	failed: "Failed",
	cancelled: "Cancelled",
	timed_out: "Timed out",
	interrupted: "Interrupted",
	unknown: "Status unavailable",
}

const statusDotClass = (status: SubagentTaskLinkStatus): string => {
	if (status === "pending") return "bg-vscode-charts-yellow"
	if (status === "running" || status === "cancelling") {
		return "animate-pulse bg-vscode-progressBar-background"
	}
	if (status === "completed") return "bg-vscode-testing-iconPassed"
	if (status === "blocked" || status === "timed_out") return "bg-vscode-editorWarning-foreground"
	if (status === "failed") return "bg-vscode-testing-iconFailed"
	return "bg-vscode-descriptionForeground"
}

interface SubagentTaskLinkProps {
	name: string
	status: SubagentTaskLinkStatus
	attention?: string
	detail?: string
	variant?: "chip" | "row"
	className?: string
	disabled?: boolean
	onOpen: () => void
}

/** Compact, thread-like navigation used wherever a managed sub-agent appears in its parent. */
export function SubagentTaskLink({
	name,
	status,
	attention,
	detail,
	variant = "row",
	className,
	disabled = false,
	onOpen,
}: SubagentTaskLinkProps) {
	const statusLabel = statusLabels[status]
	const accessibleLabel = [disabled ? `${name} task unavailable` : `Open ${name}`, statusLabel, attention, detail]
		.filter(Boolean)
		.join(" · ")
	const title = [name, statusLabel, attention, detail].filter(Boolean).join(" — ")

	return (
		<button
			type="button"
			aria-label={accessibleLabel}
			title={title}
			disabled={disabled}
			onClick={onOpen}
			className={cn(
				"group/task-link flex min-w-0 items-center gap-2 border border-transparent bg-transparent text-left text-vscode-foreground",
				"transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--alpha-accent-soft)]",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
				"disabled:cursor-default disabled:opacity-60 disabled:hover:border-transparent disabled:hover:bg-transparent",
				variant === "chip" ? "h-7 max-w-56 shrink-0 rounded-full px-2" : "min-h-8 flex-1 rounded-md px-2 py-1",
				className,
			)}>
			<span className={cn("size-2 shrink-0 rounded-full", statusDotClass(status))} aria-hidden="true" />
			<span className="min-w-0 truncate text-xs font-medium">{name}</span>
			{attention ? (
				<span className="max-w-24 shrink-0 truncate rounded-full bg-vscode-editorWarning-foreground/15 px-1.5 py-0.5 text-[10px] font-medium text-vscode-editorWarning-foreground">
					{attention}
				</span>
			) : (
				<span className="shrink-0 text-[10px] text-vscode-descriptionForeground">{statusLabel}</span>
			)}
			<ChevronRight
				className="size-3 shrink-0 text-vscode-descriptionForeground opacity-50 transition-opacity group-hover/task-link:opacity-100"
				aria-hidden="true"
			/>
		</button>
	)
}
