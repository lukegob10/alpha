import { AlphaCodeEventName, type SubagentGroupState } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readApiMessages } from "../../task-persistence/apiMessages"
import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

const fixtures: Array<Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>> = []

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	vi.restoreAllMocks()
})

describe("native parent steering while a Worker proposal remains quarantined", () => {
	it.each(["stop", "complete"] as const)(
		"continues automatically, retains human guidance and preserves the proposal after %s",
		async (finish) => {
			const fixture = await createManagedPublicLifecycleHarness()
			fixtures.push(fixture)
			const { root, store } = fixture
			await root.setTaskApprovalMode("ask")
			const first = fixture.queueTurn(root.taskId, "Wait for Worker results", [
				{ type: "tool_call", id: "review-boundary-wait", name: "wait_agent", arguments: "{}" },
			])
			const automaticRead = fixture.queueTurn(root.taskId, "Inspect the completed Worker before continuing.", [
				{
					type: "tool_call",
					id: "automatic-read",
					name: "list_agents",
					arguments: "{}",
				},
			])
			const guidedRead = fixture.queueTurn(
				root.taskId,
				"Inspect the alternate approach with the proposal pending.",
				[
					{
						type: "tool_call",
						id: "guided-read",
						name: "list_agents",
						arguments: "{}",
					},
				],
			)
			const replySummary = "Investigated the alternate approach while leaving the proposal pending."
			const reply = fixture.queueTurn(root.taskId, replySummary)
			root.start()
			await first.entered
			await store.ensureRoot({
				taskId: root.taskId,
				objective: "Coordinate pending Worker review",
				status: "running",
			})
			await store.createAgent({
				taskId: "saved-review-worker",
				parentTaskId: root.taskId,
				nickname: "Worker",
				role: "worker",
				objective: "Propose a bounded change",
				status: "completed",
			})
			const group: SubagentGroupState = {
				groupId: "saved-review-group",
				parentTaskId: root.taskId,
				status: "completed",
				createdAt: 1,
				completedAt: 2,
				agents: [
					{
						taskId: "saved-review-worker",
						nickname: "Worker",
						role: "worker",
						objective: "Propose a bounded change",
						status: "completed",
						changedFiles: ["pending.txt"],
						changeSet: {
							id: "saved-pending-proposal",
							status: "pending_review",
							changedFiles: ["pending.txt"],
							createdAt: 1,
							updatedAt: 2,
						},
						usage: { durationMs: 1 },
					},
				],
			}
			await root.upsertSubagentGroup(group)
			first.release()
			await automaticRead.entered
			expect(automaticRead.request).toBeDefined()
			expect(root["isAwaitingSubagentReview"]).toBe(false)
			const guidance = "Keep the proposal pending; investigate the alternate approach first."
			const queue = root.messageQueueService
			const acknowledgements = vi.spyOn(queue, "acknowledgeMessages")
			const completed = vi.fn()
			root.on(AlphaCodeEventName.TaskCompleted, completed)
			const queued = await queue.addMessageDurably(guidance, [], "review-guidance-receipt")
			expect(queued).toBeDefined()
			expect(queue.claimMessage(queued!.id)).toBeDefined()
			await queue.flush()
			await root.steerUserMessage(guidance, [], undefined, [queued!.id])
			await guidedRead.entered
			expect(guidedRead.request).toBeDefined()
			guidedRead.release()
			await reply.entered
			expect(reply.request).toBeDefined()
			expect(root["isAwaitingSubagentReview"]).toBe(false)
			await root.flushApiConversationHistoryPersistence()
			const history = await readApiMessages({ taskId: root.taskId, globalStoragePath: fixture.storagePath })
			const delivered = history.filter((message) => message.queued_message_ids?.includes(queued!.id))
			expect(delivered).toHaveLength(1)
			expect(delivered[0].input_origin).toBe("human")
			expect(JSON.stringify(delivered[0].content)).toContain(guidance)
			expect(queue.getClaimedMessageIds()).toEqual([])
			expect(acknowledgements.mock.calls.filter(([ids]) => ids.includes(queued!.id))).toHaveLength(1)
			expect(root["pendingSteerMessage"]).toBeUndefined()
			expect(root["steerMessageAwaitingPersistence"]).toBe(false)
			expect(root.isCompleted()).toBe(false)
			expect(root.getStepApprovalMode()).toBe("ask")
			const readResults = history.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter(
							(block) => block.type === "tool_result" && block.tool_use_id === "guided-read",
						)
					: [],
			)
			expect(readResults).toEqual([expect.objectContaining({ type: "tool_result", is_error: false })])
			expect(JSON.stringify(readResults)).toContain("saved-review-worker")
			expect(
				root.alphaMessages.find((message) => message.subagentGroup?.groupId === group.groupId)?.subagentGroup
					?.agents[0].changeSet?.status,
			).toBe("pending_review")
			expect(root.getExternalMutationCapability().allowed).toBe(false)
			if (finish === "stop") await root.abortTask(true)
			else reply.release()
			await root.waitForTermination()
			expect(root["isAwaitingSubagentReview"]).toBe(false)
			expect(root["agentWaitAbortController"]).toBeUndefined()
			expect(root.isCompleted()).toBe(finish === "complete")
			expect(completed).toHaveBeenCalledTimes(finish === "complete" ? 1 : 0)
			expect(
				root.alphaMessages.find((message) => message.subagentGroup?.groupId === group.groupId)?.subagentGroup
					?.agents[0].changeSet?.status,
			).toBe("pending_review")
			if (finish === "complete") {
				expect((await root.getCompletionGateDecision()).allowed).toBe(true)
				expect(root.getSubagentChangeSetDiscardCapability().allowed).toBe(true)
				const finalHistory = await readApiMessages({
					taskId: root.taskId,
					globalStoragePath: fixture.storagePath,
				})
				expect(JSON.stringify(finalHistory)).toContain(replySummary)
			}
		},
	)
})
