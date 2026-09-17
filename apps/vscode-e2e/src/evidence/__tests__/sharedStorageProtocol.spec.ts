import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { HOST_VERSIONS, type HostVersion } from "../../campaign/types"
import {
	failureCode,
	publish,
	readOptional,
	validateDone,
	validateIdentities,
	validateIdentity,
	validateManifest,
	validateTaskIdentity,
	waitUntil,
	type PairManifest,
	type Role,
} from "../sharedStorageProtocol"

const root = path.resolve(os.tmpdir(), "alpha-shared-storage")
const manifest: PairManifest = {
	runId: "sample",
	nonce: "nonce-123",
	controllerPid: 1,
	profileRoot: path.join(root, "profile"),
	artifactsRoot: path.join(root, "artifacts"),
	deadline: 1000,
	hostVersion: HOST_VERSIONS[0],
	roles: {
		a: { workspace: path.join(root, "a"), workspaceFile: path.join(root, "a.code-workspace") },
		b: { workspace: path.join(root, "b"), workspaceFile: path.join(root, "b.code-workspace") },
	},
}
const identity = (role: Role) => ({
	runId: manifest.runId,
	nonce: manifest.nonce,
	role,
	pid: role === "a" ? 20 : 21,
	hostVersion: manifest.hostVersion as HostVersion,
	workspaceFile: manifest.roles[role].workspaceFile,
	storagePath: path.join(manifest.profileRoot, "storage"),
	persistenceFile: path.join(manifest.profileRoot, "storage", "agent_control.json"),
})

test("failure diagnostics use only closed codes", () => {
	for (const code of ["runtime_closed", "host_failed", "controller_timeout", "bundle_changed"]) {
		assert.equal(failureCode(new Error(code)), code)
	}
	assert.equal(failureCode(new Error("sensitive arbitrary detail")), "operation_failed")
})

test("validates complete manifests and distinct role paths", () => {
	assert.deepEqual(validateManifest(manifest), manifest)
	const invalid = (change: (value: Record<string, unknown>) => void) => {
		const value = structuredClone(manifest) as unknown as Record<string, unknown>
		change(value)
		assert.throws(() => validateManifest(value))
	}
	for (const change of [
		(value: Record<string, unknown>) => (value.hostVersion = "1.0"),
		(value: Record<string, unknown>) => (value.runId = "../escape"),
		(value: Record<string, unknown>) => (value.nonce = "x".repeat(129)),
		(value: Record<string, unknown>) => (value.controllerPid = 0),
		(value: Record<string, unknown>) => (value.deadline = Infinity),
		(value: Record<string, unknown>) => (value.profileRoot = `${manifest.profileRoot}\0`),
		(value: Record<string, unknown>) =>
			(value.roles = { a: manifest.roles.a, b: { ...manifest.roles.b, workspace: manifest.roles.a.workspace } }),
		(value: Record<string, unknown>) =>
			(value.roles = { a: manifest.roles.a, b: { ...manifest.roles.b, workspaceFile: "b.txt" } }),
	])
		invalid(change)
})

test("validates independent identity, task, and done fields", () => {
	assert.equal(validateIdentities([identity("a"), identity("b")], manifest).length, 2)
	for (const change of [
		(value: ReturnType<typeof identity>) => (value.hostVersion = "1.136.1" as HostVersion),
		(value: ReturnType<typeof identity>) => (value.nonce = "stale"),
		(value: ReturnType<typeof identity>) => (value.pid = 1),
		(value: ReturnType<typeof identity>) => (value.storagePath = path.join(manifest.profileRoot, "other")),
		(value: ReturnType<typeof identity>) => (value.role = "b"),
	]) {
		const value = identity("a")
		change(value)
		assert.throws(() => validateIdentity(value, manifest, "a"))
	}
	const task = { ...identity("a"), taskId: "task-1", requests: 1, terminalCount: 1 }
	assert.equal(validateTaskIdentity(task, manifest, "a").taskId, "task-1")
	assert.throws(() => validateTaskIdentity({ ...task, taskId: "../task" }, manifest, "a"))
	assert.throws(() => validateDone({ ...task, taskId: "task-2" }, manifest, "a", "task-1"))
	assert.throws(() => validateDone({ ...task, requests: 2 }, manifest, "a", "task-1"))
	assert.throws(() => validateDone({ ...task, terminalCount: 2 }, manifest, "a", "task-1"))
})

test("publishes immutable bounded receipts and cleans rejected candidates", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-pair-protocol-"))
	try {
		assert.equal(await readOptional(directory, "ready-a.json"), undefined)
		await publish(directory, "ready-a.json", { nonce: "first" })
		await assert.rejects(() => publish(directory, "ready-a.json", { nonce: "second" }))
		assert.deepEqual(await readOptional(directory, "ready-a.json"), { nonce: "first" })
		await assert.rejects(() => publish(directory, "../outside.json", {}))
		await assert.rejects(() => publish(directory, "large.json", "x".repeat(20_000)))
		assert.deepEqual(await fs.readdir(directory), ["ready-a.json"])
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})

test("checks the monotonic deadline after an async condition", async () => {
	let calls = 0
	await assert.rejects(
		waitUntil(
			async () => {
				calls++
				return true
			},
			1,
			"controller_timeout",
			() => (calls === 0 ? 0 : 1),
			0,
		),
	)
	assert.equal(calls, 1)
})
