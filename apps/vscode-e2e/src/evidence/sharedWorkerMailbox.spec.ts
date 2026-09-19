import * as assert from "node:assert/strict"
import { test } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import { SharedWorkerAI, stopSharedWorkerRoot } from "../scenarios/sharedWorkerMailbox"
import {
	validateWorkerClaims,
	validateWorkerResult,
	validateSharedWorkerControl,
	type SharedWorkerMailboxReport,
	type WorkerIdentity,
	type WorkerResultIdentity,
} from "./sharedWorkerMailbox"
import type { PairManifest } from "./sharedStorageProtocol"

test("owned root close requires successful cancellation before joining the original instance", async () => {
	const calls: unknown[] = []
	const parent = {
		taskId: "root-a",
		getTaskLifetimeCancellationSignal: () => new AbortController().signal,
		waitForTermination: async () => {
			calls.push("joined-original")
		},
	}
	await stopSharedWorkerRoot(
		{
			removeTaskFromStack: async (options) => {
				calls.push(options)
			},
		},
		parent,
	)
	assert.deepEqual(calls, [{ taskId: "root-a", requireAbortSuccess: true }, "joined-original"])
	const failure = new Error("cleanup failed")
	await assert.rejects(
		stopSharedWorkerRoot(
			{
				removeTaskFromStack: async () => {
					throw failure
				},
			},
			parent,
		),
		(error) => error === failure,
	)
	assert.equal(calls.length, 2)
})

test("held real-provider fixture observes cancellation and resumes the same Worker identity once", async () => {
	const model = new SharedWorkerAI("test-shared-worker")
	model.registerWorker("worker-a")
	const cancellation = new AbortController()
	const first = model.createMessage("", [], { taskId: "worker-a", signal: cancellation.signal })
	assert.equal((await first.next()).value?.type, "text")
	const blocked = first.next()
	const rejected = assert.rejects(blocked, { name: "AbortError" })
	cancellation.abort()
	await rejected
	assert.deepEqual(model.requests.get("worker-a"), [{ aborted: true, settled: true }])
	const chunks = []
	for await (const chunk of model.createMessage("", [], { taskId: "worker-a", signal: new AbortController().signal }))
		chunks.push(chunk)
	assert.equal(chunks.length, 2)
	assert.equal(chunks[0]!.type, "text")
	assert.equal(model.requests.get("worker-a")?.length, 2)
	await assert.rejects(
		model.createMessage("", [], { taskId: "worker-a", signal: new AbortController().signal }).next(),
		/Unexpected shared Worker/,
	)
	model.dispose()
})

const profile = path.resolve(os.tmpdir(), "worker-mailbox-test")
const manifest: PairManifest = {
	runId: "worker-run",
	nonce: "worker-nonce",
	controllerPid: 1,
	profileRoot: profile,
	artifactsRoot: path.join(profile, "evidence"),
	deadline: Date.now() + 10000,
	hostVersion: "1.122.1",
	roles: {
		a: { workspace: path.join(profile, "a"), workspaceFile: path.join(profile, "a.code-workspace") },
		b: { workspace: path.join(profile, "b"), workspaceFile: path.join(profile, "b.code-workspace") },
	},
}
const roots: WorkerIdentity[] = (["a", "b"] as const).map((role, index) => ({
	runId: manifest.runId,
	nonce: manifest.nonce,
	role,
	pid: index + 2,
	hostVersion: "1.122.1",
	workspaceFile: manifest.roles[role].workspaceFile,
	storagePath: path.join(profile, "storage"),
	persistenceFile: path.join(profile, "storage", "agent_control.json"),
	rootTaskId: `root-${role}`,
	workerTaskId: `worker-${role}`,
	workerPath: `/root/worker-${role}`,
}))
const result: WorkerResultIdentity = {
	eventId: "agent-lifecycle:result-a",
	sequence: 2,
	rootTaskId: "root-a",
	senderTaskId: "worker-a",
	recipientTaskId: "root-a",
	kind: "result",
	name: "agent_completed",
	payloadTaskId: "worker-a",
	status: "completed",
}
const claims = () =>
	roots.map((root, index) => ({
		...root,
		sharedWorkerMailbox: 1,
		result,
		claimId: `${manifest.nonce}-worker-${root.role}`,
		outcome: index === 0 ? "claimed" : "ownership_denied",
		eventIds: index === 0 ? [result.eventId] : [],
	}))

test("actual Worker result claims reject duplicate delivery, wrong sender, stale nonce and changed root", () => {
	assert.equal(validateWorkerClaims(claims(), manifest, roots, result)[0]?.outcome, "claimed")
	const duplicate = claims()
	duplicate[1]!.outcome = "claimed"
	duplicate[1]!.eventIds = [result.eventId]
	assert.throws(() => validateWorkerClaims(duplicate, manifest, roots, result))
	assert.throws(() => validateWorkerResult({ ...result, senderTaskId: "worker-b" }, roots[0]!))
	assert.throws(() => validateWorkerResult({ ...result, rootTaskId: "root-b" }, roots[0]!))
	const stale = claims()
	stale[0]!.nonce = "old"
	assert.throws(() => validateWorkerClaims(stale, manifest, roots, result))
})

test("durable Worker evidence rejects replayed results, missing ACK and wrong parent tombstones", () => {
	const report: SharedWorkerMailboxReport = {
		version: 1,
		roots,
		taskIds: roots.flatMap((root) => [root.rootTaskId, root.workerTaskId]),
		requests: 5,
		result,
		interruptedEventId: "agent-lifecycle:interrupted-a",
		winner: "a",
		claimId: "worker-claim-a",
		noRedelivery: true,
		activeChildrenAfterClose: 0,
		retryOutcomes: { a: "empty", b: "ownership_denied" },
	}
	const event = {
		eventId: result.eventId,
		sequence: 2,
		rootTaskId: "root-a",
		senderTaskId: "worker-a",
		recipientTaskId: "root-a",
		recipientPath: "/root",
		kind: "result",
		name: "agent_completed",
		payload: { taskId: "worker-a", status: "completed" },
		createdAt: 1,
		claimId: report.claimId,
		acknowledgedAt: 2,
	}
	const control = {
		version: 2,
		updatedAt: 3,
		nextSequence: 3,
		agents: [],
		tombstones: roots.map((root) => ({
			taskId: root.workerTaskId,
			path: root.workerPath,
			parentTaskId: root.rootTaskId,
			rootTaskId: root.rootTaskId,
			status: root.role === "a" ? "completed" : "cancelled",
			closedAt: 3,
		})),
		mailbox: [
			{
				...event,
				eventId: report.interruptedEventId,
				sequence: 1,
				name: "agent_cancelled",
				payload: { taskId: "worker-a", status: "cancelled" },
			},
			event,
		],
		mailboxCursors: {},
	}
	validateSharedWorkerControl(control, report)
	assert.throws(() =>
		validateSharedWorkerControl(
			{ ...control, mailbox: [...control.mailbox, { ...event, eventId: "replayed-result" }] },
			report,
		),
	)
	assert.throws(() =>
		validateSharedWorkerControl(
			{ ...control, mailbox: [control.mailbox[0], { ...event, acknowledgedAt: undefined }] },
			report,
		),
	)
	assert.throws(() =>
		validateSharedWorkerControl(
			{ ...control, tombstones: [{ ...control.tombstones[0], parentTaskId: "wrong" }, control.tombstones[1]] },
			report,
		),
	)
})
