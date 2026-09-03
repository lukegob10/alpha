import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import {
	AgentControlStore,
	FileAgentControlPersistence,
	InMemoryAgentControlPersistence,
	type AgentControlPersistence,
} from "../AgentControlStore"

const clock = (initial = 1_000) => {
	let current = initial
	return () => ++current
}

const setup = async (persistence: AgentControlPersistence = new InMemoryAgentControlPersistence()) => {
	const store = new AgentControlStore(persistence, clock())
	await store.initialize()
	await store.ensureRoot({ taskId: "root-1", objective: "Coordinate work", status: "running" })
	return { store, persistence }
}

describe("AgentControlStore", () => {
	const workerChangeSet = (
		id: string,
		status: "pending_review" | "conflicted" | "applied" | "discarded" | "scope_violation" | "unavailable",
		changedFiles = ["src/example.ts"],
		updatedAt = 2_000,
	) => ({ id, status, changedFiles, createdAt: 1_500, updatedAt })

	const recordWorker = (
		store: AgentControlStore,
		changeSet: ReturnType<typeof workerChangeSet>,
		override: Partial<Parameters<AgentControlStore["recordWorkerChangeSet"]>[0]> = {},
	) =>
		store.recordWorkerChangeSet({
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			workerTaskId: "worker-1",
			workerPath: "/root/worker",
			workerNickname: "Worker",
			groupId: "group-1",
			changeSet,
			at: changeSet.updatedAt,
			...override,
		})

	it("enforces the durable review and verification completion state machine idempotently", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
			status: "completed",
		})

		const quarantined = await recordWorker(store, workerChangeSet("change-1", "pending_review"))
		expect(quarantined).toMatchObject({ changed: true, obligation: { status: "required" } })
		expect(store.getParentCompletionDecision("root-1")).toMatchObject({ allowed: true })
		expect(await recordWorker(store, workerChangeSet("change-1", "pending_review"))).toMatchObject({
			changed: false,
		})

		const applied = await recordWorker(store, workerChangeSet("change-1", "applied", undefined, 2_100), {
			reviewSource: "apply",
		})
		expect(applied).toMatchObject({
			changed: true,
			previousStatus: "required",
			obligation: { status: "pending", review: { decision: "approved", source: "apply" } },
		})
		expect(store.getParentCompletionDecision("root-1")).toMatchObject({
			allowed: false,
			message: expect.stringContaining("change-1"),
		})

		await store.closeAgent("worker-1")
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "too-early",
					executionId: "execution-early",
					status: "succeeded",
					command: "node scripts/verify.js src/example.ts",
					verificationChangeSetIds: ["change-1"],
					startedAt: 2_099,
					completedAt: 2_101,
				},
			]),
		).toEqual([])
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "unscoped-echo",
					executionId: "execution-unrelated",
					status: "succeeded",
					command: "echo src/example.ts",
					startedAt: 2_101,
					completedAt: 2_102,
					exitCode: 0,
				},
			]),
		).toEqual([])
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "wrong-scope",
					executionId: "execution-wrong-scope",
					status: "succeeded",
					command: "pnpm test",
					verificationChangeSetIds: ["another-change"],
					startedAt: 2_102,
					completedAt: 2_103,
					exitCode: 0,
				},
			]),
		).toEqual([])

		const failed = await store.recordParentVerificationEvidence("root-1", [
			{
				toolCallId: "verify-failed",
				executionId: "execution-failed",
				status: "failed",
				command: "node scripts/verify.js src/example.ts",
				verificationChangeSetIds: ["change-1"],
				startedAt: 2_101,
				completedAt: 2_102,
				exitCode: 1,
			},
		])
		expect(failed).toMatchObject([{ status: "failed", verification: { status: "failed" } }])
		expect(store.getParentCompletionDecision("root-1").message).toContain(
			"latest scoped verification command failed",
		)
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "verify-failed",
					executionId: "execution-failed",
					status: "failed",
					command: "node scripts/verify.js src/example.ts",
					verificationChangeSetIds: ["change-1"],
					startedAt: 2_101,
					completedAt: 2_102,
					exitCode: 1,
				},
			]),
		).toEqual([])

		const satisfied = await store.recordParentVerificationEvidence("root-1", [
			{
				toolCallId: "verify-passed",
				executionId: "execution-passed",
				status: "succeeded",
				command: "pnpm test",
				verificationChangeSetIds: ["change-1"],
				startedAt: 2_103,
				completedAt: 2_104,
				exitCode: 0,
			},
		])
		expect(satisfied).toMatchObject([
			{ status: "satisfied", verification: { status: "passed", matchedFiles: ["src/example.ts"] } },
		])
		expect(store.getParentCompletionDecision("root-1")).toEqual({
			allowed: true,
			blockingObligations: [],
		})

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		expect(reloaded.getVerificationObligations({ parentTaskId: "root-1" })).toEqual(
			store.getVerificationObligations({ parentTaskId: "root-1" }),
		)
		expect(reloaded.getWorkerVerificationSummary("worker-1")).toMatchObject({
			status: "satisfied",
			blocking: false,
		})
	})

	it("aggregates multiple Workers without blocking on no-change, discarded, or superseded proposals", async () => {
		const { store } = await setup()
		expect(await recordWorker(store, workerChangeSet("no-change", "unavailable", []))).toEqual({
			changed: false,
		})

		await recordWorker(store, workerChangeSet("old-proposal", "pending_review"))
		await recordWorker(store, workerChangeSet("replacement", "pending_review", ["src/replacement.ts"], 2_100))
		expect(store.getVerificationObligations({ workerTaskId: "worker-1" })).toMatchObject([
			{ changeSetId: "old-proposal", status: "superseded", supersededByChangeSetId: "replacement" },
			{ changeSetId: "replacement", status: "required" },
		])
		await recordWorker(store, workerChangeSet("replacement", "discarded", ["src/replacement.ts"], 2_200), {
			reviewSource: "discard",
		})

		await recordWorker(store, workerChangeSet("applied-1", "applied", ["src/one.ts"], 3_000), {
			workerTaskId: "worker-2",
			workerNickname: "Worker Two",
			groupId: "group-2",
			reviewSource: "apply",
		})
		await recordWorker(store, workerChangeSet("applied-2", "applied", ["src/two.ts"], 3_100), {
			workerTaskId: "worker-3",
			workerNickname: "Worker Three",
			groupId: "group-3",
			reviewSource: "apply",
		})
		expect(store.getParentCompletionDecision("root-1").blockingObligations).toHaveLength(2)

		await store.recordParentVerificationEvidence("root-1", [
			{
				toolCallId: "aggregate-verification",
				executionId: "aggregate-execution",
				status: "succeeded",
				command: "pnpm test",
				verificationChangeSetIds: ["applied-1", "applied-2"],
				startedAt: 3_200,
				completedAt: 3_300,
				exitCode: 0,
			},
		])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)
		expect(store.getVerificationObligations({ parentTaskId: "root-1" }).map((item) => item.status)).toEqual([
			"satisfied",
			"satisfied",
			"superseded",
			"not_applicable",
		])
	})

	it("allocates canonical stable paths and never reuses a closed path", async () => {
		const { store } = await setup()
		const first = await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review the API",
		})
		const second = await store.createAgent({
			taskId: "review-2",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review tests",
		})

		expect(first.path).toBe("/root/api-review")
		expect(second.path).toBe("/root/api-review-2")

		await store.updateAgentStatus(first.taskId, "cancelled")
		await store.closeAgent(first.path, "root-1")
		const third = await store.createAgent({
			taskId: "review-3",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review recovery",
		})
		expect(third.path).toBe("/root/api-review-3")
	})

	it("queries the tree and resolves targets by task ID or root-scoped path", async () => {
		const { store } = await setup()
		const review = await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
		})
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
		})

		expect(store.getAgent("review-1")).toEqual(review)
		expect(store.getAgent("/root/review", "root-1")?.taskId).toBe("review-1")
		expect(store.listChildren("root-1").map((agent) => agent.taskId)).toEqual(["review-1", "worker-1"])
		expect(store.listAgents({ rootTaskId: "root-1", includeRoot: false })).toHaveLength(2)

		await store.ensureRoot({ taskId: "root-2", status: "running" })
		await store.createAgent({
			taskId: "review-other-root",
			parentTaskId: "root-2",
			nickname: "Review",
			role: "review",
			objective: "Review another tree",
		})
		expect(() => store.resolveTarget("/root/review")).toThrow(/ambiguous/)
		expect(store.resolveTarget("/root/review", { rootTaskId: "root-2" })).toMatchObject({
			closed: false,
			record: { taskId: "review-other-root" },
		})
	})

	it("appends events idempotently and assigns monotonic sequences", async () => {
		const { store } = await setup()
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
		})
		const observed: string[] = []
		store.subscribe((entry) => observed.push(entry.eventId))

		const first = await store.appendEvent({
			eventId: "message-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "message",
			name: "user_message",
			payload: { text: "Inspect the tests" },
		})
		const retry = await store.appendEvent({
			eventId: "message-1",
			sender: "/root",
			recipient: "/root/review",
			rootTaskId: "root-1",
			kind: "message",
			name: "user_message",
			payload: { text: "Inspect the tests" },
		})
		const second = await store.appendEvent({
			eventId: "control-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "control",
			name: "interrupt",
		})

		expect(first.appended).toBe(true)
		expect(retry).toEqual({ entry: first.entry, appended: false })
		expect(second.entry.sequence).toBe(first.entry.sequence + 1)
		expect(observed).toEqual(["message-1", "control-1"])
		await expect(
			store.appendEvent({
				eventId: "message-1",
				recipient: "review-1",
				kind: "message",
				name: "different_message",
			}),
		).rejects.toThrow(/different content/)
	})

	it("commits a terminal status and parent result mailbox event atomically", async () => {
		let persisted: Awaited<ReturnType<AgentControlStore["getSnapshot"]>> | undefined
		let failNextWrite = false
		const persistence: AgentControlPersistence = {
			read: async () => (persisted ? structuredClone(persisted) : undefined),
			write: async (state) => {
				if (failNextWrite) {
					failNextWrite = false
					throw new Error("simulated durable write failure")
				}
				persisted = structuredClone(state)
			},
		}
		const { store } = await setup(persistence)
		await store.createAgent({
			taskId: "review-atomic",
			parentTaskId: "root-1",
			nickname: "Atomic Review",
			role: "review",
			objective: "Review atomically",
			status: "running",
		})
		const event = {
			eventId: "atomic-result",
			rootTaskId: "root-1",
			sender: "review-atomic",
			recipient: "root-1",
			kind: "result" as const,
			name: "agent_completed",
			payload: { summary: "Done" },
			createdAt: 2_000,
		}

		failNextWrite = true
		await expect(
			store.updateAgentStatusAndAppendEvent(
				"review-atomic",
				"completed",
				{ at: 2_000, terminalResult: { status: "completed", summary: "Done", completedAt: 2_000 } },
				event,
				"root-1",
			),
		).rejects.toThrow("simulated durable write failure")
		expect(store.getAgent("review-atomic", "root-1")?.status).toBe("running")
		expect(store.readMailbox("root-1", { rootTaskId: "root-1" }).entries).toEqual([])

		const committed = await store.updateAgentStatusAndAppendEvent(
			"review-atomic",
			"completed",
			{ at: 2_000, terminalResult: { status: "completed", summary: "Done", completedAt: 2_000 } },
			event,
			"root-1",
		)
		expect(committed).toMatchObject({ record: { status: "completed" }, appended: true })
		expect(store.readMailbox("root-1", { rootTaskId: "root-1" }).entries).toMatchObject([
			{ eventId: "atomic-result", kind: "result" },
		])

		const replay = await store.updateAgentStatusAndAppendEvent(
			"review-atomic",
			"completed",
			{ at: 2_000, terminalResult: { status: "completed", summary: "Done", completedAt: 2_000 } },
			event,
			"root-1",
		)
		expect(replay.appended).toBe(false)
		expect(store.readMailbox("root-1", { rootTaskId: "root-1" }).entries).toHaveLength(1)
	})

	it("retains terminal results until explicit close", async () => {
		const { store } = await setup()
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
			status: "running",
		})
		await expect(store.closeAgent("worker-1")).rejects.toThrow(/cannot be closed/)

		const completed = await store.updateAgentStatus("worker-1", "completed", {
			terminalResult: {
				status: "completed",
				summary: "Implemented",
				changedFiles: ["src/example.ts"],
				requiresParentVerification: true,
				completedAt: 2_000,
			},
		})
		expect(store.getAgent("worker-1")).toEqual(completed)
		expect(store.listAgents({ statuses: ["completed"] })).toHaveLength(1)

		const tombstone = await store.closeAgent("worker-1")
		expect(store.getAgent("worker-1")).toBeUndefined()
		expect(store.resolveTarget("worker-1", { includeClosed: true })).toEqual({ closed: true, tombstone })
		await expect(
			store.appendEvent({
				recipient: "worker-1",
				kind: "followup",
				name: "followup",
			}),
		).rejects.toThrow(/closed agent target/)
	})

	it("clears a stale terminal stop reason when an interrupted agent resumes", async () => {
		const { store } = await setup()
		await store.updateAgentStatus("root-1", "interrupted", {
			snapshot: { summary: "Interrupted root", stopReason: "interrupted" },
		})

		const pending = await store.updateAgentStatus("root-1", "pending")
		expect(pending.snapshot).toEqual({ summary: "Interrupted root" })
		expect(pending.interruptedAt).toBeUndefined()

		const running = await store.updateAgentStatus("root-1", "running")
		expect(running.snapshot).toEqual({ summary: "Interrupted root" })
		expect(running.snapshot?.stopReason).toBeUndefined()
	})

	it("recovers active records once while preserving completed records", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const first = new AgentControlStore(persistence, clock(10_000))
		await first.initialize()
		await first.ensureRoot({ taskId: "root-1", status: "running" })
		await first.createAgent({
			taskId: "running-child",
			parentTaskId: "root-1",
			groupId: "running-group",
			nickname: "Running",
			role: "explore",
			objective: "Run",
			status: "running",
		})
		await first.createAgent({
			taskId: "completed-child",
			parentTaskId: "root-1",
			nickname: "Completed",
			role: "review",
			objective: "Complete",
			status: "completed",
		})

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		expect(reloaded.getAgent("root-1")?.status).toBe("interrupted")
		expect(reloaded.getAgent("running-child")?.status).toBe("interrupted")
		expect(reloaded.getAgent("completed-child")?.status).toBe("completed")
		const recoveryEvents = reloaded.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted")
		expect(recoveryEvents).toHaveLength(1)
		expect(recoveryEvents[0]).toMatchObject({
			senderTaskId: "running-child",
			recipientTaskId: "root-1",
			payload: { previousStatus: "running" },
		})
		const recoveredResults = reloaded.getSnapshot().mailbox.filter((entry) => entry.name === "agent_interrupted")
		expect(recoveredResults).toHaveLength(1)
		expect(recoveredResults[0]).toMatchObject({
			senderTaskId: "running-child",
			recipientTaskId: "root-1",
			kind: "result",
			payload: {
				taskId: "running-child",
				groupId: "running-group",
				status: "interrupted",
				stopReason: "interrupted",
			},
		})

		const reloadedAgain = new AgentControlStore(persistence, clock(30_000))
		await reloadedAgain.initialize()
		expect(
			reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted"),
		).toHaveLength(1)
		expect(reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "agent_interrupted")).toHaveLength(
			1,
		)
	})

	it("tracks per-recipient delivery and acknowledgement cursors durably", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
			status: "interrupted",
		})
		const first = await store.appendEvent({
			eventId: "mail-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "message",
			name: "message",
		})
		const second = await store.appendEvent({
			eventId: "mail-2",
			sender: "root-1",
			recipient: "review-1",
			kind: "followup",
			name: "followup",
		})

		expect(store.readMailbox("review-1").entries.map((entry) => entry.eventId)).toEqual(["mail-1", "mail-2"])
		await store.markDelivered("review-1", first.entry.sequence, undefined, 5_000)
		expect(store.readMailbox("review-1").entries.map((entry) => entry.eventId)).toEqual(["mail-2"])
		await store.acknowledge("review-1", second.entry.sequence, undefined, 6_000)

		const reloaded = new AgentControlStore(persistence, clock(40_000))
		await reloaded.initialize()
		expect(reloaded.getMailboxCursor("review-1")).toMatchObject({
			lastDeliveredSequence: second.entry.sequence,
			lastAcknowledgedSequence: second.entry.sequence,
		})
		expect(reloaded.readMailbox("review-1").entries).toEqual([])
		const all = reloaded.readMailbox("review-1", { afterSequence: 0 }).entries
		expect(all[0]).toMatchObject({ eventId: "mail-1", deliveredAt: 5_000 })
		expect(all[1]).toMatchObject({ eventId: "mail-2", deliveredAt: 6_000, acknowledgedAt: 6_000 })
	})

	it("grants exactly one durable owner to concurrent native wait consumers", async () => {
		const { store } = await setup()
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
			status: "completed",
		})
		await store.appendEvent({
			eventId: "result-1",
			sender: "review-1",
			recipient: "root-1",
			kind: "result",
			name: "agent_completed",
			payload: { taskId: "review-1" },
		})

		const [firstClaim, secondClaim] = await Promise.all([
			store.claimMailbox("root-1", { channel: "wait", kinds: ["result"] }),
			store.claimMailbox("root-1", { channel: "wait", kinds: ["result"] }),
		])

		expect(firstClaim.entries.map(({ eventId }) => eventId)).toEqual(["result-1"])
		expect(secondClaim.entries).toEqual([])
		expect(store.readMailbox("root-1", { includeDelivered: false }).entries).toEqual([])
		expect(store.getUnacknowledgedMailboxEntries("root-1", { kinds: ["result"] })).toEqual([
			expect.objectContaining({
				eventId: "result-1",
				claimId: firstClaim.claimId,
				claimChannel: "wait",
			}),
		])
		expect(store.getMailboxCursor("root-1")).toMatchObject({
			lastDeliveredSequence: 0,
			lastAcknowledgedSequence: 0,
		})

		await store.acknowledgeMailboxClaim("root-1", firstClaim.claimId)
		await store.acknowledgeMailboxClaim("root-1", firstClaim.claimId)
		expect(store.getUnacknowledgedMailboxEntries("root-1", { kinds: ["result"] })).toEqual([])
		expect(store.getMailboxCursor("root-1")).toMatchObject({
			lastDeliveredSequence: firstClaim.entries[0].sequence,
			lastAcknowledgedSequence: firstClaim.entries[0].sequence,
		})
	})

	it("releases unfinished legacy automatic mailbox claims during recovery", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
			status: "completed",
		})
		await store.appendEvent({
			eventId: "result-retry",
			sender: "review-1",
			recipient: "root-1",
			kind: "result",
			name: "agent_completed",
			payload: { taskId: "review-1" },
		})
		const abandoned = await store.claimMailbox("root-1", { channel: "automatic", kinds: ["result"] })
		expect(abandoned.entries).toHaveLength(1)

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		const retried = await reloaded.claimMailbox("root-1", { channel: "wait", kinds: ["result"] })
		expect(retried.entries.map(({ eventId }) => eventId)).toEqual(["result-retry"])
	})

	it("preserves a native wait claim across reload until history reconciliation chooses ACK or release", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.appendEvent({
			eventId: "wait-reload-result",
			recipient: "root-1",
			kind: "result",
			name: "agent_completed",
		})
		const claimed = await store.claimMailbox("root-1", { channel: "wait", kinds: ["result"] })

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		expect(reloaded.getUnacknowledgedMailboxEntries("root-1", { kinds: ["result"] })).toEqual([
			expect.objectContaining({
				eventId: "wait-reload-result",
				claimId: claimed.claimId,
				claimChannel: "wait",
			}),
		])
		await expect(reloaded.claimMailbox("root-1", { channel: "wait", kinds: ["result"] })).resolves.toMatchObject({
			entries: [],
		})

		await reloaded.releaseMailboxClaim("root-1", claimed.claimId)
		const retried = await reloaded.claimMailbox("root-1", { channel: "wait", kinds: ["result"] })
		expect(retried.entries.map(({ eventId }) => eventId)).toEqual(["wait-reload-result"])
		expect(retried.claimId).not.toBe(claimed.claimId)
	})

	it("retains a failed claim settlement across same-host consumer replacement", async () => {
		const { store } = await setup()
		await store.appendEvent({
			eventId: "same-host-result",
			recipient: "root-1",
			kind: "result",
			name: "agent_completed",
		})
		const claim = await store.claimMailbox("root-1", { channel: "wait", kinds: ["result"] })
		const acknowledge = vi
			.spyOn(store, "acknowledgeMailboxClaim")
			.mockRejectedValueOnce(new Error("temporary persistence failure"))

		await expect(store.settleMailboxClaim("root-1", claim.claimId, "acknowledge")).rejects.toThrow(
			"temporary persistence failure",
		)
		await expect(store.settleMailboxClaim("root-1", claim.claimId, "release")).rejects.toThrow(
			"different pending settlement",
		)

		await expect(store.retryPendingMailboxClaimSettlements("root-1")).resolves.toBe(1)
		expect(acknowledge).toHaveBeenCalledTimes(2)
		expect(store.getUnacknowledgedMailboxEntries("root-1", { kinds: ["result"] })).toEqual([])
	})

	it("reads a bounded recent activity window without cloning the full mailbox", async () => {
		const { store } = await setup()
		await store.ensureRoot({ taskId: "root-2", status: "running" })
		for (const eventId of ["activity-1", "activity-2", "activity-3"]) {
			await store.appendEvent({
				eventId,
				recipient: "root-1",
				kind: "lifecycle",
				name: eventId,
				payload: { report: "private payload" },
			})
		}
		await store.appendEvent({
			eventId: "other-root",
			recipient: "root-2",
			kind: "lifecycle",
			name: "other_root",
		})

		const recent = store.getRecentRootMailboxEntries("root-1", 2)
		expect(recent.totalCount).toBe(3)
		expect(recent.entries.map(({ eventId }) => eventId)).toEqual(["activity-3", "activity-2"])
		recent.entries[0].name = "mutated clone"
		expect(store.getRecentRootMailboxEntries("root-1", 1).entries[0].name).toBe("activity-3")
	})

	it("purges a deleted root tree while preserving unrelated durable evidence", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.ensureRoot({ taskId: "root-10", status: "running" })
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
			status: "completed",
		})
		await recordWorker(store, workerChangeSet("retained-change", "pending_review"))
		const event = await store.appendEvent({
			eventId: "retained-result",
			sender: "worker-1",
			recipient: "root-1",
			kind: "result",
			name: "agent_completed",
		})
		await store.acknowledge("root-1", event.entry.sequence)
		await store.closeAgent("worker-1")
		await store.appendEvent({
			eventId: "other-root-event",
			recipient: "root-10",
			kind: "lifecycle",
			name: "still_retained",
		})
		await store.acknowledge("root-10", store.getSnapshot().nextSequence - 1)

		await expect(store.purgeRoot("root-1")).resolves.toBe(true)
		await expect(store.purgeRoot("root-1")).resolves.toBe(false)
		const snapshot = store.getSnapshot()
		expect(snapshot.agents.filter(({ rootTaskId }) => rootTaskId === "root-1")).toEqual([])
		expect(snapshot.tombstones.filter(({ rootTaskId }) => rootTaskId === "root-1")).toEqual([])
		expect(snapshot.mailbox.filter(({ rootTaskId }) => rootTaskId === "root-1")).toEqual([])
		expect(Object.keys(snapshot.mailboxCursors).filter((key) => key.startsWith("root-1:"))).toEqual([])
		expect(snapshot.verificationObligations.filter(({ rootTaskId }) => rootTaskId === "root-1")).toEqual([])
		expect(snapshot.agents).toEqual([expect.objectContaining({ taskId: "root-10" })])
		expect(snapshot.mailbox).toEqual([expect.objectContaining({ eventId: "other-root-event" })])
		expect(Object.keys(snapshot.mailboxCursors)).toContain("root-10:root-10")

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		expect(reloaded.getAgent("root-1")).toBeUndefined()
		expect(reloaded.getAgent("root-10")).toEqual(expect.objectContaining({ taskId: "root-10" }))
	})

	it("persists one atomic versioned snapshot under global storage", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-"))
		const stores: AgentControlStore[] = []
		try {
			const persistence = new FileAgentControlPersistence(directory)
			const first = new AgentControlStore(persistence, clock(50_000))
			stores.push(first)
			await first.initialize()
			await first.ensureRoot({ taskId: "root-file", status: "interrupted" })

			const raw = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(raw).toMatchObject({ version: 2, agents: [{ taskId: "root-file", path: "/root" }] })

			const reloaded = new AgentControlStore(new FileAgentControlPersistence(directory), clock(60_000))
			stores.push(reloaded)
			await reloaded.initialize()
			expect(reloaded.getAgent("root-file")?.path).toBe("/root")
		} finally {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("coalesces concurrent initialization and permits a retry after failure", async () => {
		let releaseFirstAttempt!: () => void
		const firstAttemptBlocked = new Promise<void>((resolve) => {
			releaseFirstAttempt = resolve
		})
		let attempts = 0
		const transactionStarted = vi.fn()
		const persistence: AgentControlPersistence = {
			read: vi.fn().mockResolvedValue(undefined),
			write: vi.fn().mockResolvedValue(undefined),
			async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
				transactionStarted()
				attempts++
				if (attempts === 1) {
					await firstAttemptBlocked
					throw new Error("transaction unavailable")
				}
				return operation()
			},
		}
		const store = new AgentControlStore(persistence, clock(65_000))

		const first = store.initialize()
		const second = store.initialize()
		const failedInitializations = Promise.allSettled([first, second])
		await vi.waitFor(() => expect(transactionStarted).toHaveBeenCalledTimes(1))
		releaseFirstAttempt()
		expect(await failedInitializations).toEqual([
			expect.objectContaining({ status: "rejected", reason: new Error("transaction unavailable") }),
			expect.objectContaining({ status: "rejected", reason: new Error("transaction unavailable") }),
		])

		await expect(store.initialize()).resolves.toBeUndefined()
		expect(transactionStarted).toHaveBeenCalledTimes(2)
		expect(store.getSnapshot()).toMatchObject({ version: 2, agents: [] })
	})

	it("commits initialized state only after the persistence transaction releases", async () => {
		let failRelease = true
		const persistence: AgentControlPersistence = {
			read: vi.fn().mockResolvedValue(undefined),
			write: vi.fn().mockResolvedValue(undefined),
			async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
				const result = await operation()
				if (failRelease) {
					failRelease = false
					throw new Error("transaction release failed")
				}
				return result
			},
		}
		const store = new AgentControlStore(persistence, clock(66_000))

		await expect(store.initialize()).rejects.toThrow("transaction release failed")
		expect(() => store.getSnapshot()).toThrow("initialize() must complete")
		await expect(store.initialize()).resolves.toBeUndefined()
		expect(store.getSnapshot()).toMatchObject({ version: 2, agents: [] })
	})

	it("treats shutdown as terminal for an activation-scoped owner", async () => {
		const store = new AgentControlStore(new InMemoryAgentControlPersistence(), clock(67_000))
		await store.initialize()
		await store.shutdown()

		await expect(store.initialize()).rejects.toThrow("cannot be reinitialized after shutdown")
	})

	it("rejects a file transaction after its process lock is removed", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-fence-"))
		try {
			const persistence = new FileAgentControlPersistence(directory)
			await expect(
				persistence.withTransaction(async () => {
					await fs.rename(
						`${persistence.filePath}.transaction.lock`,
						`${persistence.filePath}.transaction.lock.removed`,
					)
					return "must-not-commit"
				}),
			).rejects.toThrow("transaction ownership was lost")
			await expect(persistence.withTransaction(async () => "next-transaction")).resolves.toBe("next-transaction")
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rejects ownership loss at the synchronous commit fence without replacing the snapshot", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-commit-fence-"))
		const persistence = new FileAgentControlPersistence(directory)
		const store = new AgentControlStore(persistence, clock(68_000), { ownerId: "commit-fence-host" })
		const internals = persistence as unknown as { assertTransactionOwnerSync(): void }
		const originalAssertTransactionOwner = internals.assertTransactionOwnerSync.bind(persistence)
		let transactionFence: ReturnType<typeof vi.spyOn> | undefined
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			await store.initialize()
			await store.ensureRoot({ taskId: "commit-fence-root", status: "running" })
			transactionFence = vi.spyOn(internals, "assertTransactionOwnerSync").mockImplementation(() => {
				fsSync.renameSync(
					`${persistence.filePath}.transaction.lock`,
					`${persistence.filePath}.transaction.lock.removed`,
				)
				originalAssertTransactionOwner()
			})

			await expect(store.updateAgentSnapshot("commit-fence-root", { stopReason: "failed" })).rejects.toThrow(
				"transaction ownership was lost",
			)
			const persisted = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(persisted.agents[0].snapshot).toBeUndefined()
		} finally {
			transactionFence?.mockRestore()
			errorLog.mockRestore()
			await store.shutdown()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("does not report a committed write as failed when post-commit lock cleanup fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-post-commit-fence-"))
		const persistence = new FileAgentControlPersistence(directory)
		const store = new AgentControlStore(persistence, clock(69_000), { ownerId: "post-commit-fence-host" })
		const internals = persistence as unknown as { releaseTransactionLock(token: string): Promise<void> }
		let releaseFailure: { mockRestore(): void } | undefined
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			await store.initialize()
			await store.ensureRoot({ taskId: "post-commit-fence-root", status: "running" })
			releaseFailure = vi
				.spyOn(internals, "releaseTransactionLock")
				.mockRejectedValueOnce(new Error("post-commit cleanup unavailable"))

			await expect(
				store.updateAgentSnapshot("post-commit-fence-root", { stopReason: "failed" }),
			).resolves.toMatchObject({ snapshot: { stopReason: "failed" } })
			const persisted = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(persisted.agents[0].snapshot).toEqual({ stopReason: "failed" })
		} finally {
			releaseFailure?.mockRestore()
			errorLog.mockRestore()
			await store.shutdown()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("retries a transient Windows transaction-lock rename without losing ownership", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-release-retry-"))
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const originalRename = internals.renameTransactionLock.bind(persistence)
		const transientError = Object.assign(new Error("temporarily locked by another Windows process"), {
			code: "EPERM",
		})
		let releaseFailures = 1
		const rename = vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			if (source === lockPath && releaseFailures-- > 0) throw transientError
			await originalRename(source, destination)
		})

		try {
			await expect(persistence.withTransaction(async () => undefined)).resolves.toBeUndefined()
			expect(rename.mock.calls.filter(([source]) => source === lockPath)).toHaveLength(2)
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			rename.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("retries a transient Windows failure while promoting a transaction-lock candidate", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-acquire-retry-"))
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const originalRename = internals.renameTransactionLock.bind(persistence)
		const transientError = Object.assign(new Error("competing Windows lock disappeared during promotion"), {
			code: "EPERM",
		})
		let promotionFailures = 1
		const rename = vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			if (source.startsWith(`${lockPath}.candidate.`) && promotionFailures-- > 0) throw transientError
			await originalRename(source, destination)
		})

		try {
			await expect(persistence.withTransaction(async () => "acquired")).resolves.toBe("acquired")
			expect(rename.mock.calls.filter(([source]) => source.startsWith(`${lockPath}.candidate.`))).toHaveLength(2)
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			rename.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("recovers the next transaction after every immediate Windows release retry is exhausted", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-release-recovery-"))
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
		}
		const originalRename = internals.renameTransactionLock.bind(persistence)
		const transientError = Object.assign(new Error("transaction directory is still held by Windows"), {
			code: "EPERM",
		})
		let releaseFailures = 6
		const rename = vi.spyOn(internals, "renameTransactionLock").mockImplementation(async (source, destination) => {
			if (source === lockPath && releaseFailures-- > 0) throw transientError
			await originalRename(source, destination)
		})
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

		try {
			await expect(
				persistence.withTransaction(async () => {
					await persistence.write({
						version: 2,
						updatedAt: 1,
						nextSequence: 1,
						agents: [],
						tombstones: [],
						mailbox: [],
						mailboxCursors: {},
						verificationObligations: [],
					})
					return "committed"
				}),
			).resolves.toBe("committed")
			await expect(persistence.withTransaction(async () => "next transaction")).resolves.toBe("next transaction")
			expect(rename.mock.calls.filter(([source]) => source === lockPath)).toHaveLength(8)
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
			const entries = await fs.readdir(directory)
			expect(entries.some((entry) => entry.includes(".transaction.lock.released."))).toBe(true)
		} finally {
			rename.mockRestore()
			errorLog.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("prevents a delayed released-lock reaper from moving a successor", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-released-reaper-"))
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			tryReapReleasedTransactionLock(owner: { token: string; pid: number }): Promise<boolean>
		}
		const releasedOwner = { token: "released-owner", pid: process.pid }
		const lockPath = `${persistence.filePath}.transaction.lock`

		try {
			await fs.mkdir(lockPath, { recursive: true })
			await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(releasedOwner), "utf8")
			await fs.writeFile(path.join(lockPath, "released"), releasedOwner.token, "utf8")
			await expect(internals.tryReapReleasedTransactionLock(releasedOwner)).resolves.toBe(true)

			await persistence.withTransaction(async () => {
				await expect(internals.tryReapReleasedTransactionLock(releasedOwner)).resolves.toBe(false)
				await expect(persistence.assertTransactionOwner()).resolves.toBeUndefined()
			})
			await expect(fs.stat(`${lockPath}.released.${releasedOwner.token}`)).resolves.toMatchObject({})
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("serializes concurrent reclaimers without allowing a stale reaper to remove the new owner", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-reapers-"))
		const persistenceA = new FileAgentControlPersistence(directory)
		const persistenceB = new FileAgentControlPersistence(directory)
		const deadPid = 2_147_483_647

		try {
			const lockPath = `${persistenceA.filePath}.transaction.lock`
			await fs.mkdir(lockPath, { recursive: true })
			await fs.writeFile(
				path.join(lockPath, "owner.json"),
				JSON.stringify({ token: "abandoned-owner", pid: deadPid }),
				"utf8",
			)
			let activeTransactions = 0
			let maximumActiveTransactions = 0
			const run = (persistence: FileAgentControlPersistence) =>
				persistence.withTransaction(async () => {
					activeTransactions++
					maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions)
					await new Promise<void>((resolve) => setTimeout(resolve, 25))
					activeTransactions--
				})

			await Promise.all([run(persistenceA), run(persistenceB)])
			expect(maximumActiveTransactions).toBe(1)
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("continues after a reaper crashes with a permanent dead-owner tombstone", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-reaper-crash-"))
		const persistence = new FileAgentControlPersistence(directory)
		const tombstonePath = `${persistence.filePath}.transaction.lock.reap.abandoned-owner`

		try {
			await fs.mkdir(tombstonePath, { recursive: true })
			await fs.writeFile(
				path.join(tombstonePath, "owner.json"),
				JSON.stringify({ token: "abandoned-owner", pid: 2_147_483_647 }),
				"utf8",
			)

			await expect(persistence.withTransaction(async () => "recovered")).resolves.toBe("recovered")
			await expect(fs.stat(tombstonePath)).resolves.toMatchObject({})
			await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("fails closed without replacing an ownerless legacy transaction directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-legacy-lock-"))
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			observeTransactionLockForAcquisition(): Promise<"legacy" | undefined>
			tryCreateTransactionLock(owner: { token: string; pid: number }): Promise<boolean>
		}
		const lockPath = `${persistence.filePath}.transaction.lock`

		try {
			await fs.mkdir(lockPath, { recursive: true })
			await expect(internals.observeTransactionLockForAcquisition()).resolves.toBe("legacy")
			await expect(
				internals.tryCreateTransactionLock({ token: "must-not-replace-legacy", pid: process.pid }),
			).resolves.toBe(false)
			expect((await fs.readdir(lockPath)).length).toBe(0)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("prevents a delayed stale reaper from moving the succeeding live lock", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-stale-reaper-"))
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			tryReapTransactionLock(owner: { token: string; pid: number }): Promise<boolean>
		}
		const staleOwner = { token: "stale-reaper-owner", pid: 2_147_483_647 }
		const lockPath = `${persistence.filePath}.transaction.lock`

		try {
			await fs.mkdir(lockPath, { recursive: true })
			await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(staleOwner), "utf8")
			await expect(internals.tryReapTransactionLock(staleOwner)).resolves.toBe(true)

			await persistence.withTransaction(async () => {
				await expect(internals.tryReapTransactionLock(staleOwner)).resolves.toBe(false)
				await expect(persistence.assertTransactionOwner()).resolves.toBeUndefined()
			})
			await expect(fs.stat(`${lockPath}.reap.${staleOwner.token}`)).resolves.toMatchObject({})
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("preserves interleaved mutations from independent file-backed stores", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-writers-"))
		const stores: AgentControlStore[] = []
		try {
			const first = new AgentControlStore(new FileAgentControlPersistence(directory), clock(70_000), {
				ownerId: "writer-a-host",
			})
			const second = new AgentControlStore(new FileAgentControlPersistence(directory), clock(80_000), {
				ownerId: "writer-b-host",
			})
			stores.push(first, second)
			await Promise.all([first.initialize(), second.initialize()])

			await Promise.all([
				first.ensureRoot({ taskId: "root-a", status: "running" }),
				second.ensureRoot({ taskId: "root-b", status: "running" }),
			])

			const [firstWorker, secondWorker] = await Promise.all([
				first.createAgent({
					taskId: "worker-a",
					parentTaskId: "root-a",
					nickname: "Worker",
					role: "explore",
					objective: "Inspect A",
					status: "completed",
				}),
				second.createAgent({
					taskId: "worker-b",
					parentTaskId: "root-b",
					nickname: "Worker",
					role: "review",
					objective: "Inspect B",
					status: "completed",
				}),
			])
			expect([firstWorker.path, secondWorker.path]).toEqual(["/root/worker", "/root/worker"])

			await Promise.all([
				first.appendEvent({
					eventId: "writer-a-event",
					sender: "worker-a",
					recipient: "root-a",
					kind: "result",
					name: "writer_a_completed",
				}),
				second.appendEvent({
					eventId: "writer-b-event",
					sender: "worker-b",
					recipient: "root-b",
					kind: "result",
					name: "writer_b_completed",
				}),
			])
			const [claimedByFirst, claimedBySecond] = await Promise.all([
				first.claimMailbox("root-a", {
					channel: "wait",
					claimId: "writer-a-claim",
					kinds: ["result"],
					limit: 1,
				}),
				second.claimMailbox("root-b", {
					channel: "wait",
					claimId: "writer-b-claim",
					kinds: ["result"],
					limit: 1,
				}),
			])
			expect(claimedByFirst.entries).toHaveLength(1)
			expect(claimedBySecond.entries).toHaveLength(1)
			await Promise.all([
				first.settleMailboxClaim("root-a", claimedByFirst.claimId, "acknowledge"),
				second.settleMailboxClaim("root-b", claimedBySecond.claimId, "acknowledge"),
			])

			const reloaded = new AgentControlStore(new FileAgentControlPersistence(directory), clock(90_000), {
				ownerId: "observer-host",
			})
			stores.push(reloaded)
			await reloaded.initialize()
			expect(reloaded.listChildren("root-a").map(({ taskId }) => taskId)).toEqual(["worker-a"])
			expect(reloaded.listChildren("root-b").map(({ taskId }) => taskId)).toEqual(["worker-b"])
			const writerEvents = reloaded
				.getSnapshot()
				.mailbox.filter(({ eventId }) => eventId === "writer-a-event" || eventId === "writer-b-event")
			expect(writerEvents.map(({ eventId }) => eventId).sort()).toEqual(["writer-a-event", "writer-b-event"])
			expect(new Set(writerEvents.map(({ sequence }) => sequence))).toHaveProperty("size", 2)
			expect(writerEvents.filter(({ acknowledgedAt }) => acknowledgedAt !== undefined)).toHaveLength(2)
		} finally {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rotates a compromised owner lease without abandoning still-owned durable state", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-owner-rotation-"))
		const persistence = new FileAgentControlPersistence(directory)
		const originalAcquireOwnerLease = persistence.acquireOwnerLease.bind(persistence)
		const acquiredOwnerIds: string[] = []
		const compromiseCallbacks = new Map<string, (error: Error) => void>()
		const acquireOwnerLease = vi
			.spyOn(persistence, "acquireOwnerLease")
			.mockImplementation(async (ownerId, options) => {
				acquiredOwnerIds.push(ownerId)
				compromiseCallbacks.set(ownerId, options.onCompromised)
				await originalAcquireOwnerLease(ownerId, options)
			})
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const store = new AgentControlStore(persistence, clock(95_000), { ownerId: "recovering-host" })

		try {
			await store.initialize()
			await store.ensureRoot({ taskId: "recovering-root", status: "running" })
			await store.createAgent({
				taskId: "recovering-child",
				parentTaskId: "recovering-root",
				nickname: "Worker",
				role: "worker",
				objective: "Keep running after a transient lease failure",
				status: "running",
			})
			await store.appendEvent({
				eventId: "recovering-result",
				sender: "recovering-child",
				recipient: "recovering-root",
				kind: "result",
				name: "recovering_result",
			})
			await store.claimMailbox("recovering-root", {
				channel: "wait",
				claimId: "recovering-claim",
				kinds: ["result"],
			})

			compromiseCallbacks.get("recovering-host")?.(
				Object.assign(new Error("Unable to update lock within the stale threshold"), {
					code: "ECOMPROMISED",
				}),
			)

			await expect(
				store.updateAgentSnapshot("recovering-root", { phase: "completion-verification" }),
			).resolves.toMatchObject({ snapshot: { phase: "completion-verification" } })

			expect(acquiredOwnerIds).toHaveLength(2)
			const rotatedOwnerId = acquiredOwnerIds[1]
			expect(rotatedOwnerId).not.toBe("recovering-host")
			const persisted = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(
				persisted.agents
					.filter(({ status }: { status: string }) => ["pending", "running", "cancelling"].includes(status))
					.map(({ runtimeOwnerId }: { runtimeOwnerId?: string }) => runtimeOwnerId),
			).toEqual([rotatedOwnerId, rotatedOwnerId])
			expect(
				persisted.mailbox.find(({ eventId }: { eventId: string }) => eventId === "recovering-result")
					?.claimOwnerId,
			).toBe(rotatedOwnerId)

			// A delayed callback from the superseded handle cannot poison the new lease.
			compromiseCallbacks.get("recovering-host")?.(new Error("late callback from the old lease"))
			await expect(
				store.updateAgentSnapshot("recovering-child", { phase: "still-running" }),
			).resolves.toMatchObject({ snapshot: { phase: "still-running" } })
			expect(acquiredOwnerIds).toHaveLength(2)
		} finally {
			await store.shutdown()
			await Promise.all(acquiredOwnerIds.map((ownerId) => persistence.releaseOwnerLease(ownerId)))
			acquireOwnerLease.mockRestore()
			errorLog.mockRestore()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("does not revoke a stale-looking lease before a live owner can refresh after system resume", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-owner-resume-"))
		const firstPersistence = new FileAgentControlPersistence(directory)
		const secondPersistence = new FileAgentControlPersistence(directory)
		const first = new AgentControlStore(firstPersistence, clock(96_000), { ownerId: "resuming-host" })
		const second = new AgentControlStore(secondPersistence, clock(97_000), { ownerId: "observing-host" })
		const stores = [first, second]

		try {
			await first.initialize()
			await expect(firstPersistence.isOwnerProcessLive("resuming-host")).resolves.toBe(true)
			await first.ensureRoot({ taskId: "resuming-root", status: "running" })
			await second.initialize()

			const originalLeaseCheck = secondPersistence.isOwnerLeaseLive.bind(secondPersistence)
			const leaseCheck = vi
				.spyOn(secondPersistence, "isOwnerLeaseLive")
				.mockImplementation((ownerId, staleMs) =>
					ownerId === "resuming-host" ? Promise.resolve(false) : originalLeaseCheck(ownerId, staleMs),
				)
			const originalProcessCheck = secondPersistence.isOwnerProcessLive.bind(secondPersistence)
			const processCheck = vi
				.spyOn(secondPersistence, "isOwnerProcessLive")
				.mockImplementation((ownerId) =>
					ownerId === "resuming-host" ? Promise.resolve(true) : originalProcessCheck(ownerId),
				)
			const revoke = vi.spyOn(secondPersistence, "tryRevokeOwnerLease")

			try {
				await expect(second.recoverAbandonedOwners()).resolves.toBe(0)
				expect(revoke).not.toHaveBeenCalledWith("resuming-host", expect.any(Number))
				expect(second.getAgent("resuming-root")).toMatchObject({
					status: "running",
					runtimeOwnerId: "resuming-host",
				})

				leaseCheck.mockImplementation((ownerId, staleMs) => originalLeaseCheck(ownerId, staleMs))
				await expect(second.recoverAbandonedOwners()).resolves.toBe(0)
				await expect(
					first.updateAgentSnapshot("resuming-root", { phase: "completion-verification" }),
				).resolves.toMatchObject({ snapshot: { phase: "completion-verification" } })
			} finally {
				leaseCheck.mockRestore()
				processCheck.mockRestore()
				revoke.mockRestore()
			}
		} finally {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	// This integration path intentionally performs many separately fenced real-filesystem
	// transactions. Keep unit tests on the default timeout, but allow Windows CI scheduling
	// headroom when this spec runs beside the rest of the disk-heavy extension suite.
	it("preserves live foreign runs, recovers abandoned ownership, and fences the stale writer", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-owners-"))
		const stores: AgentControlStore[] = []
		try {
			const firstPersistence = new FileAgentControlPersistence(directory)
			const first = new AgentControlStore(firstPersistence, clock(100_000), { ownerId: "host-a" })
			const second = new AgentControlStore(new FileAgentControlPersistence(directory), clock(110_000), {
				ownerId: "host-b",
			})
			stores.push(first, second)
			await first.initialize()
			await first.ensureRoot({ taskId: "owned-root", status: "running" })
			await first.createAgent({
				taskId: "owned-child",
				parentTaskId: "owned-root",
				nickname: "Worker",
				role: "worker",
				objective: "Keep working",
				status: "running",
			})
			await first.createAgent({
				taskId: "owned-completed-child",
				parentTaskId: "owned-root",
				nickname: "Completed Worker",
				role: "review",
				objective: "Retain completed history",
				status: "completed",
			})
			await first.appendEvent({
				eventId: "owned-result",
				sender: "owned-child",
				recipient: "owned-root",
				kind: "result",
				name: "still_owned",
			})
			await first.appendEvent({
				eventId: "owned-automatic-result",
				sender: "owned-child",
				recipient: "owned-root",
				kind: "result",
				name: "retry_after_recovery",
			})

			await second.initialize()
			expect(second.getAgent("owned-root")).toMatchObject({ status: "running", runtimeOwnerId: "host-a" })
			expect(second.getAgent("owned-child")).toMatchObject({ status: "running", runtimeOwnerId: "host-a" })

			await first.ensureRoot({ taskId: "claim-owned-root", status: "running" })
			await first.appendEvent({
				eventId: "claim-owned-event",
				recipient: "claim-owned-root",
				kind: "result",
				name: "claim_owned",
			})
			const liveForeignClaim = await first.claimMailbox("claim-owned-root", {
				channel: "wait",
				claimId: "live-foreign-claim",
				kinds: ["result"],
			})
			await first.updateAgentStatus("claim-owned-root", "interrupted")
			await expect(second.updateAgentStatus("claim-owned-root", "pending")).rejects.toThrow(
				/mailbox claim owned by another live extension host/,
			)
			await first.releaseMailboxClaim("claim-owned-root", liveForeignClaim.claimId)
			await second.updateAgentStatus("claim-owned-root", "pending")
			await second.updateAgentStatus("claim-owned-root", "interrupted")

			await expect(second.ensureRoot({ taskId: "owned-root", status: "running" })).rejects.toThrow(
				/owned by another live extension host/,
			)
			await expect(
				second.createAgent({
					taskId: "foreign-child",
					parentTaskId: "owned-root",
					nickname: "Foreign",
					role: "explore",
					objective: "Must not start",
				}),
			).rejects.toThrow(/owned by another live extension host/)
			await expect(second.claimMailbox("owned-root", { channel: "wait", kinds: ["result"] })).rejects.toThrow(
				/owned by another live extension host/,
			)
			await expect(second.updateAgentSnapshot("owned-child", { stopReason: "failed" })).rejects.toThrow(
				/owned by another live extension host/,
			)
			await expect(second.purgeRoot("owned-root")).rejects.toThrow(/owned by another live extension host/)
			await expect(
				second.appendEvent({
					eventId: "foreign-senderless-event",
					recipient: "owned-root",
					kind: "control",
					name: "must_not_publish",
				}),
			).rejects.toThrow(/owned by another live extension host/)
			await expect(second.updateAgentStatus("owned-completed-child", "pending")).rejects.toThrow(
				/owned by another live extension host/,
			)
			await expect(second.closeAgent("owned-completed-child")).rejects.toThrow(
				/owned by another live extension host/,
			)
			await expect(
				second.recordWorkerChangeSet({
					rootTaskId: "owned-root",
					parentTaskId: "owned-root",
					workerTaskId: "owned-child",
					workerNickname: "Worker",
					groupId: "foreign-verification",
					changeSet: {
						id: "foreign-change-set",
						status: "applied",
						changedFiles: ["src/foreign.ts"],
						createdAt: 110_001,
						updatedAt: 110_002,
					},
				}),
			).rejects.toThrow(/owned by another live extension host/)
			await expect(
				second.recordParentVerificationEvidence("owned-root", [
					{
						toolCallId: "foreign-verification",
						executionId: "foreign-verification-execution",
						status: "succeeded",
						startedAt: 110_003,
						completedAt: 110_004,
					},
				]),
			).rejects.toThrow(/owned by another live extension host/)
			const retainedWaitClaim = await first.claimMailbox("owned-root", {
				channel: "wait",
				claimId: "host-a-wait-claim",
				kinds: ["result"],
				limit: 1,
			})
			const abandonedAutomaticClaim = await first.claimMailbox("owned-root", {
				channel: "automatic",
				claimId: "host-a-automatic-claim",
				kinds: ["result"],
				limit: 1,
			})

			// Simulate an abrupt host exit: the durable records remain active while
			// the activation heartbeat stops and its lock directory ages past TTL.
			await firstPersistence.releaseOwnerLease("host-a")
			const staleOwnerLock = path.join(`${firstPersistence.filePath}.owners`, "host-a.lock")
			await fs.mkdir(staleOwnerLock, { recursive: true })
			await fs.writeFile(
				path.join(`${firstPersistence.filePath}.owners`, "host-a.json"),
				JSON.stringify({ token: "abandoned-host-a", pid: 2_147_483_647 }),
				"utf8",
			)
			const staleMtime = new Date(Date.now() - 2 * 60_000)
			await fs.utimes(staleOwnerLock, staleMtime, staleMtime)
			await expect(second.recoverAbandonedOwners()).resolves.toBe(2)
			await expect(fs.stat(staleOwnerLock)).rejects.toMatchObject({ code: "ENOENT" })
			expect(second.getAgent("owned-root")?.status).toBe("interrupted")
			expect(second.getAgent("owned-root")?.runtimeOwnerId).toBeUndefined()
			expect(second.getAgent("owned-child")?.status).toBe("interrupted")
			expect(second.getAgent("owned-child")?.runtimeOwnerId).toBeUndefined()
			const recoveredWaitClaim = second.getSnapshot().mailbox.find(({ eventId }) => eventId === "owned-result")
			expect(recoveredWaitClaim?.claimId).toBe(retainedWaitClaim.claimId)
			expect(recoveredWaitClaim?.claimOwnerId).toBeUndefined()
			const recoveredAutomaticClaim = second
				.getSnapshot()
				.mailbox.find(({ eventId }) => eventId === "owned-automatic-result")
			expect(abandonedAutomaticClaim.entries.map(({ eventId }) => eventId)).toEqual(["owned-automatic-result"])
			expect(recoveredAutomaticClaim?.claimId).toBeUndefined()
			expect(recoveredAutomaticClaim?.claimOwnerId).toBeUndefined()
			await expect(
				second.settleMailboxClaim("owned-root", retainedWaitClaim.claimId, "release"),
			).resolves.toBeUndefined()
			await expect(second.closeAgent("owned-completed-child")).resolves.toMatchObject({
				taskId: "owned-completed-child",
			})
			await expect(first.updateAgentSnapshot("owned-child", { stopReason: "interrupted" })).rejects.toThrow(
				/runtime ownership changed after its lease was compromised/,
			)

			await second.shutdown()
			const resumed = new AgentControlStore(new FileAgentControlPersistence(directory), clock(120_000), {
				ownerId: "host-c",
			})
			stores.push(resumed)
			await resumed.initialize()
			await resumed.updateAgentStatus("owned-root", "pending")
			await resumed.updateAgentStatus("owned-child", "pending")
			expect(resumed.getAgent("owned-root")).toMatchObject({ status: "pending", runtimeOwnerId: "host-c" })
			expect(resumed.getAgent("owned-child")).toMatchObject({ status: "pending", runtimeOwnerId: "host-c" })
		} finally {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		}
	}, 60_000)

	it("migrates ownerless legacy v1 active records to the fenced v2 state", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-legacy-owner-"))
		const stores: AgentControlStore[] = []
		try {
			const persistence = new FileAgentControlPersistence(directory)
			await fs.writeFile(
				persistence.filePath,
				JSON.stringify({
					version: 1,
					updatedAt: 1,
					nextSequence: 1,
					agents: [
						{
							taskId: "legacy-root",
							path: "/root",
							rootTaskId: "legacy-root",
							nickname: "root",
							role: "root",
							objective: "Legacy active task",
							status: "running",
							createdAt: 1,
							updatedAt: 1,
							startedAt: 1,
						},
					],
					tombstones: [],
					mailbox: [],
					mailboxCursors: {},
					verificationObligations: [],
				}),
				"utf8",
			)
			const store = new AgentControlStore(persistence, clock(130_000), { ownerId: "legacy-recovery-host" })
			stores.push(store)
			await store.initialize()
			expect(store.getAgent("legacy-root")?.status).toBe("interrupted")
			expect(store.getAgent("legacy-root")?.runtimeOwnerId).toBeUndefined()
			expect(JSON.parse(await fs.readFile(persistence.filePath, "utf8")).version).toBe(2)
		} finally {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("durably migrates an unchanged empty v1 snapshot during initialization", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-empty-v1-"))
		const persistence = new FileAgentControlPersistence(directory)
		const store = new AgentControlStore(persistence, clock(135_000), { ownerId: "empty-v1-host" })

		try {
			await fs.writeFile(
				persistence.filePath,
				JSON.stringify({
					version: 1,
					updatedAt: 1,
					nextSequence: 1,
					agents: [],
					tombstones: [],
					mailbox: [],
					mailboxCursors: {},
					verificationObligations: [],
				}),
				"utf8",
			)

			await store.initialize()
			expect(store.getSnapshot().version).toBe(2)
			expect(JSON.parse(await fs.readFile(persistence.filePath, "utf8")).version).toBe(2)
		} finally {
			await store.shutdown()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("fails closed without rewriting an unsupported control-state version", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-unsupported-version-"))
		const persistence = new FileAgentControlPersistence(directory)
		const unsupportedState = {
			version: 3,
			updatedAt: 1,
			nextSequence: 1,
			agents: [],
			tombstones: [],
			mailbox: [],
			mailboxCursors: {},
			verificationObligations: [],
		}

		try {
			await fs.writeFile(persistence.filePath, JSON.stringify(unsupportedState), "utf8")
			const store = new AgentControlStore(persistence, clock(140_000), { ownerId: "unsupported-version-host" })

			await expect(store.initialize()).rejects.toThrow()
			expect(JSON.parse(await fs.readFile(persistence.filePath, "utf8"))).toEqual(unsupportedState)
		} finally {
			await persistence.releaseOwnerLease("unsupported-version-host")
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("shares one store per activation and rotates it after global shutdown", async () => {
		const storagePath = path.join(os.tmpdir(), `alpha-agent-control-shared-${randomUUID()}`)
		const first = AgentControlStore.forGlobalStorage(storagePath)

		expect(first).toBe(AgentControlStore.forGlobalStorage(path.resolve(storagePath)))
		await AgentControlStore.shutdownGlobalStores()
		const nextActivation = AgentControlStore.forGlobalStorage(storagePath)
		expect(nextActivation).not.toBe(first)
		await AgentControlStore.shutdownGlobalStores()
	})
})
