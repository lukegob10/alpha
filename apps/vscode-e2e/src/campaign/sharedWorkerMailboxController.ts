import * as assert from "node:assert/strict"
import {
	publish,
	readOptional,
	record,
	validateIdentities,
	type PairManifest,
	type HostIdentity,
} from "../evidence/sharedStorageProtocol"
import {
	validateWorkerIdentity,
	validateWorkerResult,
	validateWorkerClaims,
	type SharedWorkerMailboxReport,
} from "../evidence/sharedWorkerMailbox"

export async function runSharedWorkerMailboxController(options: {
	manifest: PairManifest
	identities: HostIdentity[]
	directory: string
	awaitPair: (phase: string) => Promise<unknown[]>
	verifyLive: () => Promise<void>
}): Promise<SharedWorkerMailboxReport> {
	const { manifest, identities, directory, awaitPair, verifyLive } = options
	assert.equal(manifest.sharedWorkerMailbox, 1)
	const command = (name: string) =>
		publish(directory, `${name}.json`, { runId: manifest.runId, nonce: manifest.nonce })
	await command("worker-start")
	const ready = await awaitPair("worker-ready")
	assert.deepEqual(validateIdentities(ready, manifest), identities)
	const roots = ready.map((value, index) => validateWorkerIdentity(value, manifest, index === 0 ? "a" : "b"))
	const taskIds = roots.flatMap((root) => [root.rootTaskId, root.workerTaskId])
	assert.equal(new Set(taskIds).size, 4)
	await verifyLive()
	await command("worker-interrupt")
	const results = await awaitPair("worker-result")
	assert.deepEqual(validateIdentities(results, manifest), identities)
	for (const [index, value] of results.entries())
		assert.deepEqual(validateWorkerIdentity(value, manifest, index === 0 ? "a" : "b"), roots[index])
	const a = record(results[0])
	const b = record(results[1])
	const result = validateWorkerResult(a.result, roots[0]!)
	assert.deepEqual(validateWorkerResult(b.result, roots[0]!), result)
	assert.equal(a.followupTaskId, roots[0]!.workerTaskId)
	assert.ok(
		typeof a.interruptedEventId === "string" &&
			a.interruptedEventId.length > 0 &&
			a.interruptedEventId !== result.eventId,
	)
	assert.equal(b.uninterrupted, true)
	assert.equal(b.requestCount, 1)
	await verifyLive()
	await command("worker-claim")
	const claimValues = await awaitPair("worker-claimed")
	const claims = validateWorkerClaims(claimValues, manifest, roots, result)
	const winner = claims.find((claim) => claim.outcome === "claimed")!
	await command("worker-ack")
	const verified = await awaitPair("worker-verified")
	for (const [index, value] of verified.entries()) {
		const item = record(value)
		assert.deepEqual(validateWorkerIdentity(item, manifest, index === 0 ? "a" : "b"), roots[index])
		assert.deepEqual(validateWorkerResult(item.result, roots[0]!), result)
		assert.equal(item.retryCount, 0)
		assert.ok(item.retryOutcome === "empty" || (index === 1 && item.retryOutcome === "ownership_denied"))
	}
	const ack = record(await readOptional(directory, "worker-acked.json"))
	assert.deepEqual(validateWorkerIdentity(ack, manifest, winner.role), roots[winner.role === "a" ? 0 : 1])
	assert.deepEqual(validateWorkerResult(ack.result, roots[0]!), result)
	assert.equal(ack.claimId, winner.claimId)
	await verifyLive()
	await command("worker-close")
	const done = await awaitPair("worker-done")
	let requests = 0
	for (const [index, value] of done.entries()) {
		const item = record(value)
		assert.deepEqual(validateWorkerIdentity(item, manifest, index === 0 ? "a" : "b"), roots[index])
		assert.deepEqual(validateWorkerResult(item.result, roots[0]!), result)
		assert.equal(item.requests, index === 0 ? 3 : 2)
		assert.equal(item.activeChildrenAfterClose, 0)
		assert.equal(item.closed, true)
		assert.equal(item.rootStopped, true)
		requests += Number(item.requests)
	}
	await verifyLive()
	return {
		version: 1,
		roots,
		taskIds,
		requests,
		result,
		interruptedEventId: String(a.interruptedEventId),
		winner: winner.role,
		claimId: winner.claimId,
		noRedelivery: true,
		activeChildrenAfterClose: 0,
		retryOutcomes: { a: "empty", b: record(verified[1]).retryOutcome as "empty" | "ownership_denied" },
	}
}
