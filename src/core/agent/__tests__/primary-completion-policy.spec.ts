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
		expect(decision.allowed).toBe(false)
		expect(decision.blockingObligations).toEqual([
			expect.objectContaining({ changeSetId: "worker-change", status: "pending" }),
		])
		expect(decision.blockingObligations[0].verification).toBeUndefined()
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
})
