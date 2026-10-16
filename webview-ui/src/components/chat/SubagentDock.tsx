import { memo, useId, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react"

import type { LiveTaskMetadata, ManagedAgentTreeProjection, SubagentGroupState } from "@alpha-code/types"

import { ManagedAgentTree } from "@/components/agents/ManagedAgentTree"
import { buildManagedAgentTreeModel, dedupeManagedAgentGroups } from "@/components/agents/managedAgentTreeAdapter"

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
				agents: group.agents.filter((agent) => latestGroupByTask.get(agent.taskId) === group.groupId),
			}))
			.filter((group) => group.agents.length > 0)
	}, [groups])
	const model = useMemo(
		() => buildManagedAgentTreeModel({ rootTaskId: parentTaskId, groups: latestGroups, projection, liveTasksById }),
		[parentTaskId, latestGroups, projection, liveTasksById],
	)
	const groupedTaskIds = useMemo(
		() => new Set(latestGroups.flatMap((group) => group.agents.map((agent) => agent.taskId))),
		[latestGroups],
	)
	// Exclude duplicate navigation rows only; retain the full tree so activity keeps originating agent names.
	const agents = latestGroups.flatMap((group) => group.agents)
	const ungroupedAttention =
		projection?.rootTaskId === parentTaskId
			? projection.nodes.filter((node) => node.taskId !== parentTaskId && !groupedTaskIds.has(node.taskId))
			: []
	const approvalCount =
		agents.filter((agent) => agent.pendingApproval).length +
		ungroupedAttention.filter((node) => node.attention?.kind === "approval").length
	const reviewCount = agents.filter(
		(agent) =>
			agent.parentVerification?.blocking ||
			(agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)),
	).length
	const inputCount = ungroupedAttention.filter((node) => node.attention?.kind === "input").length
	const statuses = new Map([
		...agents.map((agent) => [agent.taskId, agent.status] as const),
		...model.nodes.map((node) => [node.taskId, node.status] as const),
	])
	const runningCount = [...statuses.values()].filter((status) => status === "running").length
	const attentionSummary = approvalCount
		? t("subagentDock.approvals", { count: approvalCount })
		: reviewCount
			? t("subagentDock.reviews", { count: reviewCount })
			: inputCount
				? t("subagentDock.input", { count: inputCount })
				: undefined
	const count = new Set([...model.nodes.map((node) => node.taskId), ...groupedTaskIds]).size
	if (count === 0 && !projection?.activity.length) return null

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
				{latestGroups.map((group) => (
					<SubagentGroupCard
						key={group.groupId}
						group={group}
						parentTaskId={group.parentTaskId}
						onShowTask={onShowTask}
						presentation="dock"
						isVisible={isVisible}
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
