import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRecord } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { buildInternalTaskEnvelope } from "../../agent/InternalTaskEnvelope"
import type { PreparedSubagentGroup } from "../../agent/SubagentDelegation"
import type { Task } from "../../task/Task"

const stores: AgentControlStore[] = []

afterEach(async () => {
	for (const store of stores.splice(0)) await store.shutdown()
})

type RestorePrepared = (
	this: AlphaProvider,
	parent: Task,
	record: AgentRecord,
	instruction: string,
) => Promise<PreparedSubagentGroup>

const restorePrepared = Reflect.get(AlphaProvider.prototype, "restorePreparedSubagentForFollowup") as RestorePrepared

async function createFixture(retainDescriptor = false) {
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	stores.push(store)
	await store.initialize()
	await store.ensureRoot({ taskId: "restore-parent", objective: "Verify the retained child" })
	const record = await store.createAgent({
		taskId: "restore-child",
		parentTaskId: "restore-parent",
		groupId: "retained-group",
		nickname: "Reviewer",
		role: "review",
		objective: "Review the retained report",
		status: "completed",
	})
	const parent = {
		taskId: record.parentTaskId,
		alphaMessages: [{ ts: 1, type: "say", say: "text", text: "Retained parent history" }],
	} as unknown as Task
	const prepared: PreparedSubagentGroup = {
		group: {
			groupId: "retained-group",
			parentTaskId: parent.taskId,
			status: "completed",
			createdAt: 1,
			completedAt: 2,
			agents: [
				{
					taskId: record.taskId,
					nickname: record.nickname,
					role: "review",
					objective: record.objective,
					status: "completed",
					usage: { durationMs: 1 },
				},
			],
		},
		envelopes: [
			buildInternalTaskEnvelope({
				id: record.taskId,
				parentTaskId: parent.taskId,
				objective: record.objective,
				agentKind: "review",
				workspaceRoots: [process.cwd()],
				parentPolicy: {
					read: true,
					execute: false,
					mutate: false,
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: true,
				},
				requestedPolicy: {},
			}),
		],
	}
	const durableFailure = new Error("Controlled durable child-history read failure")
	const getTaskWithId = vi.fn<AlphaProvider["getTaskWithId"]>().mockRejectedValue(durableFailure)
	const descriptors = new Map<string, { groupId: string }>()
	if (retainDescriptor) descriptors.set(record.taskId, { groupId: prepared.group.groupId })
	const groups = new Map([[prepared.group.groupId, prepared]])
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		preparedSubagentGroups: groups,
		subagentDescriptors: descriptors,
		taskSessions: { getAvailableTaskCapacity: () => 1 },
		getLiveTask: vi.fn(() => undefined),
		getTaskWithId,
	}) as AlphaProvider
	return { provider, parent, record, prepared, groups, descriptors, durableFailure, getTaskWithId }
}

describe("AlphaProvider retained follow-up descriptor boundary", () => {
	it("uses durable restoration when a retained single-agent group outlives its descriptor", async () => {
		const fixture = await createFixture()
		expect(fixture.groups.get(fixture.prepared.group.groupId)).toBe(fixture.prepared)
		expect(fixture.descriptors.has(fixture.record.taskId)).toBe(false)

		await expect(
			restorePrepared.call(fixture.provider, fixture.parent, fixture.record, "Verify again"),
		).rejects.toBe(fixture.durableFailure)

		expect(fixture.getTaskWithId).toHaveBeenCalledExactlyOnceWith(fixture.record.taskId, {
			includeApiConversationHistory: false,
		})
		expect(fixture.groups.get(fixture.prepared.group.groupId)).toBe(fixture.prepared)
		expect(fixture.descriptors.has(fixture.record.taskId)).toBe(false)
	})

	it("preserves the existing retained fast path while its descriptor exists", async () => {
		const fixture = await createFixture(true)

		await expect(
			restorePrepared.call(fixture.provider, fixture.parent, fixture.record, "Verify again"),
		).resolves.toBe(fixture.prepared)

		expect(fixture.getTaskWithId).not.toHaveBeenCalled()
		expect(fixture.descriptors.get(fixture.record.taskId)).toEqual({ groupId: fixture.prepared.group.groupId })
	})

	it("uses the same durable boundary when no prepared group is cached", async () => {
		const fixture = await createFixture()
		fixture.groups.clear()

		await expect(
			restorePrepared.call(fixture.provider, fixture.parent, fixture.record, "Verify again"),
		).rejects.toBe(fixture.durableFailure)

		expect(fixture.getTaskWithId).toHaveBeenCalledExactlyOnceWith(fixture.record.taskId, {
			includeApiConversationHistory: false,
		})
	})

	it.each([false, true])("rejects a foreign parent before restoring with descriptor present=%s", async (present) => {
		const fixture = await createFixture(present)
		fixture.prepared.group.parentTaskId = "different-parent"

		await expect(
			restorePrepared.call(fixture.provider, fixture.parent, fixture.record, "Verify again"),
		).rejects.toThrow("retained a group from a different parent task")

		expect(fixture.getTaskWithId).not.toHaveBeenCalled()
	})
})
