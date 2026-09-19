import * as assert from "node:assert/strict"
import { agentControlStateSchema, type AgentMailboxEntry } from "@alpha-code/types"
import {
	record,
	requireNonce,
	validateIdentity,
	type HostIdentity,
	type PairManifest,
	type Role,
} from "./sharedStorageProtocol"

export interface WorkerIdentity extends HostIdentity {
	rootTaskId: string
	workerTaskId: string
	workerPath: string
}
export interface WorkerResultIdentity {
	eventId: string
	sequence: number
	rootTaskId: string
	senderTaskId: string
	recipientTaskId: string
	kind: "result"
	name: string
	payloadTaskId: string
	status: "completed"
}
export interface SharedWorkerMailboxReport {
	version: 1
	taskIds: string[]
	requests: number
	roots: WorkerIdentity[]
	result: WorkerResultIdentity
	interruptedEventId: string
	winner: Role
	claimId: string
	noRedelivery: true
	activeChildrenAfterClose: 0
	retryOutcomes: { a: "empty"; b: "empty" | "ownership_denied" }
}
const token = (value: unknown): string => {
	assert.ok(typeof value === "string" && /^[A-Za-z0-9:_./-]{1,256}$/.test(value))
	return value
}
export function validateWorkerIdentity(value: unknown, manifest: PairManifest, role: Role): WorkerIdentity {
	const item = requireNonce(value, manifest)
	assert.equal(item.sharedWorkerMailbox, 1)
	return {
		...validateIdentity(value, manifest, role),
		rootTaskId: token(item.rootTaskId),
		workerTaskId: token(item.workerTaskId),
		workerPath: token(item.workerPath),
	}
}
export function resultIdentity(entry: AgentMailboxEntry, owner: WorkerIdentity): WorkerResultIdentity {
	assert.equal(entry.kind, "result")
	assert.equal(entry.name, "agent_completed")
	assert.equal(entry.rootTaskId, owner.rootTaskId)
	assert.equal(entry.senderTaskId, owner.workerTaskId)
	assert.equal(entry.recipientTaskId, owner.rootTaskId)
	assert.equal(entry.payload?.taskId, owner.workerTaskId)
	assert.equal(entry.payload?.status, "completed")
	return {
		eventId: entry.eventId,
		sequence: entry.sequence,
		rootTaskId: entry.rootTaskId,
		senderTaskId: owner.workerTaskId,
		recipientTaskId: entry.recipientTaskId,
		kind: "result",
		name: entry.name,
		payloadTaskId: owner.workerTaskId,
		status: "completed",
	}
}
export function validateWorkerResult(value: unknown, owner: WorkerIdentity): WorkerResultIdentity {
	const result = record(value)
	assert.equal(result.kind, "result")
	assert.equal(result.name, "agent_completed")
	assert.equal(result.status, "completed")
	assert.equal(result.rootTaskId, owner.rootTaskId)
	assert.equal(result.senderTaskId, owner.workerTaskId)
	assert.equal(result.recipientTaskId, owner.rootTaskId)
	assert.equal(result.payloadTaskId, owner.workerTaskId)
	assert.ok(Number.isSafeInteger(result.sequence) && Number(result.sequence) > 0)
	return {
		eventId: token(result.eventId),
		sequence: Number(result.sequence),
		rootTaskId: owner.rootTaskId,
		senderTaskId: owner.workerTaskId,
		recipientTaskId: owner.rootTaskId,
		kind: "result",
		name: token(result.name),
		payloadTaskId: owner.workerTaskId,
		status: "completed",
	}
}
export function validateWorkerClaims(
	values: unknown[],
	manifest: PairManifest,
	roots: WorkerIdentity[],
	result: WorkerResultIdentity,
) {
	assert.equal(values.length, 2)
	const claims = values.map((value, index) => {
		const item = record(value)
		const role = index === 0 ? "a" : "b"
		assert.deepEqual(validateWorkerIdentity(item, manifest, role), roots[index])
		assert.deepEqual(validateWorkerResult(item.result, roots[0]!), result)
		assert.equal(item.claimId, `${manifest.nonce}-worker-${role}`)
		assert.ok(["claimed", "empty", "ownership_denied"].includes(String(item.outcome)))
		assert.deepEqual(item.eventIds, item.outcome === "claimed" ? [result.eventId] : [])
		return { role: role as Role, claimId: String(item.claimId), outcome: String(item.outcome) }
	})
	assert.equal(claims.filter((item) => item.outcome === "claimed").length, 1)
	return claims
}
export function validateSharedWorkerControl(value: unknown, report: SharedWorkerMailboxReport): void {
	const control = agentControlStateSchema.parse(value)
	const owner = report.roots[0]!
	const actualResults = control.mailbox.filter(
		(entry) =>
			entry.kind === "result" &&
			entry.senderTaskId === owner.workerTaskId &&
			entry.recipientTaskId === owner.rootTaskId,
	)
	assert.equal(actualResults.length, 2, "Interrupted and completed runs must each publish one result")
	assert.equal(actualResults.filter((entry) => entry.payload?.status === "completed").length, 1)
	const matches = control.mailbox.filter((entry) => entry.eventId === report.result.eventId)
	assert.equal(matches.length, 1)
	assert.deepEqual(resultIdentity(matches[0]!, owner), report.result)
	assert.equal(matches[0]!.claimId, report.claimId)
	assert.ok(matches[0]!.acknowledgedAt !== undefined)
	const interrupted = control.mailbox.filter((entry) => entry.eventId === report.interruptedEventId)
	assert.equal(interrupted.length, 1)
	assert.equal(interrupted[0]!.kind, "result")
	assert.equal(interrupted[0]!.rootTaskId, owner.rootTaskId)
	assert.equal(interrupted[0]!.senderTaskId, owner.workerTaskId)
	assert.equal(interrupted[0]!.recipientTaskId, owner.rootTaskId)
	assert.ok(interrupted[0]!.acknowledgedAt !== undefined)
	for (const root of report.roots) {
		assert.equal(
			control.agents.filter((agent) => agent.rootTaskId === root.rootTaskId && agent.role !== "root").length,
			0,
		)
		const closed = control.tombstones.filter((agent) => agent.taskId === root.workerTaskId)
		assert.equal(closed.length, 1)
		assert.equal(closed[0]!.rootTaskId, root.rootTaskId)
		assert.equal(closed[0]!.parentTaskId, root.rootTaskId)
		assert.equal(closed[0]!.path, root.workerPath)
		assert.equal(closed[0]!.status, root.role === "a" ? "completed" : "cancelled")
	}
}
