import type { SubagentRunState, SubagentRunStatus } from "@alpha-code/types"
import { ChevronRight, LoaderCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

type SubagentTaskLinkStatus = SubagentRunStatus | "unknown"

export const hasPendingSubagentApproval = (agent: SubagentRunState): boolean =>
	Boolean(agent.pendingApproval) &&
	(agent.status === "pending" || agent.status === "running" || agent.status === "cancelling")

export const getSubagentAttentionKey = (agent: SubagentRunState) => {
	if (hasPendingSubagentApproval(agent)) return "subagentRow.attention.approval" as const
	if (agent.changeSet?.status === "conflicted") return "subagentRow.attention.conflict" as const
	if (agent.parentVerification?.blocking) return "subagentRow.attention.parentAction" as const
	if (agent.changeSet?.status === "pending_review" || agent.parentVerification?.status === "required") {
		return "subagentRow.attention.changes" as const
	}
	return undefined
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
	descriptionId?: string
	variant?: "chip" | "row" | "dock"
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
	descriptionId,
	variant = "row",
	className,
	disabled = false,
	onOpen,
}: SubagentTaskLinkProps) {
	const { t } = useTranslation("chat")
	const statusLabel = t(`subagentRow.status.${status}`)
	const accessibleLabel = [
		t(disabled ? "subagentRow.taskUnavailable" : "subagentRow.open", { name }),
		statusLabel,
		attention,
		detail,
	]
		.filter(Boolean)
		.join(" · ")
	const title = [name, statusLabel, attention, detail].filter(Boolean).join(" — ")
	const isDock = variant === "dock"
	const isRunning = status === "pending" || status === "running" || status === "cancelling"

	return (
		<button
			type="button"
			aria-label={accessibleLabel}
			aria-describedby={descriptionId}
			title={title}
			disabled={disabled}
			onClick={onOpen}
			className={cn(
				"group/task-link flex min-w-0 items-center gap-2 border border-transparent bg-transparent text-left text-vscode-foreground",
				"transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--alpha-accent-soft)]",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
				"disabled:cursor-default disabled:opacity-60 disabled:hover:border-transparent disabled:hover:bg-transparent",
				variant === "chip"
					? "h-7 max-w-56 shrink-0 rounded-full px-2"
					: isDock
						? "min-h-7 flex-1 rounded-lg px-1.5 py-0.5"
						: "min-h-8 flex-1 rounded-md px-2 py-1",
				className,
			)}>
			{!isDock && (
				<span className={cn("size-2 shrink-0 rounded-full", statusDotClass(status))} aria-hidden="true" />
			)}
			<span
				className={cn(
					"min-w-0 truncate",
					isDock ? "flex-1 text-[length:var(--chat-ui-font-size,13px)] font-normal" : "text-xs font-medium",
				)}>
				{name}
			</span>
			{attention && (
				<span className="max-w-24 shrink-0 truncate rounded-full bg-vscode-editorWarning-foreground/15 px-1.5 py-0.5 text-[10px] font-medium text-vscode-editorWarning-foreground">
					{attention}
				</span>
			)}
			{isDock && isRunning ? (
				<LoaderCircle
					className="size-3 shrink-0 animate-spin text-vscode-progressBar-background motion-reduce:animate-none"
					aria-hidden="true"
				/>
			) : (
				<span
					className={cn(
						"shrink-0 text-vscode-descriptionForeground",
						isDock ? "text-[11px]" : "text-[10px]",
					)}>
					{statusLabel}
				</span>
			)}
			{!isDock && (
				<ChevronRight
					className="size-3 shrink-0 text-vscode-descriptionForeground opacity-50 transition-opacity group-hover/task-link:opacity-100"
					aria-hidden="true"
				/>
			)}
		</button>
	)
}
