import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import {
	assertStorageRestartQuiescence,
	measureTaskHistoryMirror,
	parseTaskHistoryMirrorReceipt,
	readStorageRestartPhaseReceipt,
	STORAGE_RESTART_RECEIPT,
	TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
	type StorageRestartPhaseReceipt,
	type StorageRestartRunProof,
} from "./storageRestart"

let root: string
let proof: StorageRestartRunProof
let receipt: StorageRestartPhaseReceipt

test("mirror samples retain a peak between the before and after boundaries", () => {
	const observation = (bytes: number) => ({ bytes, items: 1, withinBudget: true })
	const mirror = {
		key: "taskHistory",
		budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
		before: observation(2),
		after: observation(30),
		samples: [observation(100), observation(30)],
		maxBytes: 100,
		withinBudget: true,
	}
	assert.equal(parseTaskHistoryMirrorReceipt(mirror).maxBytes, 100)
	assert.throws(() => parseTaskHistoryMirrorReceipt({ ...mirror, maxBytes: 30 }))
	assert.throws(() =>
		parseTaskHistoryMirrorReceipt({
			...mirror,
			samples: [observation(TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES + 1)],
		}),
	)
})

test("keeps the host probe budget aligned with the production compatibility contract", async () => {
	const source = await fs.readFile(
		path.resolve(__dirname, "../../../../src/core/task-persistence/compactTaskHistoryForGlobalState.ts"),
		"utf8",
	)
	assert.match(source, /export const TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES = 192 \* 1024\b/)
	assert.equal(TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES, 192 * 1024)
})

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-restart-proof-")))
	const artifactsDir = path.join(root, "artifacts")
	const storagePath = path.join(root, "storage")
	await fs.mkdir(artifactsDir)
	await fs.mkdir(storagePath)
	proof = {
		runId: "run-fault",
		artifactsDir,
		execution: "extension-host",
		hostExitObserved: true,
		ownershipGate: "verified",
		actualVSCodeVersion: "1.122.1",
		launchedHostPid: 101,
		extensionHostPid: 102,
		extensionHostParentPid: 103,
		evidenceManifestPath: path.join(artifactsDir, "manifest.json"),
		captureComplete: true,
	}
	receipt = {
		schemaVersion: 1,
		scenarioId: "storage-restart",
		phase: "fault",
		runId: proof.runId,
		hostVersion: "1.122.1",
		extensionHostPid: 102,
		storagePath,
		taskId: "task-failed",
		providerRequests: 0,
		terminalCount: 1,
		status: "failed",
		code: "ELOCKOWNER",
	}
	await fs.writeFile(path.join(artifactsDir, STORAGE_RESTART_RECEIPT), JSON.stringify(receipt))
	await fs.writeFile(
		proof.evidenceManifestPath!,
		JSON.stringify({
			kind: "alpha-vscode-e2e-run-evidence",
			version: 1,
			finalized: true,
			runId: proof.runId,
			captureComplete: true,
			bundleSha256: "a".repeat(64),
			metadata: {
				hostVersion: "1.122.1",
				scenarioId: "storage-restart",
				provider: "scripted",
				taskIds: [receipt.taskId],
			},
		}),
	)
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

const expected = () => ({
	runId: proof.runId,
	hostVersion: "1.122.1",
	phase: "fault" as const,
	storagePath: receipt.storagePath,
})

test("matches durable phase identity and probes every known relevant process", async () => {
	const parsed = await readStorageRestartPhaseReceipt(proof.artifactsDir, expected())
	assert.deepEqual(parsed, receipt)
	const probed: number[] = []
	const hosts = await assertStorageRestartQuiescence(proof, parsed, (pid) => {
		probed.push(pid)
		return false
	})
	assert.deepEqual(probed, [101, 102, 103])
	assert.deepEqual(
		hosts,
		probed.map((pid) => ({ pid })),
	)
})

test("measures only the serialized taskHistory mirror and preserves a bounded receipt", async () => {
	const taskHistory = [
		{ id: "root", title: "café" },
		{ id: "child", title: "child" },
	]
	const parsed = measureTaskHistoryMirror({
		get<T>(key: string) {
			assert.equal(key, "taskHistory")
			return taskHistory as T
		},
	})
	assert.deepEqual(parsed, {
		bytes: Buffer.byteLength(JSON.stringify(taskHistory), "utf8"),
		items: 2,
		withinBudget: true,
	})
	const mirrorReceipt = {
		key: "taskHistory" as const,
		budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
		before: parsed,
		after: { ...parsed, items: 3 },
		maxBytes: parsed.bytes,
		withinBudget: true as const,
	}
	await fs.writeFile(
		path.join(proof.artifactsDir, STORAGE_RESTART_RECEIPT),
		JSON.stringify({ ...receipt, taskHistoryMirror: mirrorReceipt }),
	)
	const withMirror = await readStorageRestartPhaseReceipt(proof.artifactsDir, expected())
	assert.deepEqual(withMirror.taskHistoryMirror, mirrorReceipt)
})

test("fails closed when taskHistory is not the production mirror shape", () => {
	assert.throws(() =>
		measureTaskHistoryMirror({
			get<T>() {
				return { prompt: "private" } as T
			},
		}),
	)
})

test("rejects over-budget or forged taskHistory mirror facts", async () => {
	const valid = {
		key: "taskHistory" as const,
		budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
		before: { bytes: 2, items: 0, withinBudget: true },
		after: { bytes: 2, items: 0, withinBudget: true },
		maxBytes: 2,
		withinBudget: true as const,
	}
	for (const taskHistoryMirror of [
		{ ...valid, budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES + 1 },
		{ ...valid, after: { bytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES + 1, items: 1, withinBudget: false } },
		{ ...valid, withinBudget: false },
		{ ...valid, maxBytes: 3 },
		{ ...valid, maxBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES + 1 },
	]) {
		await fs.writeFile(
			path.join(proof.artifactsDir, STORAGE_RESTART_RECEIPT),
			JSON.stringify({ ...receipt, taskHistoryMirror }),
		)
		await assert.rejects(readStorageRestartPhaseReceipt(proof.artifactsDir, expected()))
	}
})

test("rejects missing identity, test seams, version mismatch, and unobserved close before probing", async () => {
	for (const mutation of [
		{ execution: "test-seam" as const },
		{ hostExitObserved: false },
		{ ownershipGate: undefined },
		{ extensionHostPid: undefined },
		{ launchedHostPid: undefined },
		{ extensionHostParentPid: undefined },
		{ actualVSCodeVersion: "1.136.1" },
		{ runId: "another-run" },
		{ captureComplete: false },
	]) {
		await assert.rejects(
			assertStorageRestartQuiescence({ ...proof, ...mutation }, receipt, () => {
				assert.fail("Unverified run cannot reach process proof")
			}),
		)
	}
})

test("rejects every live, unknown, or failed process probe without changing sources", async () => {
	for (const candidate of [101, 102, 103]) {
		for (const result of [true, undefined]) {
			await assert.rejects(
				assertStorageRestartQuiescence(proof, receipt, (pid) => (pid === candidate ? result : false)),
			)
		}
	}
	await assert.rejects(
		assertStorageRestartQuiescence(proof, receipt, () => {
			throw new Error("unavailable")
		}),
	)
	assert.ok(await fs.stat(receipt.storagePath))
	assert.ok(await fs.stat(proof.evidenceManifestPath!))
})

test("rejects forged phase facts and strips unexpected private fields", async () => {
	for (const mutation of [
		{ providerRequests: 1 },
		{ terminalCount: 2 },
		{ status: "completed" },
		{ phase: "healthy" },
		{ taskId: "../escape" },
		{ runId: "other" },
		{ storagePath: root },
		{ extensionHostPid: 0 },
	]) {
		await fs.writeFile(
			path.join(proof.artifactsDir, STORAGE_RESTART_RECEIPT),
			JSON.stringify({ ...receipt, ...mutation }),
		)
		await assert.rejects(readStorageRestartPhaseReceipt(proof.artifactsDir, expected()))
	}
	await fs.writeFile(
		path.join(proof.artifactsDir, STORAGE_RESTART_RECEIPT),
		JSON.stringify({ ...receipt, apiKey: "private" }),
	)
	assert.deepEqual(await readStorageRestartPhaseReceipt(proof.artifactsDir, expected()), receipt)
})

test("refuses incomplete or unrelated final capture manifests", async () => {
	const original = JSON.parse(await fs.readFile(proof.evidenceManifestPath!, "utf8"))
	for (const mutation of [
		{ captureComplete: false },
		{ finalized: false },
		{ runId: "other" },
		{ bundleSha256: undefined },
		{ metadata: { ...original.metadata, taskIds: [] } },
		{ metadata: { ...original.metadata, provider: "live-copilot" } },
	]) {
		await fs.writeFile(proof.evidenceManifestPath!, JSON.stringify({ ...original, ...mutation }))
		await assert.rejects(
			assertStorageRestartQuiescence(proof, receipt, () => {
				assert.fail("Incomplete evidence must block")
			}),
		)
	}
})
