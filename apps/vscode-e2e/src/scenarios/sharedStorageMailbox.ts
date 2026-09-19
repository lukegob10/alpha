import * as assert from "node:assert/strict"
import {
	mailboxEventId,
	publish,
	readOptional,
	validateTaskIdentity,
	type HostIdentity,
	type PairManifest,
} from "../evidence/sharedStorageProtocol"

/** Structural view of the installed extension's store; no second store or execution runtime. */
export interface MailboxStore {
	appendEvent(input: {
		eventId: string
		recipient: string
		rootTaskId: string
		kind: "control"
		name: string
	}): Promise<{ appended: boolean }>
	claimMailbox(
		recipient: string,
		options: { rootTaskId: string; channel: "wait"; claimId: string; kinds: ["control"] },
	): Promise<{ entries: { eventId: string }[] }>
	acknowledgeMailboxClaim(recipient: string, claimId: string, rootTaskId: string): Promise<unknown>
}

export async function exerciseSharedMailbox(
	store: MailboxStore,
	directory: string,
	manifest: PairManifest,
	identity: HostIdentity,
	waitPhase: (name: string) => Promise<void>,
) {
	assert.equal(manifest.mailboxClaimRace, 1)
	await waitPhase("mailbox-start")
	const recipient = validateTaskIdentity(await readOptional(directory, "task-a.json"), manifest, "a").taskId
	const eventId = mailboxEventId(manifest)
	const claimId = `${manifest.nonce}-${identity.role}`
	const receipt = { ...identity, mailboxClaimRace: 1, recipientTaskId: recipient, eventId }
	if (identity.role === "a") {
		const appended = await store.appendEvent({
			eventId,
			recipient,
			rootTaskId: recipient,
			kind: "control",
			name: "paired_host_claim_probe",
		})
		assert.equal(appended.appended, true)
	}
	await publish(directory, `mailbox-ready-${identity.role}.json`, receipt)
	await waitPhase("mailbox-claim")
	const options = { rootTaskId: recipient, channel: "wait" as const, claimId, kinds: ["control"] as ["control"] }
	let outcome: "claimed" | "empty" | "ownership_denied"
	let claimedEventIds: string[] = []
	try {
		const claim = await store.claimMailbox(recipient, options)
		claimedEventIds = claim.entries.map((entry) => entry.eventId)
		assert.ok(claimedEventIds.length === 0 || (claimedEventIds.length === 1 && claimedEventIds[0] === eventId))
		outcome = claimedEventIds.length === 1 ? "claimed" : "empty"
	} catch (error) {
		// Only the expected cross-host live-claim exclusion is an acceptable losing result.
		assert.ok(
			error instanceof Error &&
				error.message ===
					`Agent tree ${recipient} has a mailbox claim owned by another live extension host and this host cannot claim its mailbox`,
		)
		outcome = "ownership_denied"
	}
	await publish(directory, `mailbox-claimed-${identity.role}.json`, { ...receipt, claimId, outcome, claimedEventIds })
	// The winner cannot ACK until both contenders have published their outcomes.
	await waitPhase("mailbox-ack")
	if (outcome === "claimed") {
		await store.acknowledgeMailboxClaim(recipient, claimId, recipient)
		await publish(directory, "mailbox-acked.json", receipt)
	}
	await waitPhase("mailbox-acked")
	const retry = await store.claimMailbox(recipient, { ...options, claimId: `${claimId}-retry` })
	assert.deepEqual(retry.entries, [])
	await publish(directory, `mailbox-verified-${identity.role}.json`, {
		...receipt,
		acknowledged: outcome === "claimed",
		retryCount: retry.entries.length,
	})
}
