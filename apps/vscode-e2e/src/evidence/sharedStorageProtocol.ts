import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { HOST_VERSIONS, type HostVersion } from "../campaign/types"
import { isWithin, readBounded, rejectSymlinkComponents } from "./paths"

export const ROLES = ["a", "b"] as const
export type Role = (typeof ROLES)[number]
const MAX_RECEIPT_BYTES = 16_384
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/

export function failureCode(error: unknown): string {
	if (error instanceof Error) {
		if (error.message === "Fake AI is not set") return "missing_scripted_fixture_id"
		if (error.message === "scripted_request_limit") return "scripted_request_limit"
		if (error.message === "unexpected_task_ask") return "unexpected_task_ask"
		if (["runtime_closed", "host_failed", "controller_timeout", "bundle_changed"].includes(error.message)) {
			return error.message
		}
	}
	if (error instanceof assert.AssertionError) return "assertion_failed"
	if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOCKOWNER") return "storage_owner_invalid"
	return "operation_failed"
}

export interface PairManifest {
	runId: string
	nonce: string
	controllerPid: number
	profileRoot: string
	artifactsRoot: string
	deadline: number
	hostVersion: HostVersion
	roles: Record<Role, { workspace: string; workspaceFile: string }>
}
export interface HostIdentity {
	runId: string
	nonce: string
	role: Role
	pid: number
	hostVersion: HostVersion
	workspaceFile: string
	storagePath: string
	persistenceFile: string
}
export interface HostDone extends HostIdentity {
	taskId: string
	requests: number
	terminalCount: number
}

function recordValue(value: unknown): Record<string, unknown> {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value))
	return value as Record<string, unknown>
}

export function record(value: unknown): Record<string, unknown> {
	return recordValue(value)
}

function safeToken(value: unknown, pattern = SAFE_TOKEN): string {
	assert.ok(typeof value === "string" && pattern.test(value))
	return value
}

function absoluteNormalizedPath(value: unknown): string {
	assert.ok(
		typeof value === "string" &&
			value.length > 0 &&
			!value.includes("\0") &&
			path.isAbsolute(value) &&
			path.normalize(value) === value &&
			path.resolve(value) === value,
	)
	return value
}

function hostVersion(value: unknown): HostVersion {
	assert.ok(HOST_VERSIONS.some((candidate) => candidate === value))
	return value as HostVersion
}

function positiveInteger(value: unknown): number {
	assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
	return value
}

function positiveFinite(value: unknown): number {
	assert.ok(typeof value === "number" && Number.isFinite(value) && value > 0)
	return value
}

function roleManifest(value: unknown): { workspace: string; workspaceFile: string } {
	const item = recordValue(value)
	const workspace = absoluteNormalizedPath(item.workspace)
	const workspaceFile = absoluteNormalizedPath(item.workspaceFile)
	assert.ok(workspaceFile.endsWith(".code-workspace"))
	return { workspace, workspaceFile }
}

export function validateManifest(value: unknown): PairManifest {
	const item = recordValue(value)
	const runId = safeToken(item.runId)
	const nonce = safeToken(item.nonce)
	const controllerPid = positiveInteger(item.controllerPid)
	const profileRoot = absoluteNormalizedPath(item.profileRoot)
	const artifactsRoot = absoluteNormalizedPath(item.artifactsRoot)
	const deadline = positiveFinite(item.deadline)
	const hostVersionValue = hostVersion(item.hostVersion)
	const roles = recordValue(item.roles)
	const validatedRoles = { a: roleManifest(roles.a), b: roleManifest(roles.b) }
	assert.notEqual(validatedRoles.a.workspace, validatedRoles.b.workspace)
	assert.notEqual(validatedRoles.a.workspaceFile, validatedRoles.b.workspaceFile)
	return {
		runId,
		nonce,
		controllerPid,
		profileRoot,
		artifactsRoot,
		deadline,
		hostVersion: hostVersionValue,
		roles: validatedRoles,
	}
}

async function unlinkCandidate(candidate: string): Promise<void> {
	try {
		await fs.unlink(candidate)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

/** Atomic no-replace publication prevents partial receipts from looking like barriers. */
export async function publish(directory: string, name: string, value: unknown): Promise<void> {
	assert.match(name, /^[a-z][a-z0-9-]*\.json$/)
	await rejectSymlinkComponents(directory)
	const serialized = JSON.stringify(value)
	assert.ok(serialized !== undefined && Buffer.byteLength(serialized) <= MAX_RECEIPT_BYTES)
	const destination = path.join(directory, name)
	const candidate = `${destination}.${randomUUID()}.candidate`
	let created = false
	try {
		const handle = await fs.open(candidate, "wx", 0o600)
		created = true
		try {
			await handle.writeFile(serialized)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.link(candidate, destination)
	} finally {
		if (created) await unlinkCandidate(candidate)
	}
}

export async function readOptional(directory: string, name: string): Promise<unknown | undefined> {
	assert.match(name, /^[a-z][a-z0-9-]*\.json$/)
	try {
		return JSON.parse((await readBounded(path.join(directory, name), MAX_RECEIPT_BYTES)).toString("utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

export function requireNonce(value: unknown, manifest: PairManifest): Record<string, unknown> {
	const item = recordValue(value)
	assert.equal(item.runId, manifest.runId)
	assert.equal(item.nonce, manifest.nonce)
	return item
}

export function validateIdentity(value: unknown, manifest: PairManifest, role: Role): HostIdentity {
	assert.ok(ROLES.includes(role))
	const item = requireNonce(value, manifest)
	const expected = manifest.roles[role]
	assert.equal(item.role, role)
	const pid = positiveInteger(item.pid)
	assert.notEqual(pid, manifest.controllerPid)
	const itemHostVersion = hostVersion(item.hostVersion)
	assert.equal(itemHostVersion, manifest.hostVersion)
	const workspaceFile = absoluteNormalizedPath(item.workspaceFile)
	assert.equal(workspaceFile, expected.workspaceFile)
	const storagePath = absoluteNormalizedPath(item.storagePath)
	assert.ok(storagePath !== manifest.profileRoot && isWithin(manifest.profileRoot, storagePath))
	const persistenceFile = absoluteNormalizedPath(item.persistenceFile)
	assert.equal(persistenceFile, path.join(storagePath, "agent_control.json"))
	return {
		runId: manifest.runId,
		nonce: manifest.nonce,
		role,
		pid,
		hostVersion: manifest.hostVersion,
		workspaceFile,
		storagePath,
		persistenceFile,
	}
}

export function validateTaskIdentity(
	value: unknown,
	manifest: PairManifest,
	role: Role,
): HostIdentity & { taskId: string } {
	const identity = validateIdentity(value, manifest, role)
	const taskId = safeToken(requireNonce(value, manifest).taskId, SAFE_TASK_ID)
	return { ...identity, taskId }
}

export function validateDone(value: unknown, manifest: PairManifest, role: Role, taskId: string): HostDone {
	const expectedTaskId = safeToken(taskId, SAFE_TASK_ID)
	const identity = validateTaskIdentity(value, manifest, role)
	const item = requireNonce(value, manifest)
	assert.equal(identity.taskId, expectedTaskId)
	assert.equal(item.requests, 1)
	assert.equal(item.terminalCount, 1)
	return { ...identity, requests: 1, terminalCount: 1 }
}

export function validateIdentities(values: unknown[], manifest: PairManifest): HostIdentity[] {
	assert.ok(Array.isArray(values))
	assert.equal(values.length, 2)
	const identities = ROLES.map((role, index) => validateIdentity(values[index], manifest, role))
	const [first, second] = identities
	assert.ok(first && second)
	assert.notEqual(first.pid, second.pid)
	assert.equal(first.storagePath, second.storagePath)
	assert.equal(first.persistenceFile, second.persistenceFile)
	return identities
}

export async function waitUntil(
	condition: () => Promise<boolean>,
	deadline: number,
	code: string,
	now: () => number = Date.now,
	intervalMs = 50,
): Promise<void> {
	while (true) {
		if (now() >= deadline) throw new Error(code)
		const satisfied = await condition()
		if (now() >= deadline) throw new Error(code)
		if (satisfied) return
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
	}
}
