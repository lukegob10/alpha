import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { LiveTaskMetadata, ManagedAgentTreeProjection, SubagentGroupState } from "@alpha-code/types"
import { AlertTriangle, LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui"

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
	isVisible?: boolean
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
					: agent.parentVerification?.blocking
						? "Review"
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
	isVisible = true,
}: ManagedAgentTreeProps) {
	const { t } = useTranslation("chat")
	const [showAllAgents, setShowAllAgents] = useState(false)
	const [showActivity, setShowActivity] = useState(false)
	const overflowButtonRef = useRef<HTMLButtonElement>(null)
	const activityButtonRef = useRef<HTMLButtonElement>(null)
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
	const activity = projection?.activity ?? []
	const unreadCount = activity.filter((event) => event.unread).length
	const markDisplayedActivityRead = () => {
		if (!showActivity || !isVisible || !projection || !unreadCount) return
		const sequence = Math.max(...projection.activity.map((event) => event.sequence))
		vscode.postMessage({
			type: "markManagedAgentActivityRead",
			taskId: projection.rootTaskId,
			activitySequence: sequence,
		})
	}
	useEffect(() => {
		setShowAllAgents(false)
		setShowActivity(false)
	}, [rootTaskId])

	if (visibleDescendants.length === 0 && !activity.length && !isLoading && !errorMessage) return null

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
				{visibleDescendants.map((node) => {
					const taskUnavailable = node.stopReason === "never_launched"
					return (
						<div key={node.taskId} role="listitem" className="shrink-0">
							<SubagentTaskLink
								name={node.nickname}
								status={node.status}
								attention={compactAttention(node, attentionByTaskId.get(node.taskId))}
								detail={`${node.role} · ${node.path}${node.depth > 1 ? ` · nested level ${node.depth}` : ""}`}
								variant="chip"
								disabled={!onShowTask || taskUnavailable}
								onOpen={() => onShowTask?.(node.taskId)}
							/>
						</div>
					)
				})}
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
				<button
					ref={overflowButtonRef}
					type="button"
					className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-2 py-1 text-[10px] text-vscode-descriptionForeground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
					aria-label={t("agentNavigation.more", { count: hiddenCount })}
					onClick={() => setShowAllAgents(true)}>
					+{hiddenCount}
				</button>
			)}
			{activity.length > 0 && (
				<Button
					ref={activityButtonRef}
					variant="ghost"
					size="sm"
					className="shrink-0 text-[10px]"
					onClick={() => setShowActivity(true)}>
					{t("agentActivity.open", { count: unreadCount })}
				</Button>
			)}
			<Dialog open={showAllAgents && isVisible} onOpenChange={setShowAllAgents}>
				<DialogContent
					className="max-h-[80vh] overflow-y-auto"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						if (isVisible) overflowButtonRef.current?.focus()
					}}>
					<DialogHeader>
						<DialogTitle>{t("agentNavigation.title")}</DialogTitle>
						<DialogDescription>{t("agentNavigation.description")}</DialogDescription>
					</DialogHeader>
					<ul className="space-y-2">
						{model.nodes.map((node) => (
							<li key={node.taskId}>
								<SubagentTaskLink
									name={node.nickname}
									status={node.status}
									attention={compactAttention(node, attentionByTaskId.get(node.taskId))}
									detail={`${node.role} · ${node.path}`}
									disabled={!onShowTask || node.stopReason === "never_launched"}
									onOpen={() => {
										setShowAllAgents(false)
										onShowTask?.(node.taskId)
									}}
								/>
							</li>
						))}
					</ul>
					{model.omittedNodeCount > 0 && (
						<p>{t("agentNavigation.omitted", { count: model.omittedNodeCount })}</p>
					)}
				</DialogContent>
			</Dialog>
			<Dialog open={showActivity && isVisible} onOpenChange={setShowActivity}>
				<DialogContent
					className="max-h-[80vh] overflow-y-auto"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						if (isVisible) activityButtonRef.current?.focus()
					}}>
					<DialogHeader>
						<DialogTitle>{t("agentActivity.title")}</DialogTitle>
						<DialogDescription>{t("agentActivity.description")}</DialogDescription>
					</DialogHeader>
					<Button variant="secondary" size="sm" disabled={!unreadCount} onClick={markDisplayedActivityRead}>
						{t("agentActivity.markRead")}
					</Button>
					<ul className="space-y-3">
						{activity.map((event) => {
							const sender = projection?.nodes.find((node) => node.taskId === event.senderTaskId)
							const targetTaskId = event.recipientTaskId ?? event.senderTaskId
							const target = projection?.nodes.find((node) => node.taskId === targetTaskId)
							return (
								<li key={event.eventId} className="rounded border border-vscode-panel-border p-2">
									<p className="font-medium">{sender?.nickname ?? event.senderPath ?? event.name}</p>
									<p className="break-words whitespace-pre-wrap">{event.summary}</p>
									<p className="text-xs text-vscode-descriptionForeground">
										{t(event.pendingDelivery ? "agentActivity.pending" : "agentActivity.delivered")}
									</p>
									{targetTaskId && onShowTask && (
										<Button
											variant="ghost"
											size="sm"
											aria-label={t("agentActivity.openNamed", {
												name:
													target?.nickname ??
													event.recipientPath ??
													event.senderPath ??
													targetTaskId,
											})}
											onClick={() => {
												setShowActivity(false)
												onShowTask(targetTaskId)
											}}>
											{t("agentActivity.openChat")}
										</Button>
									)}
								</li>
							)
						})}
					</ul>
					{Boolean(projection?.omittedActivityCount) && (
						<p>{t("agentActivity.omitted", { count: projection?.omittedActivityCount })}</p>
					)}
				</DialogContent>
			</Dialog>
		</section>
	)
}
