import { agentRuntimeOwnerIdSchema, type AgentControlState, type AgentRecord } from "@alpha-code/types"

export const AGENT_CONTROL_BENCHMARK_OWNER_ID = "agent-control-benchmark-owner"
export const AGENT_CONTROL_BENCHMARK_TIMESTAMP = 1_750_000_000_000
export const AGENT_CONTROL_BENCHMARK_DEFAULTS = {
	projectCount: 4,
	mailboxEntriesPerAgent: 4,
	mailboxPayloadBytes: 512,
	verificationObligationsPerAgent: 1,
	ownerId: AGENT_CONTROL_BENCHMARK_OWNER_ID,
} as const

export interface AgentControlBenchmarkFixtureOptions {
	/** Completed retained children, excluding the additional live project roots. */
	retainedAgentCount: number
	projectCount?: number
	mailboxEntriesPerAgent?: number
	/** UTF-8 bytes in each mailbox payload's ASCII body, excluding JSON metadata. */
	mailboxPayloadBytes?: number
	verificationObligationsPerAgent?: number
	ownerId?: string
}

export interface AgentControlBenchmarkProject {
	rootTaskId: string
	/** Synthetic POSIX path; the fixture never accesses a workspace. */
	workspacePath: string
}

export interface AgentControlBenchmarkFixture {
	state: AgentControlState
	projects: AgentControlBenchmarkProject[]
	options: Required<AgentControlBenchmarkFixtureOptions>
}

/**
 * Build outside timed sections. Keep the store's owner ID equal to options.ownerId
 * and provide live owner leases to avoid measuring abandoned-root recovery.
 */
export function buildAgentControlBenchmarkFixture(
	input: AgentControlBenchmarkFixtureOptions,
): AgentControlBenchmarkFixture {
	const options = { ...AGENT_CONTROL_BENCHMARK_DEFAULTS, ...input }
	for (const key of [
		"retainedAgentCount",
		"projectCount",
		"mailboxEntriesPerAgent",
		"mailboxPayloadBytes",
		"verificationObligationsPerAgent",
	] as const) {
		const minimum = key === "projectCount" ? 1 : 0
		if (!Number.isSafeInteger(options[key]) || options[key] < minimum) {
			throw new RangeError(`${key} must be a safe integer greater than or equal to ${minimum}`)
		}
	}
	agentRuntimeOwnerIdSchema.parse(options.ownerId)
	const at = AGENT_CONTROL_BENCHMARK_TIMESTAMP
	const projects = Array.from({ length: options.projectCount }, (_, index) => ({
		rootTaskId: `benchmark-root-${index + 1}`,
		workspacePath: `/benchmark/project-${index + 1}`,
	}))
	const state: AgentControlState = {
		version: 2,
		updatedAt: at,
		nextSequence: 1,
		agents: projects.map(({ rootTaskId, workspacePath }, index) => ({
			taskId: rootTaskId,
			rootTaskId,
			path: "/root",
			nickname: `Project ${index + 1}`,
			role: "root",
			objective: `Coordinate retained work in ${workspacePath}`,
			status: "running",
			runtimeOwnerId: options.ownerId,
			createdAt: at - 3,
			startedAt: at - 3,
			updatedAt: at,
		})),
		tombstones: [],
		mailbox: [],
		mailboxCursors: {},
		verificationObligations: [],
	}
	for (const { rootTaskId } of projects) {
		state.mailboxCursors[`${rootTaskId}:${rootTaskId}`] = {
			recipientTaskId: rootTaskId,
			recipientPath: "/root",
			lastDeliveredSequence: 0,
			lastAcknowledgedSequence: 0,
			updatedAt: at,
		}
	}
	const body = "x".repeat(options.mailboxPayloadBytes)
	for (let index = 0; index < options.retainedAgentCount; index++) {
		const { rootTaskId, workspacePath } = projects[index % projects.length]
		const taskId = `benchmark-worker-${index + 1}`
		const groupId = `${rootTaskId}-group`
		const worker: AgentRecord = {
			taskId,
			rootTaskId,
			parentTaskId: rootTaskId,
			parentPath: "/root",
			path: `/root/worker-${index + 1}`,
			groupId,
			nickname: `Worker ${index + 1}`,
			role: "worker",
			objective: `Implement retained work item ${index + 1}`,
			status: "completed",
			createdAt: at - 3,
			startedAt: at - 3,
			finishedAt: at - 2,
			updatedAt: at - 2,
			terminalResult: { status: "completed", summary: "Retained work completed", completedAt: at - 2 },
		}
		state.agents.push(worker)
		for (let message = 0; message < options.mailboxEntriesPerAgent; message++) {
			const sequence = state.nextSequence++
			state.mailbox.push({
				eventId: `benchmark-event-${sequence}`,
				sequence,
				rootTaskId,
				senderTaskId: taskId,
				senderPath: worker.path,
				recipientTaskId: rootTaskId,
				recipientPath: "/root",
				kind: "message",
				name: "agent.message",
				payload: { body },
				createdAt: at - 1,
				deliveredAt: at,
				acknowledgedAt: at,
			})
			const cursor = state.mailboxCursors[`${rootTaskId}:${rootTaskId}`]
			cursor.lastDeliveredSequence = sequence
			cursor.lastAcknowledgedSequence = sequence
		}
		for (let obligation = 0; obligation < options.verificationObligationsPerAgent; obligation++) {
			const changeSetId = `${taskId}-change-${obligation + 1}`
			state.verificationObligations.push({
				id: `worker-change:${changeSetId}`,
				changeSetId,
				origin: "worker",
				rootTaskId,
				parentTaskId: rootTaskId,
				workspacePath,
				workerTaskId: taskId,
				workerPath: worker.path,
				workerNickname: worker.nickname,
				groupId,
				changedFiles: [`src/worker-${index + 1}/change-${obligation + 1}.ts`],
				status: "pending",
				review: { decision: "approved", source: "apply", recordedAt: at - 1 },
				createdAt: at - 2,
				updatedAt: at - 1,
				appliedAt: at - 1,
			})
		}
	}
	return { state, projects, options }
}
