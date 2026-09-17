import { describe, expect, it } from "vitest"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"
import {
	decideParentCompletion,
	formatParentVerificationContext,
	summarizeParentVerification,
} from "../ParentVerification"

describe("proportionate primary completion", () => {
	it("invalidates earlier Worker evidence when a completed command's diff is unavailable", async () => {
		const store = new AgentControlStore(new InMemoryAgentControlPersistence())
		await store.initialize()
		await store.ensureRoot({ taskId: "root", objective: "Integrate changes", status: "running" })
		await store.recordWorkerChangeSet({
			rootTaskId: "root",
			parentTaskId: "root",
			workerTaskId: "worker",
			workerNickname: "Worker",
			groupId: "group",
			reviewSource: "apply",
			at: 2,
			changeSet: {
				id: "worker-change",
				status: "applied",
				changedFiles: ["code.ts"],
				createdAt: 1,
				updatedAt: 2,
			},
		})
		await store.recordParentVerificationEvidence("root", [
			{
				toolCallId: "check",
				executionId: "check",
				status: "succeeded",
				verificationChangeSetIds: ["worker-change"],
				startedAt: 3,
				completedAt: 4,
				exitCode: 0,
			},
		])
		expect(store.getParentCompletionDecision("root").allowed).toBe(true)
		await store.reservePrimaryMutation("root", "root", "/workspace", "command")
		await store.releasePrimaryMutation("root", "root", "command", true)
		const decision = store.getParentCompletionDecision("root")
		expect(decision.allowed).toBe(true)
		expect(decision.blockingObligations).toEqual([])
		const worker = store.getVerificationObligations().find((item) => item.changeSetId === "worker-change")
		expect(worker).toMatchObject({ changeSetId: "worker-change", status: "pending" })
		expect(worker?.verification).toBeUndefined()
	})

	it("persists incomplete observation without inventing an unfinished command", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root", objective: "Run a diagnostic", status: "running" })
		await store.reservePrimaryMutation("root", "root", "/workspace", "command")
		expect(store.getParentCompletionDecision("root").allowed).toBe(false)
		await store.releasePrimaryMutation("root", "root", "command", true)
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getVerificationObligations()[0]).toMatchObject({
			observationIncomplete: true,
			mutationReservations: [],
			changedFiles: [],
		})
		expect(reloaded.getVerificationObligations()[0].scopeUnresolved).not.toBe(true)
		expect(reloaded.getParentCompletionDecision("root").allowed).toBe(true)
		await expect(reloaded.releasePrimaryMutation("root", "root", "wrong-token", true)).rejects.toThrow(
			"active reservation",
		)
	})

	it("bounds accumulated receipt metadata without failing the 257th completed edit", async () => {
		const store = new AgentControlStore(new InMemoryAgentControlPersistence())
		await store.initialize()
		await store.ensureRoot({ taskId: "root", objective: "Update generated files", status: "running" })
		const receipt = await store.recordPrimaryMutation({
			rootTaskId: "root",
			parentTaskId: "root",
			workspacePath: "/workspace",
			fileVersions: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`file-${index}`, "changed"])),
		})
		expect(Object.keys(receipt!.fileVersions!)).toHaveLength(256)
		expect(receipt!.observationIncomplete).toBe(true)
		expect(store.getParentCompletionDecision("root").allowed).toBe(true)
	})

	it("retains change receipts across reload without demanding a recognized check for ordinary edits", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root", objective: "Correct a README typo", status: "running" })
		await store.recordPrimaryMutation({
			rootTaskId: "root",
			parentTaskId: "root",
			workspacePath: "/workspace",
			fileVersions: { "README.md": "updated" },
			verificationRequirements: { "README.md": [] },
		})
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		const obligations = reloaded.getVerificationObligations({ parentTaskId: "root" })
		expect(obligations[0].changedFiles).toEqual(["README.md"])
		expect(reloaded.getParentCompletionDecision("root").allowed).toBe(true)
		expect(formatParentVerificationContext(obligations)).toBeUndefined()
		expect(summarizeParentVerification(obligations)?.blocking ?? false).toBe(false)
		// The same historical status still gates reviewed Worker changes.
		expect(decideParentCompletion([{ ...obligations[0], origin: "worker" }]).allowed).toBe(false)
		for (const pending of [{ mutationReservations: ["running"] }, { scopeUnresolved: true }]) {
			expect(decideParentCompletion([{ ...obligations[0], ...pending }]).allowed).toBe(false)
		}
	})

	it("does not block approved Worker changes when optional process evidence is missing or failed", () => {
		const base = {
			id: "worker-change:optional",
			rootTaskId: "root",
			parentTaskId: "root",
			workerTaskId: "worker",
			workerNickname: "Worker",
			groupId: "group",
			changeSetId: "optional",
			origin: "worker" as const,
			changedFiles: ["src/change.ts"],
			createdAt: 1,
			updatedAt: 2,
			appliedAt: 2,
			review: { decision: "approved" as const, source: "apply" as const, recordedAt: 2 },
		}

		for (const status of ["pending", "failed"] as const) {
			const obligation = { ...base, status }
			expect(decideParentCompletion([obligation])).toMatchObject({ allowed: true, blockingObligations: [] })
			expect(summarizeParentVerification([obligation])).toMatchObject({
				status,
				blocking: false,
				unresolvedCount: 0,
			})
			expect(formatParentVerificationContext([obligation])).toBeUndefined()
		}
	})

	it("fails closed for an applied Worker record without approved review or effect settlement", () => {
		const obligation = {
			id: "worker-change:unreviewed",
			rootTaskId: "root",
			parentTaskId: "root",
			workerTaskId: "worker",
			workerNickname: "Worker",
			groupId: "group",
			changeSetId: "unreviewed",
			origin: "worker" as const,
			changedFiles: ["src/change.ts"],
			status: "pending" as const,
			createdAt: 1,
			updatedAt: 2,
		}
		const decision = decideParentCompletion([obligation])
		expect(decision.allowed).toBe(false)
		expect(decision.blockingObligations).toEqual([expect.objectContaining({ changeSetId: "unreviewed" })])
		expect(decision.message).toContain("approved review")
		const optionalFailure = {
			...obligation,
			id: "worker-change:optional",
			changeSetId: "optional",
			status: "failed" as const,
			appliedAt: 2,
			review: { decision: "approved" as const, source: "apply" as const, recordedAt: 2 },
		}
		expect(summarizeParentVerification([optionalFailure, obligation])).toMatchObject({
			blocking: true,
			changeSetId: "unreviewed",
			status: "pending",
			unresolvedCount: 1,
			message: expect.stringContaining("approved review"),
		})
		const processSuccess = {
			...optionalFailure,
			status: "satisfied" as const,
			verification: {
				assurance: "process" as const,
				status: "passed" as const,
				toolCallId: "tool",
				executionId: "execution",
				startedAt: 3,
				completedAt: 4,
				exitCode: 0,
			},
		}
		expect(summarizeParentVerification([processSuccess])).toMatchObject({
			blocking: false,
			unresolvedCount: 0,
			message: expect.stringContaining("test coverage is not established"),
		})
	})
})
