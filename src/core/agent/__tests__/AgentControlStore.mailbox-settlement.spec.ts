import type { AgentRuntimeOwnerId } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence, type AgentControlPersistence } from "../AgentControlStore"

function transactionalPersistence() {
	const memory = new InMemoryAgentControlPersistence()
	const owners = new Set<AgentRuntimeOwnerId>()
	let failNextTransaction = false
	const persistence: AgentControlPersistence = {
		read: () => memory.read(),
		write: (state) => memory.write(state),
		acquireOwnerLease: async (owner) => {
			owners.add(owner)
		},
		isOwnerLeaseLive: async (owner) => owners.has(owner),
		tryRevokeOwnerLease: async () => false,
		releaseOwnerLease: async (owner) => {
			owners.delete(owner)
		},
		withTransaction: async (operation) => {
			if (failNextTransaction) {
				failNextTransaction = false
				throw new Error("Transient settlement transaction failure")
			}
			return operation()
		},
	}
	return {
		persistence,
		failNextTransaction: () => {
			failNextTransaction = true
		},
	}
}

describe("AgentControlStore production-shaped mailbox settlement", () => {
	it.each(["acknowledge", "release"] as const)(
		"retains %s intent when the first settlement transaction fails",
		async (disposition) => {
			const fixture = transactionalPersistence()
			const store = new AgentControlStore(fixture.persistence)
			await store.initialize()
			try {
				await store.ensureRoot({ taskId: "root", status: "running" })
				await store.createAgent({
					taskId: "child",
					parentTaskId: "root",
					nickname: "Review",
					role: "review",
					objective: "Review communication",
					status: "running",
				})
				await store.appendEvent({
					eventId: "accepted-input",
					sender: "child",
					recipient: "root",
					kind: "message",
					name: "agent_message",
					payload: { message: "A continuation finding" },
				})
				const claim = await store.claimMailbox("root", { channel: "automatic", kinds: ["message"] })
				expect(claim.entries).toHaveLength(1)
				fixture.failNextTransaction()

				await expect(store.settleMailboxClaim("root", claim.claimId, disposition, "root")).rejects.toThrow(
					"Transient settlement transaction failure",
				)
				// A live host's claim must be settled by its retained consumer intent;
				// periodic abandoned-owner recovery correctly leaves it alone.
				expect(await store.recoverAbandonedOwners()).toBe(0)
				await expect(
					store.settleMailboxClaim(
						"root",
						claim.claimId,
						disposition === "acknowledge" ? "release" : "acknowledge",
						"root",
					),
				).rejects.toThrow("different pending settlement")
				await expect(store.retryPendingMailboxClaimSettlements("root", "root")).resolves.toBe(1)
				await expect(store.retryPendingMailboxClaimSettlements("root", "root")).resolves.toBe(0)
				const next = await store.claimMailbox("root", { channel: "automatic", kinds: ["message"] })
				if (disposition === "acknowledge") {
					expect(next.entries).toEqual([])
					expect(store.getUnacknowledgedMailboxEntries("root", { kinds: ["message"] })).toEqual([])
				} else {
					expect(next.entries.map(({ eventId }) => eventId)).toEqual(["accepted-input"])
					expect(next.claimId).not.toBe(claim.claimId)
				}
			} finally {
				await store.shutdown()
			}
		},
	)
})
