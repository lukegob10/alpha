import { AlphaCodeEventName, type SubagentGroupState } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readApiMessages } from "../../task-persistence/apiMessages"
import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

const fixtures: Array<Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>> = []

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	vi.restoreAllMocks()
})

describe("native parent steering while a Worker proposal awaits review", () => {
	it.each(["stop", "discard"] as const)(
		"delivers human-guided tool work while review is pending and clears ownership after %s",
		async (finish) => {
			const fixture = await createManagedPublicLifecycleHarness()
			fixtures.push(fixture)
			const { root, provider, store } = fixture
			await root.setTaskApprovalMode("ask")
			const first = fixture.queueTurn(root.taskId, "Wait for Worker results", [
				{ type: "tool_call", id: "review-boundary-wait", name: "wait_agent", arguments: "{}" },
			])
			const followup = fixture.queueTurn(root.taskId, "Inspect the completed Worker before continuing.", [
				{
					type: "tool_call",
					id: "guided-read",
					name: "list_agents",
					arguments: "{}",
				},
			])
			const replySummary = "Incorporated the human guidance after inspecting the Worker state."
			const reply = fixture.queueTurn(root.taskId, replySummary)
			const furtherReply = fixture.queueTurn(
				root.taskId,
				"Incorporated the second instruction without approving the proposal.",
			)
			let reviewEntered = deferred()
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementation(async () => {
				if (root["isAwaitingSubagentReview"]) reviewEntered.resolve()
			})
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
			await reviewEntered.promise
			expect(followup.request).toBeUndefined()
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
			await followup.entered
			expect(followup.request).toBeDefined()
			followup.release()
			await reply.entered
			expect(reply.request).toBeDefined()
			// Each reply must reach its own review publication; a previous review
			// flag is insufficient evidence that this response has drained.
			reviewEntered = deferred()
			reply.release()
			await reviewEntered.promise
			expect(root["isAwaitingSubagentReview"]).toBe(true)
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
			expect(JSON.stringify(history)).toContain(reply.summary)
			expect(
				root.alphaMessages.find((message) => message.subagentGroup?.groupId === group.groupId)?.subagentGroup
					?.agents[0].changeSet?.status,
			).toBe("pending_review")
			expect((await root.getCompletionGateDecision()).allowed).toBe(false)
			expect(root.getExternalMutationCapability().allowed).toBe(true)
			await root.steerUserMessage("Also inspect the status before reviewing the proposal.")
			await furtherReply.entered
			expect(furtherReply.request).toBeDefined()
			expect(root.getExternalMutationCapability().allowed).toBe(false)
			reviewEntered = deferred()
			furtherReply.release()
			await reviewEntered.promise
			expect(root["isAwaitingSubagentReview"]).toBe(true)
			expect(root.isCompleted()).toBe(false)
			expect(root["subagentReviewInputTurn"]).toBeDefined()
			if (finish === "stop") await root.abortTask(true)
			else {
				const lease = root.acquireSubagentChangeSetDiscard("settling the pending proposal")
				expect(lease.release).toBeTypeOf("function")
				group.agents[0].changeSet!.status = "discarded"
				await root.upsertSubagentGroup(group)
				expect(root.isCompleted()).toBe(false)
				lease.release!()
				lease.release!()
			}
			await root.waitForTermination()
			expect(root["subagentReviewInputTurn"]).toBeUndefined()
			expect(root["agentWaitAbortController"]).toBeUndefined()
			expect(root.isCompleted()).toBe(finish === "discard")
			expect(completed).toHaveBeenCalledTimes(finish === "discard" ? 1 : 0)
		},
	)
})
