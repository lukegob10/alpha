import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import {
	assertStorageRestartQuiescence,
	readStorageRestartPhaseReceipt,
	STORAGE_RESTART_RECEIPT,
	type StorageRestartPhaseReceipt,
	type StorageRestartRunProof,
} from "./storageRestart"

let root: string
let proof: StorageRestartRunProof
let receipt: StorageRestartPhaseReceipt

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
