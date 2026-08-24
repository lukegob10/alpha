import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import { AgentControlStore, FileAgentControlPersistence, InMemoryAgentControlPersistence } from "../AgentControlStore"

const clock = (initial = 1_000) => {
	let current = initial
	return () => ++current
}

const setup = async (persistence = new InMemoryAgentControlPersistence()) => {
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
					startedAt: 2_099,
					completedAt: 2_101,
				},
			]),
		).toEqual([])
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "unrelated",
					executionId: "execution-unrelated",
					status: "succeeded",
					command: "pnpm test unrelated.spec.ts",
					startedAt: 2_101,
					completedAt: 2_102,
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
				startedAt: 2_101,
				completedAt: 2_102,
				exitCode: 1,
			},
		])
		expect(failed).toMatchObject([{ status: "failed", verification: { status: "failed" } }])
		expect(store.getParentCompletionDecision("root-1").message).toContain("latest parent command failed")
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				{
					toolCallId: "verify-failed",
					executionId: "execution-failed",
					status: "failed",
					command: "node scripts/verify.js src/example.ts",
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
				command: "node scripts/verify.js src/example.ts",
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
				command: "pnpm test src/one.ts src/two.ts",
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
		try {
			const persistence = new FileAgentControlPersistence(directory)
			const first = new AgentControlStore(persistence, clock(50_000))
			await first.initialize()
			await first.ensureRoot({ taskId: "root-file", status: "interrupted" })

			const raw = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(raw).toMatchObject({ version: 1, agents: [{ taskId: "root-file", path: "/root" }] })

			const reloaded = new AgentControlStore(new FileAgentControlPersistence(directory), clock(60_000))
			await reloaded.initialize()
			expect(reloaded.getAgent("root-file")?.path).toBe("/root")
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("shares one in-process store for the same global storage path", () => {
		const storagePath = path.join(os.tmpdir(), `alpha-agent-control-shared-${randomUUID()}`)

		expect(AgentControlStore.forGlobalStorage(storagePath)).toBe(
			AgentControlStore.forGlobalStorage(path.resolve(storagePath)),
		)
	})
})
