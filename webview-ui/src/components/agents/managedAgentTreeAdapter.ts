import type {
	LiveTaskMetadata,
	ManagedAgentTreeProjection,
	SubagentGroupState,
	SubagentRole,
	SubagentRunState,
} from "@alpha-code/types"

export type ManagedAgentStatus = SubagentRunState["status"] | "unknown"

export interface ManagedAgentNode {
	taskId: string
	parentTaskId: string
	path: string
	nickname: string
	role: SubagentRole
	status: ManagedAgentStatus
	depth: number
	attention?: string
}

export interface ManagedAgentTreeAdapterInput {
	rootTaskId: string
	groups?: readonly SubagentGroupState[]
	projection?: ManagedAgentTreeProjection
	liveTasksById?: Readonly<Record<string, LiveTaskMetadata>>
}

export interface ManagedAgentTreeModel {
	nodes: ManagedAgentNode[]
	omittedNodeCount: number
}

interface AgentCandidate {
	agent: SubagentRunState
	group: SubagentGroupState
	order: number
}

const groupObservedAt = (group: SubagentGroupState): number =>
	Math.max(group.completedAt ?? 0, group.startedAt ?? 0, group.createdAt)

const dedupeGroups = (groups: readonly SubagentGroupState[]): SubagentGroupState[] => {
	const latest = new Map<string, { group: SubagentGroupState; index: number }>()
	groups.forEach((group, index) => {
		const current = latest.get(group.groupId)
		if (
			!current ||
			groupObservedAt(group) > groupObservedAt(current.group) ||
			(groupObservedAt(group) === groupObservedAt(current.group) && index > current.index)
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
			if (agent.taskId !== rootTaskId) latest.set(agent.taskId, { agent, group, order })
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

const slugify = (value: string): string => {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return slug || "agent"
}

const createPathResolver = (
	candidates: readonly AgentCandidate[],
	parents: ReadonlyMap<string, string>,
	rootTaskId: string,
) => {
	const candidateById = new Map(candidates.map((candidate) => [candidate.agent.taskId, candidate]))
	const paths = new Map<string, string>([[rootTaskId, "/root"]])
	const usedByParent = new Map<string, Set<string>>()

	const resolve = (taskId: string): string => {
		const existing = paths.get(taskId)
		if (existing) return existing

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

const buildProjectedTreeModel = (
	projection: ManagedAgentTreeProjection,
	rootTaskId: string,
): ManagedAgentTreeModel => ({
	nodes: projection.nodes.flatMap((node) =>
		node.taskId === rootTaskId || node.role === "root"
			? []
			: [
					{
						taskId: node.taskId,
						parentTaskId: node.parentTaskId ?? rootTaskId,
						path: node.path,
						nickname: node.nickname,
						role: node.role,
						status: node.status,
						depth: node.depth,
						attention: node.attention?.label,
					},
				],
	),
	omittedNodeCount: projection.omittedNodeCount,
})

export function buildManagedAgentTreeModel(input: ManagedAgentTreeAdapterInput): ManagedAgentTreeModel {
	if (input.projection?.rootTaskId === input.rootTaskId) {
		return buildProjectedTreeModel(input.projection, input.rootTaskId)
	}

	const candidates = collectAgents(input.groups ?? [], input.rootTaskId)
	const parents = normalizeParentIds(candidates, input.rootTaskId)
	const resolvePath = createPathResolver(candidates, parents, input.rootTaskId)
	const nodes = candidates.map(({ agent }): ManagedAgentNode => {
		const liveTask = input.liveTasksById?.[agent.taskId]
		return {
			taskId: agent.taskId,
			parentTaskId: parents.get(agent.taskId) ?? input.rootTaskId,
			path: resolvePath(agent.taskId),
			nickname: agent.nickname,
			role: agent.role,
			status: agent.status,
			depth: depthFor(agent.taskId, parents, input.rootTaskId),
			attention: agent.pendingApproval
				? `Waiting for approval: ${agent.pendingApproval.operation}`
				: liveTask?.isWaitingForInput
					? liveTask.waitingReason || "Waiting for input"
					: undefined,
		}
	})

	return { nodes, omittedNodeCount: 0 }
}
