import type { KeyboardEvent, ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { LiveTaskMetadata, SubagentGroupState } from "@alpha-code/types"
import {
	Activity,
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Clock3,
	ExternalLink,
	Gauge,
	Inbox,
	LoaderCircle,
	RefreshCw,
	Square,
	TreePine,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

import {
	buildManagedAgentTreeModel,
	type ManagedAgentActivity,
	type ManagedAgentNode,
	type ManagedAgentRuntimeProjection,
	type ManagedAgentStatus,
} from "./managedAgentTreeAdapter"

export interface ManagedAgentCancelRequest {
	parentTaskId: string
	groupId: string
	subagentTaskId: string
}

export interface ManagedAgentTreeProps {
	rootTaskId: string
	rootLabel?: string
	rootStartedAt?: number
	groups?: readonly SubagentGroupState[]
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
	capacityLimit?: number
	tokenBudget?: number | null
	costBudget?: number | null
	activity?: readonly ManagedAgentActivity[]
	pathsByTaskId?: Readonly<Record<string, string>>
	stopReasonsByTaskId?: Readonly<Record<string, string>>
	runtimeByTaskId?: Readonly<Record<string, ManagedAgentRuntimeProjection>>
	isLoading?: boolean
	errorMessage?: string
	reloadedAt?: number
	now?: number
	maxVisibleAgents?: number
	maxVisibleEvents?: number
	className?: string
	onCancelAgent?: (request: ManagedAgentCancelRequest) => void
	onShowTask?: (taskId: string) => void
}

interface FlatTreeNode {
	node: ManagedAgentNode
	hasChildren: boolean
	position: number
	setSize: number
}

const DEFAULT_MAX_VISIBLE_AGENTS = 100
const DEFAULT_MAX_VISIBLE_EVENTS = 50

const statusLabels: Record<ManagedAgentStatus, string> = {
	pending: "Pending",
	running: "Running",
	cancelling: "Stopping",
	completed: "Completed",
	blocked: "Blocked",
	failed: "Failed",
	cancelled: "Cancelled",
	timed_out: "Timed out",
	interrupted: "Interrupted",
	unknown: "Not reported",
}

const roleLabels: Record<ManagedAgentNode["role"], string> = {
	root: "Root",
	explore: "Explorer",
	review: "Reviewer",
	worker: "Worker",
}

const stateLabels: Record<ManagedAgentNode["state"], string> = {
	queued: "Queued",
	running: "Running",
	terminal: "Terminal",
	unknown: "Not reported",
}

const activityKindLabels: Record<NonNullable<ManagedAgentActivity["kind"]>, string> = {
	lifecycle: "Lifecycle",
	message: "Message",
	followup: "Follow-up",
	control: "Control",
	result: "Result",
	status: "Status",
}

const clampPercentage = (value: number, limit: number): number => Math.min(100, Math.max(0, (value / limit) * 100))

const formatCount = (value: number): string =>
	new Intl.NumberFormat(undefined, {
		notation: value >= 10_000 ? "compact" : "standard",
		maximumFractionDigits: 1,
	}).format(value)

const formatCost = (value: number): string =>
	new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
		maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
	}).format(value)

export const formatManagedAgentDuration = (durationMs: number): string => {
	const seconds = Math.max(0, Math.floor(durationMs / 1_000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

const formatElapsed = (node: ManagedAgentNode, now: number): string => {
	if (node.usage.durationMs !== undefined && node.state === "terminal") {
		return formatManagedAgentDuration(node.usage.durationMs)
	}
	const start = node.startedAt ?? node.createdAt
	if (start <= 0) return "Not reported"
	const end = node.finishedAt ?? now
	return formatManagedAgentDuration(Math.max(0, end - start))
}

const formatClock = (timestamp: number): string =>
	new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	}).format(timestamp)

const formatRelativeTime = (timestamp: number, now: number): string => {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
	if (seconds < 30) return "just now"
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}

const humanizeKey = (key: string): string =>
	key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replaceAll("_", " ")
		.toLowerCase()

const formatEffectiveLimit = (key: string, value: unknown): string | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (/cost/i.test(key)) return `${humanizeKey(key)} ${formatCost(value)}`
		if (/ms$|milliseconds/i.test(key)) return `${humanizeKey(key)} ${formatManagedAgentDuration(value)}`
		return `${humanizeKey(key)} ${formatCount(value)}`
	}
	if (typeof value === "string" && value.trim()) return `${humanizeKey(key)} ${value.trim()}`
	if (typeof value === "boolean") return `${humanizeKey(key)} ${value ? "on" : "off"}`
	return undefined
}

const summarizeEffectiveLimits = (limits: ManagedAgentNode["effectiveLimits"]): string | undefined => {
	if (!limits) return undefined
	const values = Object.entries(limits)
		.map(([key, value]) => formatEffectiveLimit(key, value))
		.filter((value): value is string => Boolean(value))
	return values.length > 0 ? values.slice(0, 4).join(" · ") : undefined
}

const statusDotClass = (status: ManagedAgentStatus): string => {
	if (status === "pending") return "bg-vscode-charts-yellow"
	if (status === "running" || status === "cancelling") return "bg-vscode-progressBar-background"
	if (status === "completed") return "bg-vscode-testing-iconPassed"
	if (status === "unknown" || status === "interrupted" || status === "cancelled") {
		return "bg-vscode-descriptionForeground"
	}
	return "bg-vscode-testing-iconFailed"
}

const roleBadgeClass = (role: ManagedAgentNode["role"]): string => {
	switch (role) {
		case "root":
			return "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)]"
		case "worker":
			return "border-vscode-charts-yellow/50"
		case "review":
			return "border-vscode-charts-blue/50"
		default:
			return "border-vscode-charts-green/50"
	}
}

const buildVisibleTree = (
	nodes: readonly ManagedAgentNode[],
	rootTaskId: string,
	collapsed: ReadonlySet<string>,
): FlatTreeNode[] => {
	const byParent = new Map<string, ManagedAgentNode[]>()
	for (const node of nodes) {
		if (node.taskId === rootTaskId) continue
		const parentId = node.parentTaskId ?? rootTaskId
		const children = byParent.get(parentId) ?? []
		children.push(node)
		byParent.set(parentId, children)
	}
	for (const children of byParent.values()) {
		children.sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path))
	}

	const root = nodes.find((node) => node.taskId === rootTaskId)
	if (!root) return []
	const result: FlatTreeNode[] = []
	const visit = (node: ManagedAgentNode, position: number, setSize: number) => {
		const children = byParent.get(node.taskId) ?? []
		result.push({ node, hasChildren: children.length > 0, position, setSize })
		if (collapsed.has(node.taskId)) return
		children.forEach((child, index) => visit(child, index + 1, children.length))
	}
	visit(root, 1, 1)
	return result
}

const useCurrentTime = (fixedNow: number | undefined, hasLiveAgents: boolean): number => {
	const [currentTime, setCurrentTime] = useState(() => fixedNow ?? Date.now())
	useEffect(() => {
		if (fixedNow !== undefined) {
			setCurrentTime(fixedNow)
			return
		}
		setCurrentTime(Date.now())
		if (!hasLiveAgents) return
		const interval = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
		return () => window.clearInterval(interval)
	}, [fixedNow, hasLiveAgents])
	return currentTime
}

function MetricCard({
	icon,
	label,
	primary,
	secondary,
	progress,
	progressLabel,
}: {
	icon: ReactNode
	label: string
	primary: string
	secondary: string
	progress?: number
	progressLabel?: string
}) {
	return (
		<div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5">
			<div className="flex items-center gap-1.5 text-xs text-vscode-descriptionForeground">
				{icon}
				<span>{label}</span>
			</div>
			<div className="mt-1 truncate text-sm font-medium text-vscode-foreground" title={primary}>
				{primary}
			</div>
			<div className="mt-0.5 min-h-4 text-[11px] leading-4 text-vscode-descriptionForeground">{secondary}</div>
			{progress !== undefined && progressLabel && (
				<Progress className="mt-2 h-1" value={progress} aria-label={progressLabel} />
			)}
		</div>
	)
}

function AgentTreeRow({
	item,
	currentTime,
	expanded,
	focused,
	cancelRequested,
	cancelAvailable,
	inspectAvailable,
	rowRef,
	onFocus,
	onKeyDown,
	onToggle,
	onCancel,
	onInspect,
}: {
	item: FlatTreeNode
	currentTime: number
	expanded: boolean
	focused: boolean
	cancelRequested: boolean
	cancelAvailable: boolean
	inspectAvailable: boolean
	rowRef: (element: HTMLLIElement | null) => void
	onFocus: () => void
	onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => void
	onToggle: () => void
	onCancel: () => void
	onInspect: () => void
}) {
	const { node, hasChildren } = item
	const elapsed = formatElapsed(node, currentTime)
	const statusLabel = statusLabels[node.status]
	const stateLabel = stateLabels[node.state]
	const isRoot = node.role === "root"
	const effectiveLimits = summarizeEffectiveLimits(node.effectiveLimits)
	const hasUsage =
		node.usage.inputTokens !== undefined ||
		node.usage.outputTokens !== undefined ||
		node.usage.totalCost !== undefined

	return (
		<li
			ref={rowRef}
			role="treeitem"
			aria-level={node.depth + 1}
			aria-posinset={item.position}
			aria-setsize={item.setSize}
			aria-expanded={hasChildren ? expanded : undefined}
			aria-label={`${node.nickname}, ${roleLabels[node.role]}, depth ${node.depth}, ${stateLabel}, ${statusLabel}`}
			tabIndex={focused ? 0 : -1}
			data-agent-task-id={node.taskId}
			className={cn(
				"group relative list-none rounded-lg border bg-vscode-editor-background outline-none transition-colors",
				focused
					? "border-vscode-focusBorder ring-1 ring-vscode-focusBorder"
					: "border-[var(--border-subtle)] hover:border-[var(--border-accent)]",
			)}
			style={{ marginInlineStart: `${Math.min(node.depth, 8) * 16}px` }}
			onFocus={(event) => {
				if (event.target === event.currentTarget) onFocus()
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onFocus()
			}}
			onKeyDown={onKeyDown}>
			<div className="flex min-w-0 flex-wrap items-start gap-2 p-2.5">
				<div className="flex min-w-0 flex-1 items-start gap-2">
					{hasChildren ? (
						<button
							type="button"
							className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded border-0 bg-transparent text-vscode-descriptionForeground hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder"
							aria-label={`${expanded ? "Collapse" : "Expand"} ${node.nickname}`}
							tabIndex={-1}
							onClick={onToggle}>
							{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
						</button>
					) : (
						<span className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
					)}
					<span
						className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", statusDotClass(node.status))}
						aria-hidden="true"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 flex-wrap items-center gap-1.5">
							<span className="min-w-0 truncate text-sm font-semibold text-vscode-foreground">
								{node.nickname}
							</span>
							<Badge
								variant="outline"
								className={cn("px-1.5 py-0 text-[10px]", roleBadgeClass(node.role))}>
								{roleLabels[node.role]}
							</Badge>
							<Badge variant="outline" className="px-1.5 py-0 text-[10px]">
								{stateLabel}
							</Badge>
							<span className="text-[11px] text-vscode-descriptionForeground">{statusLabel}</span>
						</div>
						<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-vscode-descriptionForeground">
							<span>
								Depth {node.depth}
								{node.maxDepth !== undefined ? ` of ${node.maxDepth}` : ""}
							</span>
							<span className="inline-flex items-center gap-1">
								<Clock3 className="size-3" aria-hidden="true" /> {elapsed}
							</span>
							<span className="min-w-0 truncate font-mono" title={node.path}>
								{node.path}
							</span>
						</div>
						{(node.delegationPolicy || effectiveLimits) && (
							<div className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[11px] text-vscode-descriptionForeground">
								{node.delegationPolicy && (
									<span>Delegation {node.delegationPolicy.replace(/[-_]+/g, " ")}</span>
								)}
								{effectiveLimits && (
									<span className="min-w-0 truncate" title={effectiveLimits}>
										Limits: {effectiveLimits}
									</span>
								)}
							</div>
						)}
						{node.phase && node.state !== "terminal" && (
							<div className="mt-1 text-xs text-vscode-descriptionForeground">
								Current activity: {node.phase.replaceAll("_", " ")}
							</div>
						)}
						<p
							className="mt-1 line-clamp-2 break-words text-xs text-vscode-foreground/90"
							title={node.objective}>
							{node.objective}
						</p>
						{node.attention && (
							<div
								className="mt-1.5 flex items-start gap-1 text-xs text-vscode-editorWarning-foreground"
								role="status">
								<AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
								<span>{node.attention}</span>
							</div>
						)}
						{node.stopReason && node.state === "terminal" && (
							<div className="mt-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-xs">
								<span className="font-medium">Stop reason:</span> {node.stopReason}
							</div>
						)}
						<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-vscode-descriptionForeground">
							{hasUsage ? (
								<>
									{(node.usage.inputTokens !== undefined ||
										node.usage.outputTokens !== undefined) && (
										<span>
											Tokens {formatCount(node.usage.inputTokens ?? 0)} in /{" "}
											{formatCount(node.usage.outputTokens ?? 0)} out
										</span>
									)}
									{node.usage.totalCost !== undefined && (
										<span>Cost {formatCost(node.usage.totalCost)}</span>
									)}
								</>
							) : (
								<span>Usage not reported</span>
							)}
						</div>
					</div>
				</div>

				{!isRoot && (
					<div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
						{node.canCancel && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={!cancelAvailable || cancelRequested}
								title={!cancelAvailable ? "Stop control is not available from the runtime" : undefined}
								aria-label={
									cancelRequested
										? `Stopping ${node.nickname}`
										: cancelAvailable
											? `Stop ${node.nickname}`
											: `Stop unavailable for ${node.nickname}`
								}
								onClick={onCancel}>
								{cancelRequested ? (
									<LoaderCircle className="animate-spin" aria-hidden="true" />
								) : (
									<Square aria-hidden="true" />
								)}
								{cancelRequested ? "Stopping…" : "Stop"}
							</Button>
						)}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={!inspectAvailable}
							title={
								!inspectAvailable
									? "Transcript inspection is not available from this surface"
									: undefined
							}
							aria-label={
								inspectAvailable
									? `Open transcript for ${node.nickname}`
									: `Transcript unavailable for ${node.nickname}`
							}
							onClick={onInspect}>
							<ExternalLink aria-hidden="true" /> Inspect
						</Button>
					</div>
				)}
			</div>
		</li>
	)
}

export function ManagedAgentTree({
	rootTaskId,
	rootLabel,
	rootStartedAt,
	groups,
	liveTasksById,
	capacityLimit,
	tokenBudget,
	costBudget,
	activity,
	pathsByTaskId,
	stopReasonsByTaskId,
	runtimeByTaskId,
	isLoading = false,
	errorMessage,
	reloadedAt,
	now,
	maxVisibleAgents = DEFAULT_MAX_VISIBLE_AGENTS,
	maxVisibleEvents = DEFAULT_MAX_VISIBLE_EVENTS,
	className,
	onCancelAgent,
	onShowTask,
}: ManagedAgentTreeProps) {
	const model = useMemo(
		() =>
			buildManagedAgentTreeModel({
				rootTaskId,
				rootLabel,
				rootStartedAt,
				groups,
				liveTasksById,
				pathsByTaskId,
				stopReasonsByTaskId,
				runtimeByTaskId,
				capacityLimit,
				tokenBudget,
				costBudget,
				activity,
				reloadedAt,
			}),
		[
			activity,
			capacityLimit,
			costBudget,
			groups,
			liveTasksById,
			pathsByTaskId,
			reloadedAt,
			rootLabel,
			rootStartedAt,
			rootTaskId,
			runtimeByTaskId,
			stopReasonsByTaskId,
			tokenBudget,
		],
	)
	const hasLiveAgents = model.nodes.some((node) => node.state === "queued" || node.state === "running")
	const currentTime = useCurrentTime(now, hasLiveAgents)
	const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set())
	const [focusedTaskId, setFocusedTaskId] = useState(rootTaskId)
	const [cancelRequestedTaskIds, setCancelRequestedTaskIds] = useState<Set<string>>(() => new Set())
	const itemRefs = useRef(new Map<string, HTMLLIElement>())

	const allVisibleItems = useMemo(
		() => buildVisibleTree(model.nodes, rootTaskId, collapsedTaskIds),
		[collapsedTaskIds, model.nodes, rootTaskId],
	)
	const visibleAgentLimit = Math.max(1, Math.floor(maxVisibleAgents))
	const visibleItems = allVisibleItems.slice(0, visibleAgentLimit)
	const hiddenAgentCount = allVisibleItems.length - visibleItems.length
	const visibleEventLimit = Math.max(0, Math.floor(maxVisibleEvents))
	const visibleEvents = model.activity.slice(0, visibleEventLimit)
	const hiddenEventCount = model.activity.length - visibleEvents.length
	const descendantCount = Math.max(0, model.nodes.length - 1)

	useEffect(() => {
		const visibleIds = new Set(visibleItems.map(({ node }) => node.taskId))
		if (!visibleIds.has(focusedTaskId)) setFocusedTaskId(visibleItems[0]?.node.taskId ?? rootTaskId)
	}, [focusedTaskId, rootTaskId, visibleItems])

	useEffect(() => {
		const cancellableIds = new Set(model.nodes.filter((node) => node.canCancel).map((node) => node.taskId))
		setCancelRequestedTaskIds((current) => {
			const next = new Set([...current].filter((taskId) => cancellableIds.has(taskId)))
			return next.size === current.size ? current : next
		})
	}, [model.nodes])

	const focusItem = (taskId: string) => {
		setFocusedTaskId(taskId)
		window.requestAnimationFrame(() => itemRefs.current.get(taskId)?.focus())
	}

	const toggleItem = (taskId: string) => {
		setCollapsedTaskIds((current) => {
			const next = new Set(current)
			if (next.has(taskId)) next.delete(taskId)
			else next.add(taskId)
			return next
		})
		setFocusedTaskId(taskId)
	}

	const handleTreeKeyDown = (event: KeyboardEvent<HTMLLIElement>, item: FlatTreeNode, index: number) => {
		if (event.target !== event.currentTarget) return
		const { node, hasChildren } = item
		const expanded = hasChildren && !collapsedTaskIds.has(node.taskId)
		let targetTaskId: string | undefined
		switch (event.key) {
			case "ArrowDown":
				targetTaskId = visibleItems[Math.min(visibleItems.length - 1, index + 1)]?.node.taskId
				break
			case "ArrowUp":
				targetTaskId = visibleItems[Math.max(0, index - 1)]?.node.taskId
				break
			case "Home":
				targetTaskId = visibleItems[0]?.node.taskId
				break
			case "End":
				targetTaskId = visibleItems.at(-1)?.node.taskId
				break
			case "ArrowRight":
				if (hasChildren && !expanded) toggleItem(node.taskId)
				else if (hasChildren) targetTaskId = visibleItems[index + 1]?.node.taskId
				break
			case "ArrowLeft":
				if (hasChildren && expanded) toggleItem(node.taskId)
				else if (node.parentTaskId) targetTaskId = node.parentTaskId
				break
			case "Enter":
			case " ":
				if (hasChildren) toggleItem(node.taskId)
				break
			default:
				return
		}
		event.preventDefault()
		if (targetTaskId) focusItem(targetTaskId)
	}

	const capacityProgress = model.capacity.limit
		? clampPercentage(model.capacity.active, model.capacity.limit)
		: undefined
	const tokenProgress =
		typeof model.budgets.tokenLimit === "number"
			? clampPercentage(model.usage.totalTokens, model.budgets.tokenLimit)
			: undefined
	const costProgress =
		typeof model.budgets.costLimit === "number"
			? clampPercentage(model.usage.totalCost, model.budgets.costLimit)
			: undefined

	if (isLoading && descendantCount === 0) {
		return (
			<section
				aria-label="Managed agents"
				aria-busy="true"
				className={cn(
					"rounded-xl border border-vscode-panel-border bg-vscode-editor-background p-4 shadow-sm",
					className,
				)}>
				<div className="flex items-center gap-2 text-sm font-semibold">
					<LoaderCircle
						className="size-4 animate-spin text-vscode-progressBar-background"
						aria-hidden="true"
					/>
					Loading managed agents…
				</div>
				<p className="mt-1 text-xs text-vscode-descriptionForeground">
					Restoring the live tree and activity stream.
				</p>
			</section>
		)
	}

	return (
		<section
			aria-labelledby={`managed-agent-tree-title-${rootTaskId}`}
			aria-busy={isLoading}
			className={cn(
				"overflow-hidden rounded-xl border border-vscode-panel-border bg-vscode-editor-background shadow-sm",
				className,
			)}>
			<header className="border-b border-[var(--border-subtle)] px-3 py-2.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<TreePine className="size-4 shrink-0 text-vscode-progressBar-background" aria-hidden="true" />
						<div className="min-w-0">
							<h2
								id={`managed-agent-tree-title-${rootTaskId}`}
								className="truncate text-sm font-semibold">
								Managed agents
							</h2>
							<p className="text-[11px] text-vscode-descriptionForeground">
								{descendantCount} descendant{descendantCount === 1 ? "" : "s"} · {model.capacity.active}{" "}
								active · {model.capacity.queued} queued · {model.capacity.terminal} terminal
							</p>
						</div>
					</div>
					<div className="text-right text-[11px] text-vscode-descriptionForeground">
						{isLoading ? (
							<span className="inline-flex items-center gap-1">
								<LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> Refreshing…
							</span>
						) : model.updatedAt ? (
							<time
								dateTime={new Date(model.updatedAt).toISOString()}
								title={formatClock(model.updatedAt)}>
								Updated {formatRelativeTime(model.updatedAt, currentTime)}
							</time>
						) : (
							<span>Update time not reported</span>
						)}
					</div>
				</div>

				{model.reloadedAt && (
					<div
						className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-xs"
						role="status">
						<RefreshCw className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
						<span>
							Restored after reload at{" "}
							<time dateTime={new Date(model.reloadedAt).toISOString()}>
								{formatClock(model.reloadedAt)}
							</time>
							. Live state may resume asynchronously.
						</span>
					</div>
				)}

				{errorMessage && (
					<div className="mt-2 flex items-start gap-1.5 text-xs text-vscode-errorForeground" role="alert">
						<AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
						<span>{errorMessage}</span>
					</div>
				)}

				<div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
					<MetricCard
						icon={<Gauge className="size-3" aria-hidden="true" />}
						label="Root-wide capacity"
						primary={
							model.capacity.limit
								? `${model.capacity.active} of ${model.capacity.limit} active`
								: `${model.capacity.active} active`
						}
						secondary={`${model.capacity.queued} queued · ${model.capacity.limit ? `${Math.max(0, model.capacity.limit - model.capacity.active)} available` : "Limit not reported"}`}
						progress={capacityProgress}
						progressLabel={
							model.capacity.limit
								? `Root-wide capacity: ${model.capacity.active} of ${model.capacity.limit}`
								: undefined
						}
					/>
					<MetricCard
						icon={<Activity className="size-3" aria-hidden="true" />}
						label="Aggregate tokens"
						primary={
							model.usage.tokensReported
								? `${formatCount(model.usage.totalTokens)} tokens`
								: "Usage not reported"
						}
						secondary={
							typeof model.budgets.tokenLimit === "number"
								? `${formatCount(model.budgets.tokenLimit)} token budget`
								: model.budgets.tokenLimit === null
									? "No limit configured"
									: "Budget not reported"
						}
						progress={model.usage.tokensReported ? tokenProgress : undefined}
						progressLabel={
							model.usage.tokensReported && typeof model.budgets.tokenLimit === "number"
								? `Token budget: ${model.usage.totalTokens} of ${model.budgets.tokenLimit}`
								: undefined
						}
					/>
					<MetricCard
						icon={<span aria-hidden="true">$</span>}
						label="Aggregate cost"
						primary={model.usage.costReported ? formatCost(model.usage.totalCost) : "Cost not reported"}
						secondary={
							typeof model.budgets.costLimit === "number"
								? `${formatCost(model.budgets.costLimit)} cost budget`
								: model.budgets.costLimit === null
									? "No limit configured"
									: "Budget not reported"
						}
						progress={model.usage.costReported ? costProgress : undefined}
						progressLabel={
							model.usage.costReported && typeof model.budgets.costLimit === "number"
								? `Cost budget: ${formatCost(model.usage.totalCost)} of ${formatCost(model.budgets.costLimit)}`
								: undefined
						}
					/>
				</div>
			</header>

			<div className="grid min-w-0 gap-3 p-3 min-[700px]:grid-cols-[minmax(0,3fr)_minmax(14rem,2fr)]">
				<div className="min-w-0">
					<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground">
						Live hierarchy
					</h3>
					<ul
						role="tree"
						aria-label="Managed agent hierarchy"
						className="m-0 flex list-none flex-col gap-1.5 p-0">
						{visibleItems.map((item, index) => (
							<AgentTreeRow
								key={item.node.taskId}
								item={item}
								currentTime={currentTime}
								expanded={item.hasChildren && !collapsedTaskIds.has(item.node.taskId)}
								focused={focusedTaskId === item.node.taskId}
								cancelRequested={cancelRequestedTaskIds.has(item.node.taskId)}
								cancelAvailable={Boolean(onCancelAgent)}
								inspectAvailable={Boolean(onShowTask)}
								rowRef={(element) => {
									if (element) itemRefs.current.set(item.node.taskId, element)
									else itemRefs.current.delete(item.node.taskId)
								}}
								onFocus={() => setFocusedTaskId(item.node.taskId)}
								onKeyDown={(event) => handleTreeKeyDown(event, item, index)}
								onToggle={() => toggleItem(item.node.taskId)}
								onCancel={() => {
									if (
										!onCancelAgent ||
										!item.node.canCancel ||
										!item.node.groupId ||
										!item.node.parentTaskId
									)
										return
									setCancelRequestedTaskIds((current) => new Set(current).add(item.node.taskId))
									onCancelAgent({
										parentTaskId: item.node.parentTaskId,
										groupId: item.node.groupId,
										subagentTaskId: item.node.taskId,
									})
								}}
								onInspect={() => onShowTask?.(item.node.taskId)}
							/>
						))}
					</ul>
					{descendantCount === 0 && (
						<div className="mt-2 rounded-lg border border-dashed border-[var(--border-subtle)] p-3 text-center">
							<p className="text-sm font-medium">No managed descendants</p>
							<p className="mt-0.5 text-xs text-vscode-descriptionForeground">
								New agents will appear here when the root delegates work.
							</p>
						</div>
					)}
					{hiddenAgentCount > 0 && (
						<p className="mt-2 text-center text-xs text-vscode-descriptionForeground" role="status">
							Showing {visibleItems.length} of {allVisibleItems.length} visible nodes. {hiddenAgentCount}{" "}
							more not rendered.
						</p>
					)}
				</div>

				<aside className="min-w-0" aria-labelledby={`managed-agent-activity-title-${rootTaskId}`}>
					<div className="mb-2 flex items-center justify-between gap-2">
						<h3
							id={`managed-agent-activity-title-${rootTaskId}`}
							className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground">
							Mailbox &amp; activity
						</h3>
						{model.activityReported && model.activity.length > 0 && (
							<span className="text-[11px] text-vscode-descriptionForeground">
								{model.activity.length} events
							</span>
						)}
					</div>
					<div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
						{!model.activityReported ? (
							<div className="flex min-h-28 flex-col items-center justify-center gap-1 p-3 text-center">
								<Inbox className="size-5 text-vscode-descriptionForeground" aria-hidden="true" />
								<p className="text-xs font-medium">Mailbox activity not reported</p>
								<p className="text-[11px] text-vscode-descriptionForeground">
									The current runtime snapshot does not expose mailbox events.
								</p>
							</div>
						) : visibleEvents.length === 0 ? (
							<div className="flex min-h-28 flex-col items-center justify-center gap-1 p-3 text-center">
								<Inbox className="size-5 text-vscode-descriptionForeground" aria-hidden="true" />
								<p className="text-xs font-medium">No mailbox activity yet</p>
							</div>
						) : (
							<ul
								role="log"
								aria-label="Managed agent activity"
								aria-live="polite"
								className="m-0 list-none p-0">
								{visibleEvents.map((entry) => (
									<li
										key={entry.id}
										className="border-b border-[var(--border-subtle)] p-2.5 last:border-b-0">
										<div className="flex min-w-0 items-center gap-1.5">
											{entry.unread && (
												<span
													className="size-1.5 shrink-0 rounded-full bg-vscode-progressBar-background"
													aria-label="Unread"
												/>
											)}
											<span className="truncate text-[10px] font-semibold uppercase tracking-wide text-vscode-descriptionForeground">
												{entry.kind ? activityKindLabels[entry.kind] : "Activity"}
												{entry.name ? ` · ${entry.name.replaceAll("_", " ")}` : ""}
											</span>
										</div>
										<p className="mt-1 break-words text-xs text-vscode-foreground">
											{entry.summary}
										</p>
										<div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-vscode-descriptionForeground">
											<time
												dateTime={new Date(entry.createdAt).toISOString()}
												title={formatClock(entry.createdAt)}>
												{formatClock(entry.createdAt)} ·{" "}
												{formatRelativeTime(entry.createdAt, currentTime)}
											</time>
											{entry.sender && <span>From {entry.sender}</span>}
										</div>
									</li>
								))}
							</ul>
						)}
					</div>
					{hiddenEventCount > 0 && (
						<p className="mt-1.5 text-center text-[11px] text-vscode-descriptionForeground" role="status">
							Showing the newest {visibleEvents.length} events. {hiddenEventCount} older events are not
							rendered.
						</p>
					)}
				</aside>
			</div>
		</section>
	)
}

export type { ManagedAgentActivity } from "./managedAgentTreeAdapter"
