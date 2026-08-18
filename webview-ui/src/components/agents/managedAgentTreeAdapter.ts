import type { LiveTaskMetadata, SubagentGroupState, SubagentRole, SubagentRunState } from "@alpha-code/types"

export type ManagedAgentStatus = SubagentRunState["status"] | "unknown"
export type ManagedAgentState = "queued" | "running" | "terminal" | "unknown"

export interface ManagedAgentActivity {
	id: string
	createdAt: number
	summary: string
	taskId?: string
	kind?: "lifecycle" | "message" | "followup" | "control" | "result" | "status"
	name?: string
	sender?: string
	unread?: boolean
}

export interface ManagedAgentUsage {
	inputTokens?: number
	outputTokens?: number
	totalCost?: number
	durationMs?: number
}

export type ManagedAgentEffectiveLimits = Readonly<Record<string, unknown>>

/**
 * Optional bridge for the durable registry projection. Group snapshots remain
 * the compatibility source until this projection is posted to the webview.
 */
export interface ManagedAgentRuntimeProjection {
	path?: string
	depth?: number
	maxDepth?: number
	delegationPolicy?: string
	effectiveLimits?: ManagedAgentEffectiveLimits
	stopReason?: unknown
	contextManifest?: {
		orchestration?: {
			ancestry?: readonly string[]
			delegationPolicy?: string
			limits?: ManagedAgentEffectiveLimits
		}
	}
}

export interface ManagedAgentNode {
	taskId: string
	parentTaskId?: string
	groupId?: string
	path: string
	nickname: string
	role: "root" | SubagentRole
	objective: string
	status: ManagedAgentStatus
	state: ManagedAgentState
	phase?: SubagentRunState["phase"]
	depth: number
	createdAt: number
	updatedAt: number
	startedAt?: number
	finishedAt?: number
	usage: ManagedAgentUsage
	stopReason?: string
	attention?: string
	canCancel: boolean
	maxDepth?: number
	delegationPolicy?: string
	effectiveLimits?: ManagedAgentEffectiveLimits
}

export interface ManagedAgentTreeAdapterInput {
	rootTaskId: string
	rootLabel?: string
	rootStartedAt?: number
	groups?: readonly SubagentGroupState[]
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
	pathsByTaskId?: Readonly<Record<string, string>>
	stopReasonsByTaskId?: Readonly<Record<string, string>>
	runtimeByTaskId?: Readonly<Record<string, ManagedAgentRuntimeProjection>>
	capacityLimit?: number
	tokenBudget?: number | null
	costBudget?: number | null
	activity?: readonly ManagedAgentActivity[]
	reloadedAt?: number
}

export interface ManagedAgentTreeModel {
	rootTaskId: string
	nodes: ManagedAgentNode[]
	activity: ManagedAgentActivity[]
	activityReported: boolean
	updatedAt?: number
	reloadedAt?: number
	capacity: {
		active: number
		queued: number
		terminal: number
		limit?: number
	}
	usage: {
		inputTokens: number
		outputTokens: number
		totalTokens: number
		totalCost: number
		tokensReported: boolean
		costReported: boolean
	}
	budgets: {
		tokenLimit?: number | null
		costLimit?: number | null
	}
}

interface AgentCandidate {
	agent: SubagentRunState
	group: SubagentGroupState
	order: number
}

const terminalStatuses = new Set<ManagedAgentStatus>([
	"completed",
	"blocked",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
])

const safeNonNegative = (value: number | undefined): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const safePositive = (value: number | undefined): number | undefined => {
	const normalized = safeNonNegative(value)
	return normalized !== undefined && normalized > 0 ? normalized : undefined
}

const normalizeOptionalBudget = (value: number | null | undefined): number | null | undefined =>
	value === null ? null : safePositive(value)

const statusState = (status: ManagedAgentStatus): ManagedAgentState => {
	if (status === "pending") return "queued"
	if (terminalStatuses.has(status)) return "terminal"
	if (status === "unknown") return "unknown"
	return "running"
}

const rootStatusFromLiveTask = (task: LiveTaskMetadata | undefined): ManagedAgentStatus => {
	if (!task) return "unknown"
	switch (task.lifecycle) {
		case "initializing":
			return "pending"
		case "running":
		case "waiting":
			return "running"
		case "failed":
			return "failed"
		case "closing":
			return "cancelling"
		case "closed":
		case "completed":
			return "completed"
		default:
			return "unknown"
	}
}

const fallbackStopReason = (agent: SubagentRunState): string | undefined => {
	switch (agent.status) {
		case "completed":
			return "Completed normally"
		case "blocked":
			return agent.error || agent.summary || "Blocked before completion"
		case "failed":
			return agent.error || "Agent run failed"
		case "cancelled":
			return agent.error || "Cancelled by the parent task"
		case "timed_out":
			return agent.error || "Time limit reached"
		case "interrupted":
			return agent.error || "Interrupted by the parent task"
		default:
			return undefined
	}
}

const stopReasonLabels: Readonly<Record<string, string>> = {
	timeout: "Time limit reached",
	timed_out: "Time limit reached",
	input_token_limit: "Input token limit reached",
	output_token_limit: "Output token limit reached",
	root_token_budget: "Root token budget reached",
	root_cost_budget: "Root cost budget reached",
	depth_denied: "Maximum nesting depth reached",
	depth_limit: "Maximum nesting depth reached",
	authority_denied: "Delegation authority denied",
	ancestor_cancelled: "Cancelled with an ancestor",
	orphaned: "Stopped during orphan recovery",
	recovery_failed: "Recovery failed",
	cancelled: "Cancelled by the parent task",
	failed: "Agent run failed",
	completed: "Completed normally",
}

const normalizeStopReason = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim()
		if (!trimmed) return undefined
		return stopReasonLabels[trimmed.toLowerCase()] ?? trimmed.replaceAll("_", " ")
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		if (typeof record.message === "string" && record.message.trim()) return record.message.trim()
		if (typeof record.code === "string" && record.code.trim()) {
			const code = record.code.trim()
			return stopReasonLabels[code.toLowerCase()] ?? code.replaceAll("_", " ")
		}
		return "Runtime stopped this agent; details were not recognized"
	}
	return value === undefined || value === null ? undefined : "Runtime stopped this agent; details were not reported"
}

const slugify = (value: string): string => {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return slug || "agent"
}

const mostRecentTimestamp = (group: SubagentGroupState): number =>
	group.completedAt ?? group.startedAt ?? group.createdAt

const dedupeGroups = (groups: readonly SubagentGroupState[]): SubagentGroupState[] => {
	const latest = new Map<string, { group: SubagentGroupState; index: number }>()
	groups.forEach((group, index) => {
		const existing = latest.get(group.groupId)
		if (
			!existing ||
			mostRecentTimestamp(group) > mostRecentTimestamp(existing.group) ||
			(mostRecentTimestamp(group) === mostRecentTimestamp(existing.group) && index > existing.index)
		) {
			latest.set(group.groupId, { group, index })
		}
	})
	return [...latest.values()].sort((left, right) => left.index - right.index).map(({ group }) => group)
}

const collectAgents = (groups: readonly SubagentGroupState[], rootTaskId: string): AgentCandidate[] => {
	const latest = new Map<string, AgentCandidate>()
	let order = 0
	for (const group of dedupeGroups(groups)) {
		for (const agent of group.agents) {
			if (agent.taskId === rootTaskId) continue
			latest.set(agent.taskId, { agent, group, order })
			order += 1
		}
	}
	return [...latest.values()].sort((left, right) => left.order - right.order)
}

const normalizeParentIds = (candidates: readonly AgentCandidate[], rootTaskId: string): ReadonlyMap<string, string> => {
	const knownTaskIds = new Set(candidates.map(({ agent }) => agent.taskId))
	const rawParents = new Map(
		candidates.map(({ agent, group }) => [
			agent.taskId,
			group.parentTaskId === agent.taskId || !knownTaskIds.has(group.parentTaskId)
				? rootTaskId
				: group.parentTaskId,
		]),
	)

	const normalized = new Map<string, string>()
	for (const { agent } of candidates) {
		let cursor = agent.taskId
		const visited = new Set<string>()
		let cyclic = false
		while (cursor !== rootTaskId) {
			if (visited.has(cursor)) {
				cyclic = true
				break
			}
			visited.add(cursor)
			cursor = rawParents.get(cursor) ?? rootTaskId
		}
		normalized.set(agent.taskId, cyclic ? rootTaskId : (rawParents.get(agent.taskId) ?? rootTaskId))
	}
	return normalized
}

const createPathResolver = (
	candidates: readonly AgentCandidate[],
	parents: ReadonlyMap<string, string>,
	rootTaskId: string,
	pathsByTaskId: Readonly<Record<string, string>> | undefined,
) => {
	const candidateById = new Map(candidates.map((candidate) => [candidate.agent.taskId, candidate]))
	const paths = new Map<string, string>([[rootTaskId, "/root"]])
	const usedByParent = new Map<string, Set<string>>()

	const resolve = (taskId: string): string => {
		const existing = paths.get(taskId)
		if (existing) return existing

		const supplied = pathsByTaskId?.[taskId]
		if (supplied?.startsWith("/root/")) {
			paths.set(taskId, supplied)
			return supplied
		}

		const candidate = candidateById.get(taskId)
		if (!candidate) return "/root"
		const parentId = parents.get(taskId) ?? rootTaskId
		const parentPath = resolve(parentId)
		const used = usedByParent.get(parentId) ?? new Set<string>()
		usedByParent.set(parentId, used)
		const base = slugify(candidate.agent.nickname)
		let segment = base
		let suffix = 2
		while (used.has(segment)) {
			segment = `${base}-${suffix}`
			suffix += 1
		}
		used.add(segment)
		const path = `${parentPath}/${segment}`
		paths.set(taskId, path)
		return path
	}

	return resolve
}

const depthFor = (taskId: string, parents: ReadonlyMap<string, string>, rootTaskId: string): number => {
	let depth = 0
	let cursor = taskId
	const visited = new Set<string>()
	while (cursor !== rootTaskId && !visited.has(cursor)) {
		visited.add(cursor)
		depth += 1
		cursor = parents.get(cursor) ?? rootTaskId
	}
	return depth
}

const childUsage = (agent: SubagentRunState, liveTask: LiveTaskMetadata | undefined): ManagedAgentUsage => ({
	inputTokens: liveTask ? safeNonNegative(liveTask.tokensIn) : safeNonNegative(agent.usage.inputTokens),
	outputTokens: liveTask ? safeNonNegative(liveTask.tokensOut) : safeNonNegative(agent.usage.outputTokens),
	totalCost: liveTask ? safeNonNegative(liveTask.totalCost) : undefined,
	durationMs: safeNonNegative(agent.usage.durationMs),
})

const rootUsage = (liveTask: LiveTaskMetadata | undefined): ManagedAgentUsage => ({
	inputTokens: liveTask ? safeNonNegative(liveTask.tokensIn) : undefined,
	outputTokens: liveTask ? safeNonNegative(liveTask.tokensOut) : undefined,
	totalCost: liveTask ? safeNonNegative(liveTask.totalCost) : undefined,
})

const sumUsage = (nodes: readonly ManagedAgentNode[]) => {
	let inputTokens = 0
	let outputTokens = 0
	let totalCost = 0
	let tokensReported = false
	let costReported = false
	for (const node of nodes) {
		if (node.usage.inputTokens !== undefined) {
			inputTokens += node.usage.inputTokens
			tokensReported = true
		}
		if (node.usage.outputTokens !== undefined) {
			outputTokens += node.usage.outputTokens
			tokensReported = true
		}
		if (node.usage.totalCost !== undefined) {
			totalCost += node.usage.totalCost
			costReported = true
		}
	}
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		totalCost,
		tokensReported,
		costReported,
	}
}

export function buildManagedAgentTreeModel(input: ManagedAgentTreeAdapterInput): ManagedAgentTreeModel {
	const groups = input.groups ?? []
	const liveTasksById = input.liveTasksById ?? {}
	const candidates = collectAgents(groups, input.rootTaskId)
	const parents = normalizeParentIds(candidates, input.rootTaskId)
	const runtimePaths = Object.fromEntries(
		Object.entries(input.runtimeByTaskId ?? {}).flatMap(([taskId, projection]) =>
			projection.path ? [[taskId, projection.path]] : [],
		),
	)
	const resolvePath = createPathResolver(candidates, parents, input.rootTaskId, {
		...runtimePaths,
		...input.pathsByTaskId,
	})
	const rootLiveTask = liveTasksById[input.rootTaskId]
	const rootRuntime = input.runtimeByTaskId?.[input.rootTaskId]
	const rootStatus = rootStatusFromLiveTask(rootLiveTask)
	const rootStartedAt = input.rootStartedAt ?? rootLiveTask?.lastUpdatedAt
	const root: ManagedAgentNode = {
		taskId: input.rootTaskId,
		path: "/root",
		nickname: input.rootLabel?.trim() || "Root task",
		role: "root",
		objective: "Coordinates managed descendants",
		status: rootStatus,
		state: statusState(rootStatus),
		depth: 0,
		createdAt: rootStartedAt ?? 0,
		updatedAt: rootLiveTask?.lastUpdatedAt ?? rootStartedAt ?? 0,
		startedAt: rootStartedAt,
		finishedAt: terminalStatuses.has(rootStatus) ? rootLiveTask?.lastUpdatedAt : undefined,
		usage: rootUsage(rootLiveTask),
		stopReason:
			normalizeStopReason(rootRuntime?.stopReason) ??
			input.stopReasonsByTaskId?.[input.rootTaskId] ??
			(rootStatus === "completed" ? "Completed normally" : rootStatus === "failed" ? "Task failed" : undefined),
		attention: rootLiveTask?.isWaitingForInput ? rootLiveTask.waitingReason || "Waiting for input" : undefined,
		canCancel: false,
		maxDepth: safeNonNegative(rootRuntime?.maxDepth),
		delegationPolicy:
			rootRuntime?.delegationPolicy ?? rootRuntime?.contextManifest?.orchestration?.delegationPolicy,
		effectiveLimits: rootRuntime?.effectiveLimits ?? rootRuntime?.contextManifest?.orchestration?.limits,
	}

	const descendants = candidates.map(({ agent, group }): ManagedAgentNode => {
		const liveTask = liveTasksById[agent.taskId]
		const runtime = input.runtimeByTaskId?.[agent.taskId]
		const parentTaskId = parents.get(agent.taskId) ?? input.rootTaskId
		const updatedAt = Math.max(
			group.createdAt,
			agent.phaseStartedAt ?? 0,
			agent.startedAt ?? 0,
			agent.completedAt ?? 0,
			liveTask?.lastUpdatedAt ?? 0,
		)
		return {
			taskId: agent.taskId,
			parentTaskId,
			groupId: group.groupId,
			path: resolvePath(agent.taskId),
			nickname: agent.nickname,
			role: agent.role,
			objective: agent.objective,
			status: agent.status,
			state: statusState(agent.status),
			phase: agent.phase,
			depth:
				typeof runtime?.depth === "number" && Number.isInteger(runtime.depth) && runtime.depth >= 0
					? runtime.depth
					: depthFor(agent.taskId, parents, input.rootTaskId),
			createdAt: group.createdAt,
			updatedAt,
			startedAt: agent.startedAt,
			finishedAt: agent.completedAt,
			usage: childUsage(agent, liveTask),
			stopReason:
				normalizeStopReason(runtime?.stopReason) ??
				input.stopReasonsByTaskId?.[agent.taskId] ??
				fallbackStopReason(agent),
			attention: agent.pendingApproval
				? `Waiting for approval: ${agent.pendingApproval.operation}`
				: liveTask?.isWaitingForInput
					? liveTask.waitingReason || "Waiting for input"
					: undefined,
			canCancel: agent.status === "pending" || agent.status === "running",
			maxDepth: safeNonNegative(runtime?.maxDepth),
			delegationPolicy: runtime?.delegationPolicy ?? runtime?.contextManifest?.orchestration?.delegationPolicy,
			effectiveLimits: runtime?.effectiveLimits ?? runtime?.contextManifest?.orchestration?.limits,
		}
	})

	const nodes = [root, ...descendants]
	// Root guardrails govern the descendant tree; the coordinating parent does
	// not consume one of its own child slots or its managed-child token budget.
	const active = descendants.filter((node) => node.state === "running").length
	const queued = descendants.filter((node) => node.state === "queued").length
	const terminal = descendants.filter((node) => node.state === "terminal").length
	const updatedAtValues = [
		...nodes.map((node) => node.updatedAt),
		...(input.activity ?? []).map((entry) => entry.createdAt),
	].filter((value) => value > 0)

	return {
		rootTaskId: input.rootTaskId,
		nodes,
		activity: input.activity ? [...input.activity].sort((left, right) => right.createdAt - left.createdAt) : [],
		activityReported: input.activity !== undefined,
		updatedAt: updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : undefined,
		reloadedAt: input.reloadedAt,
		capacity: {
			active,
			queued,
			terminal,
			limit: safePositive(input.capacityLimit),
		},
		usage: sumUsage(descendants),
		budgets: {
			tokenLimit: normalizeOptionalBudget(input.tokenBudget),
			costLimit: normalizeOptionalBudget(input.costBudget),
		},
	}
}

export const isManagedAgentTerminal = (status: ManagedAgentStatus): boolean => terminalStatuses.has(status)
