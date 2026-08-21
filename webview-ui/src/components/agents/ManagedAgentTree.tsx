import { useMemo } from "react"
import type { LiveTaskMetadata, ManagedAgentTreeProjection, SubagentGroupState } from "@alpha-code/types"
import { AlertTriangle, LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

import { buildManagedAgentTreeModel, type ManagedAgentNode } from "./managedAgentTreeAdapter"
import { SubagentTaskLink } from "./SubagentTaskLink"

export interface ManagedAgentTreeProps {
	rootTaskId: string
	groups?: readonly SubagentGroupState[]
	projection?: ManagedAgentTreeProjection
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
	isLoading?: boolean
	errorMessage?: string
	maxVisibleAgents?: number
	className?: string
	onShowTask?: (taskId: string) => void
}

const DEFAULT_MAX_VISIBLE_AGENTS = 24

const groupAttentionByTaskId = (groups: readonly SubagentGroupState[] | undefined): Map<string, string> => {
	const latest = new Map<string, { attention?: string; observedAt: number; order: number }>()
	let order = 0

	for (const group of groups ?? []) {
		for (const agent of group.agents) {
			const attention = agent.pendingApproval
				? "Approval"
				: agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)
					? "Review"
					: agent.parentVerification?.status === "failed"
						? "Fix"
						: agent.parentVerification?.status === "pending"
							? "Verify"
							: undefined
			const observedAt = Math.max(
				agent.completedAt ?? 0,
				agent.phaseStartedAt ?? 0,
				agent.startedAt ?? 0,
				group.completedAt ?? 0,
				group.startedAt ?? 0,
				group.createdAt,
			)
			const current = latest.get(agent.taskId)
			if (
				!current ||
				observedAt > current.observedAt ||
				(observedAt === current.observedAt && order > current.order)
			) {
				latest.set(agent.taskId, { attention, observedAt, order })
			}
			order += 1
		}
	}

	const attentionByTaskId = new Map<string, string>()
	for (const [taskId, snapshot] of latest) {
		if (snapshot.attention) attentionByTaskId.set(taskId, snapshot.attention)
	}
	return attentionByTaskId
}

const compactAttention = (node: ManagedAgentNode, groupAttention?: string): string | undefined => {
	if (groupAttention) return groupAttention
	if (!node.attention) return undefined
	if (/approval/i.test(node.attention)) return "Approval"
	if (/review|change/i.test(node.attention)) return "Review"
	return "Input"
}

/**
 * Compact parent-facing view of managed descendants.
 *
 * The parent only needs navigation, live status, and actionable attention. Full
 * task detail remains in the child task reached by clicking a link.
 */
export function ManagedAgentTree({
	rootTaskId,
	groups,
	projection,
	liveTasksById,
	isLoading = false,
	errorMessage,
	maxVisibleAgents = DEFAULT_MAX_VISIBLE_AGENTS,
	className,
	onShowTask,
}: ManagedAgentTreeProps) {
	const model = useMemo(
		() =>
			buildManagedAgentTreeModel({
				rootTaskId,
				groups,
				projection,
				liveTasksById,
			}),
		[groups, liveTasksById, projection, rootTaskId],
	)
	const attentionByTaskId = useMemo(() => groupAttentionByTaskId(groups), [groups])
	const visibleLimit = Number.isFinite(maxVisibleAgents)
		? Math.max(1, Math.floor(maxVisibleAgents))
		: DEFAULT_MAX_VISIBLE_AGENTS
	const visibleDescendants = model.nodes.slice(0, visibleLimit)
	const hiddenCount = Math.max(0, model.nodes.length - visibleDescendants.length + model.omittedNodeCount)

	if (visibleDescendants.length === 0 && !isLoading && !errorMessage) return null

	return (
		<section
			aria-label="Sub-agent tasks"
			aria-busy={isLoading}
			className={cn(
				"flex min-h-9 min-w-0 items-center gap-1.5 border-y border-[var(--border-subtle)] bg-vscode-editor-background/60 px-1.5 py-1",
				className,
			)}>
			<span className="shrink-0 px-1 text-[10px] font-medium uppercase tracking-wide text-vscode-descriptionForeground">
				Agents
			</span>
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="list">
				{visibleDescendants.map((node) => (
					<div key={node.taskId} role="listitem" className="shrink-0">
						<SubagentTaskLink
							name={node.nickname}
							status={node.status}
							attention={compactAttention(node, attentionByTaskId.get(node.taskId))}
							detail={`${node.role} · ${node.path}${node.depth > 1 ? ` · nested level ${node.depth}` : ""}`}
							variant="chip"
							disabled={!onShowTask}
							onOpen={() => onShowTask?.(node.taskId)}
						/>
					</div>
				))}
			</div>
			{isLoading && (
				<span className="inline-flex shrink-0 items-center gap-1 px-1 text-[10px] text-vscode-descriptionForeground">
					<LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> Updating
				</span>
			)}
			{errorMessage && (
				<span
					className="inline-flex shrink-0 items-center gap-1 px-1 text-[10px] text-vscode-errorForeground"
					role="alert"
					title={errorMessage}>
					<AlertTriangle className="size-3" aria-hidden="true" /> Unavailable
				</span>
			)}
			{hiddenCount > 0 && (
				<span
					className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-2 py-1 text-[10px] text-vscode-descriptionForeground"
					title={`${hiddenCount} additional sub-agent task${hiddenCount === 1 ? "" : "s"}`}>
					+{hiddenCount}
				</span>
			)}
		</section>
	)
}
