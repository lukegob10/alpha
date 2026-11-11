import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	AgentControlStore,
	FileAgentControlPersistence,
	type AgentControlTransactionOptions,
} from "../AgentControlStore"

const ownerId = "committing-host"

class CompromisedCommitPersistence extends FileAgentControlPersistence {
	compromiseAfter?: "write" | "transaction release"
	private notifyCompromise?: (error: Error) => void

	override async acquireOwnerLease(...args: Parameters<FileAgentControlPersistence["acquireOwnerLease"]>) {
		await super.acquireOwnerLease(...args)
		if (args[0] === ownerId) this.notifyCompromise = args[1].onCompromised
	}

	override async write(state: Parameters<FileAgentControlPersistence["write"]>[0]) {
		await super.write(state)
		await this.compromiseAt("write")
	}

	override async withTransaction<T>(
		operation: () => Promise<T>,
		options?: AgentControlTransactionOptions,
	): Promise<T> {
		const value = await super.withTransaction(operation, options)
		await this.compromiseAt("transaction release")
		return value
	}

	private async compromiseAt(boundary: "write" | "transaction release") {
		if (this.compromiseAfter !== boundary) return
		this.compromiseAfter = undefined
		if (!this.notifyCompromise) throw new Error("The owner lease has not been acquired")
		await this.releaseOwnerLease(ownerId)
		this.notifyCompromise(new Error("Owner heartbeat was compromised during commit"))
	}
}

describe("AgentControlStore owner lease recovery during commit", () => {
	let directory: string
	let persistence: CompromisedCommitPersistence
	let store: AgentControlStore
	let observer: AgentControlStore

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-owner-commit-"))
		persistence = new CompromisedCommitPersistence(directory)
		store = new AgentControlStore(persistence, Date.now, { ownerId })
		observer = new AgentControlStore(new FileAgentControlPersistence(directory), Date.now, {
			ownerId: "other-host",
		})
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		await store.initialize()
		await observer.initialize()
	})

	afterEach(async () => {
		await store.shutdown()
		await observer.shutdown()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each(["write", "transaction release"] as const)(
		"keeps prelaunch bookkeeping available when a lease is compromised after a terminal %s",
		async (boundary) => {
			await store.ensureRoot({ taskId: "finished-root" })
			await store.ensureRoot({ taskId: "command-root" })
			persistence.compromiseAfter = boundary
			await store.updateAgentStatus("finished-root", "completed")

			await expect(
				store.reservePrimaryMutation("command-root", "command-root", directory, "command"),
			).resolves.toBeUndefined()
			expect(store.getAgent("finished-root")?.status).toBe("completed")
			expect(store.getAgent("command-root")).toMatchObject({ status: "running" })
			expect(store.getAgent("command-root")?.runtimeOwnerId).not.toBe(ownerId)
		},
	)

	it.each(["acknowledge", "release"] as const)(
		"preserves committed mailbox settlements (%s) after compromise",
		async (action) => {
			await store.ensureRoot({ taskId: "recipient" })
			const { entry } = await store.appendEvent({ recipient: "recipient", kind: "result", name: "result" })
			const claim = await store.claimMailbox("recipient", { channel: "wait" })
			persistence.compromiseAfter = "transaction release"
			await store.settleMailboxClaim("recipient", claim.claimId, action)

			const next = await store.claimMailbox("recipient", { channel: "wait" })
			expect(next.entries.map(({ eventId }) => eventId)).toEqual(action === "release" ? [entry.eventId] : [])
		},
	)

	it("fences a newly admitted task that a foreign host reaps after the commit", async () => {
		persistence.compromiseAfter = "write"
		await store.ensureRoot({ taskId: "abandoned-root" })

		await expect(observer.recoverAbandonedOwners()).resolves.toBe(1)
		await expect(store.updateAgentStatus("abandoned-root", "pending")).rejects.toThrow(
			"Agent runtime ownership changed after its lease was compromised (tasks: abandoned-root)",
		)
		expect(await persistence.read()).toMatchObject({
			agents: [{ taskId: "abandoned-root", status: "interrupted" }],
		})
	})

	it("fences a newly admitted wait claim that a foreign host reaps after the commit", async () => {
		await store.ensureRoot({ taskId: "inactive-root", status: "interrupted" })
		const { entry } = await store.appendEvent({ recipient: "inactive-root", kind: "result", name: "result" })
		persistence.compromiseAfter = "write"
		const claim = await store.claimMailbox("inactive-root", { channel: "wait" })

		await expect(observer.recoverAbandonedOwners()).resolves.toBe(0)
		await expect(store.acknowledgeMailboxClaim("inactive-root", claim.claimId)).rejects.toThrow(
			`Agent runtime ownership changed after its lease was compromised (mailbox events: ${entry.eventId})`,
		)
		expect(observer.getSnapshot().mailbox[0]).toMatchObject({ claimId: claim.claimId })
		expect(observer.getSnapshot().mailbox[0].claimOwnerId).toBeUndefined()
	})
})
