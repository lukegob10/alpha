import { memo, useId, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react"

import type {
	LiveTaskMetadata,
	ManagedAgentTreeNodeProjection,
	ManagedAgentTreeProjection,
	SubagentGroupState,
	SubagentRunState,
} from "@alpha-code/types"

import { ManagedAgentTree } from "@/components/agents/ManagedAgentTree"
import { buildManagedAgentTreeModel, dedupeManagedAgentGroups } from "@/components/agents/managedAgentTreeAdapter"
import { getSubagentAttentionKey, hasPendingSubagentApproval } from "@/components/agents/SubagentTaskLink"

import { SubagentGroupCard } from "./SubagentGroupCard"

export interface SubagentDockProps {
	groups: readonly SubagentGroupState[]
	parentTaskId: string
	projection?: ManagedAgentTreeProjection
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
	onShowTask?: (taskId: string) => void
	isVisible?: boolean
}

/** Presentation of the existing managed-agent snapshots; actions remain owned by their group cards. */
export const SubagentDock = memo(function SubagentDock({
	groups,
	parentTaskId,
	projection,
	liveTasksById,
	onShowTask,
	isVisible = true,
}: SubagentDockProps) {
	const { t } = useTranslation("chat")
	const [expanded, setExpanded] = useState(false)
	const rowsId = useId()
	const countId = useId()
	const runningId = useId()
	const attentionId = useId()
	const latestGroups = useMemo(() => {
		const deduped = dedupeManagedAgentGroups(groups)
		const latestGroupByTask = new Map(
			deduped.flatMap((group) => group.agents.map((agent) => [agent.taskId, group.groupId] as const)),
		)
		return deduped
			.map((group) => ({
				...group,
				agents: group.agents.filter(
					(agent) =>
						latestGroupByTask.get(agent.taskId) === group.groupId ||
						Boolean(agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)) ||
						agent.parentVerification?.blocking ||
						agent.parentVerification?.status === "required",
				),
			}))
			.filter((group) => group.agents.length > 0)
	}, [groups])
	const projectedNodesByTaskId = useMemo(
		() =>
			new Map(
				projection?.rootTaskId === parentTaskId
					? projection.nodes.map((node) => [node.taskId, node] as const)
					: [],
			),
		[parentTaskId, projection],
	)
	const currentNodes = useMemo(() => {
		const current = new Map<string, ManagedAgentTreeNodeProjection>()
		if (projection?.rootTaskId !== parentTaskId) return current
		for (const group of latestGroups) {
			for (const agent of group.agents) {
				const node = projectedNodesByTaskId.get(agent.taskId)
				const boundary = Math.max(
					group.createdAt,
					group.startedAt ?? 0,
					group.completedAt ?? 0,
					agent.startedAt ?? 0,
					agent.phaseStartedAt ?? 0,
					agent.completedAt ?? 0,
				)
				// A task can have several follow-up groups. Only the same generation's newer
				// host projection may refresh its row; proposals retain their original routing.
				if (
					node?.groupId === group.groupId &&
					node.parentTaskId === group.parentTaskId &&
					node.updatedAt >= boundary &&
					projection.observedAt >= Math.max(boundary, agent.pendingApproval?.createdAt ?? 0)
				) {
					current.set(agent.taskId, node)
				}
			}
		}
		return current
	}, [latestGroups, parentTaskId, projection, projectedNodesByTaskId])
	const displayGroups = useMemo(
		() =>
			latestGroups.map((group) => ({
				...group,
				agents: group.agents.map((agent): SubagentRunState => {
					const node = currentNodes.get(agent.taskId)
					if (node?.groupId !== group.groupId || node.parentTaskId !== group.parentTaskId) return agent
					return {
						...agent,
						status: node.status,
						stopReason: node.stopReason ?? (node.status === agent.status ? agent.stopReason : undefined),
						error: node.status === agent.status ? agent.error : undefined,
						pendingApproval: node.attention?.kind === "approval" ? agent.pendingApproval : undefined,
					}
				}),
			})),
		[latestGroups, currentNodes],
	)
	const model = useMemo(
		() =>
			buildManagedAgentTreeModel({ rootTaskId: parentTaskId, groups: displayGroups, projection, liveTasksById }),
		[parentTaskId, displayGroups, projection, liveTasksById],
	)
	const groupedTaskIds = useMemo(
		() => new Set(latestGroups.flatMap((group) => group.agents.map((agent) => agent.taskId))),
		[latestGroups],
	)
	const inputTaskIds = useMemo(
		() =>
			new Set(
				projection?.rootTaskId === parentTaskId
					? projection.nodes
							.filter(
								(node) =>
									node.taskId !== parentTaskId &&
									node.attention?.kind === "input" &&
									(!groupedTaskIds.has(node.taskId) || currentNodes.has(node.taskId)),
							)
							.map((node) => node.taskId)
					: model.nodes
							.filter((node) => liveTasksById?.[node.taskId]?.isWaitingForInput)
							.map((node) => node.taskId),
			),
		[parentTaskId, projection, model.nodes, liveTasksById, groupedTaskIds, currentNodes],
	)
	// Exclude only duplicate navigation rows; the canonical tree still owns descendant and overflow projections.
	const agents = displayGroups.flatMap((group) => group.agents)
	const ungroupedAttention =
		projection?.rootTaskId === parentTaskId
			? projection.nodes.filter((node) => node.taskId !== parentTaskId && !groupedTaskIds.has(node.taskId))
			: []
	const approvalTaskIds = new Set([
		...agents.filter(hasPendingSubagentApproval).map((agent) => agent.taskId),
		...[...currentNodes.values(), ...ungroupedAttention]
			.filter((node) => node.attention?.kind === "approval")
			.map((node) => node.taskId),
	])
	const approvalCount = approvalTaskIds.size
	const attentionKeys = agents.map(getSubagentAttentionKey)
	const conflictCount = attentionKeys.filter((key) => key === "subagentRow.attention.conflict").length
	const parentActionCount = attentionKeys.filter((key) => key === "subagentRow.attention.parentAction").length
	const changesCount = attentionKeys.filter((key) => key === "subagentRow.attention.changes").length
	const inputCount = inputTaskIds.size
	const statuses = new Map([...model.nodes.map((node) => [node.taskId, node.status] as const)])
	for (const group of displayGroups) {
		for (const agent of group.agents) {
			const node = projectedNodesByTaskId.get(agent.taskId)
			if (!node || node.groupId === group.groupId) statuses.set(agent.taskId, agent.status)
		}
	}
	const runningCount = [...statuses.values()].filter((status) => status === "running").length
	const attentionSummary = approvalCount
		? t("subagentDock.approvals", { count: approvalCount })
		: conflictCount
			? t("subagentDock.conflicts", { count: conflictCount })
			: parentActionCount
				? t("subagentDock.parentActions", { count: parentActionCount })
				: changesCount
					? t("subagentDock.changes", { count: changesCount })
					: inputCount
						? t("subagentDock.input", { count: inputCount })
						: undefined
	const count = new Set([...model.nodes.map((node) => node.taskId), ...groupedTaskIds]).size
	const attentionIdsForGroup = (group: SubagentGroupState, taskIds: ReadonlySet<string>) =>
		new Set(
			group.agents
				.filter((agent) => {
					const node = projectedNodesByTaskId.get(agent.taskId)
					return (
						taskIds.has(agent.taskId) &&
						(!node || (node.groupId === group.groupId && node.parentTaskId === group.parentTaskId))
					)
				})
				.map((agent) => agent.taskId),
		)
	if (count === 0) return null

	return (
		<section
			className="subagent-dock mx-auto mb-2 box-border min-w-0 self-center rounded-xl border border-[var(--border-subtle)] bg-[var(--chat-surface)] p-1 text-[length:var(--chat-ui-font-size,13px)]"
			style={{ width: 272, maxWidth: "100%" }}
			aria-label={t("subagentDock.title")}
			hidden={!isVisible}>
			<div
				id={rowsId}
				hidden={!expanded}
				className="max-h-[min(240px,32vh)] min-w-0 space-y-0.5 overflow-x-hidden overflow-y-auto pb-1">
				{displayGroups.map((group) => (
					<SubagentGroupCard
						key={group.groupId}
						group={group}
						parentTaskId={group.parentTaskId}
						inputTaskIds={attentionIdsForGroup(group, inputTaskIds)}
						approvalTaskIds={attentionIdsForGroup(group, approvalTaskIds)}
						onShowTask={onShowTask}
						presentation="dock"
						isVisible={isVisible && expanded}
					/>
				))}
				{projection?.rootTaskId === parentTaskId && (
					<ManagedAgentTree
						rootTaskId={parentTaskId}
						projection={projection}
						excludeTaskIds={groupedTaskIds}
						liveTasksById={liveTasksById}
						onShowTask={onShowTask}
						isVisible={isVisible && expanded}
						presentation="dock"
					/>
				)}
			</div>
			<button
				type="button"
				className="flex min-h-7 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 text-left text-inherit hover:bg-[var(--alpha-accent-soft)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
				aria-label={t(expanded ? "subagentDock.collapse" : "subagentDock.expand")}
				aria-describedby={[countId, runningId, attentionSummary ? attentionId : undefined]
					.filter(Boolean)
					.join(" ")}
				aria-controls={rowsId}
				aria-expanded={expanded}
				onClick={() => setExpanded((open) => !open)}>
				<Bot className="size-3.5 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
				<span className="min-w-0 flex-1">
					<span id={countId} className="block truncate">
						{t("subagentDock.count", { count })}
					</span>
					{attentionSummary && (
						<span
							id={attentionId}
							className="flex min-w-0 items-center gap-1 text-[11px] text-vscode-editorWarning-foreground"
							aria-live="polite">
							{approvalCount > 0 && <ShieldAlert className="size-3 shrink-0" aria-hidden="true" />}
							<span className="truncate">{attentionSummary}</span>
						</span>
					)}
				</span>
				<span
					id={runningId}
					className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-1.5 py-0.5 text-[11px] tabular-nums text-vscode-descriptionForeground"
					aria-live="polite">
					{t("subagentDock.running", { count: runningCount })}
				</span>
				{expanded ? (
					<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
				) : (
					<ChevronUp className="size-3 shrink-0" aria-hidden="true" />
				)}
			</button>
		</section>
	)
})
