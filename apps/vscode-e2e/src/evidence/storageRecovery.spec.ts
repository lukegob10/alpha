import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
	AGENT_CONTROL_TRANSACTION_LOCK,
	OFFLINE_QUARANTINE_SUFFIX,
	RECOVERY_FIXTURE_MARKER,
	StorageRecoverySafetyError,
	initializeRecoveryFixture,
	quarantineOfflineAgentControlLock,
	type OfflineAgentControlLockRecoveryOutcome,
	type RecoveryFixture,
	type RecoveryRegistrySeal,
} from "./storageRecovery"

interface TestFixture {
	tempRoot: string
	fixture: RecoveryFixture
	storagePath: string
}

const deadProcess = (): false => false
const liveProcess = (): true => true
const unknownProcess = (): undefined => undefined

async function createTestFixture(): Promise<TestFixture> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nor42-storage-"))
	const fixture = await initializeRecoveryFixture(path.join(tempRoot, "fixture"))
	const storagePath = path.join(fixture.fixtureRoot, "storage")
	await fs.mkdir(storagePath)
	return { tempRoot, fixture, storagePath }
}

async function cleanupTestFixture(fixture: TestFixture): Promise<void> {
	fixture.fixture.controller.dispose()
	await fs.rm(fixture.tempRoot, { recursive: true, force: true })
}

async function writeStorageEvidence(storagePath: string): Promise<{
	agentControlPath: string
	historyPath: string
	leasePath: string
	unrelatedPath: string
}> {
	const agentControlPath = path.join(storagePath, "agent_control.json")
	const historyPath = path.join(storagePath, "task-history", "task-1.json")
	const leasePath = path.join(storagePath, "agent_control.json.owners", "other-owner.json")
	const unrelatedPath = path.join(storagePath, "unrelated.txt")
	await fs.mkdir(path.dirname(historyPath), { recursive: true })
	await fs.mkdir(path.dirname(leasePath), { recursive: true })
	await fs.writeFile(agentControlPath, '{"version":2,"agents":[]}\n')
	await fs.writeFile(historyPath, '{"task":"retain"}\n')
	await fs.writeFile(leasePath, '{"token":"other"}\n')
	await fs.writeFile(unrelatedPath, "retain this sibling\n")
	return { agentControlPath, historyPath, leasePath, unrelatedPath }
}

async function createLock(storagePath: string, ownerMetadata: string | Buffer): Promise<string> {
	const lockPath = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
	await fs.mkdir(lockPath)
	await fs.writeFile(path.join(lockPath, "owner.json"), ownerMetadata)
	await fs.writeFile(path.join(lockPath, "retained-payload.txt"), "retained lock payload\n")
	return lockPath
}

function sealFixture(fixture: RecoveryFixture): RecoveryRegistrySeal {
	return fixture.controller.sealForOfflineRecovery()
}

function recoveryOptions(
	fixture: TestFixture,
	registrySeal: RecoveryRegistrySeal,
	overrides: Partial<Parameters<typeof quarantineOfflineAgentControlLock>[0]> = {},
): Parameters<typeof quarantineOfflineAgentControlLock>[0] {
	return {
		fixtureRoot: fixture.fixture.fixtureRoot,
		fixtureController: fixture.fixture.controller,
		storagePath: fixture.storagePath,
		hosts: [],
		registrySeal,
		isProcessLive: deadProcess,
		...overrides,
	}
}

async function assertLockStillPresent(lockPath: string): Promise<void> {
	const stat = await fs.lstat(lockPath)
	assert.equal(stat.isDirectory(), true)
	assert.equal((await fs.readFile(path.join(lockPath, "owner.json"))).length >= 0, true)
}

test("initializes only managed empty roots and exposes an exclusive lifecycle gate", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nor42-init-"))
	let controller: RecoveryFixture["controller"] | undefined
	try {
		const root = path.join(tempRoot, "fixture")
		const first = await initializeRecoveryFixture(root)
		controller = first.controller
		assert.equal(first.fixtureRoot, await fs.realpath(root))
		const second = await initializeRecoveryFixture(root)
		assert.equal(second.controller, first.controller)
		assert.equal((await fs.readdir(root)).length, 1)

		const host = first.controller.openHost(45_001)
		assert.throws(() => first.controller.openHost(45_002), /only one active campaign host/u)
		assert.throws(() => first.controller.sealForOfflineRecovery(), /not quiescent/u)
		host.close()
		const seal = first.controller.sealForOfflineRecovery()
		assert.equal(first.controller.sealForOfflineRecovery(), seal)
		assert.throws(() => first.controller.openHost(45_003), /already sealed/u)

		const nonEmptyRoot = path.join(tempRoot, "non-empty")
		await fs.mkdir(nonEmptyRoot)
		await fs.writeFile(path.join(nonEmptyRoot, "not-a-marker"), "user data")
		await assert.rejects(
			initializeRecoveryFixture(nonEmptyRoot),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /empty or new root/u.test(error.message),
		)
	} finally {
		controller?.dispose()
		await fs.rm(tempRoot, { recursive: true, force: true })
	}
})

test("does not adopt a marked root after controller restart and cannot repair it", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-nor42-abandoned-"))
	try {
		const root = path.join(tempRoot, "fixture")
		const storagePath = path.join(root, "storage")
		const lockPath = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.mkdir(lockPath, { recursive: true })
		await fs.writeFile(
			path.join(root, RECOVERY_FIXTURE_MARKER),
			'{"kind":"alpha-vscode-e2e-storage-recovery-fixture","version":1}\n',
		)
		await fs.writeFile(path.join(lockPath, "owner.json"), Buffer.alloc(0))

		await assert.rejects(
			initializeRecoveryFixture(root),
			(error: unknown) =>
				error instanceof StorageRecoverySafetyError &&
				/controller-restart recovery is unsupported/u.test(error.message),
		)
		await assert.rejects(
			quarantineOfflineAgentControlLock({
				fixtureRoot: root,
				fixtureController: {} as RecoveryFixture["controller"],
				storagePath,
				hosts: [],
				registrySeal: { token: "nor42-fixture-quiescence" } as RecoveryRegistrySeal,
				isProcessLive: deadProcess,
			}),
			(error: unknown) =>
				error instanceof StorageRecoverySafetyError &&
				/unforgeable fixture controller|not owned/u.test(error.message),
		)
		await assertLockStillPresent(lockPath)
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true })
	}
})

test("repairs empty owner metadata only with a controller seal and preserves all unrelated data", async () => {
	const fixture = await createTestFixture()
	try {
		const preserved = await writeStorageEvidence(fixture.storagePath)
		const lockPath = await createLock(fixture.storagePath, Buffer.alloc(0))
		await fs.utimes(lockPath, new Date(0), new Date(0))

		const forgedSeal = { token: "nor42-fixture-quiescence" } as RecoveryRegistrySeal
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, forgedSeal)),
			(error: unknown) =>
				error instanceof StorageRecoverySafetyError &&
				/not issued by this fixture controller/u.test(error.message),
		)
		await assertLockStillPresent(lockPath)

		const firstSeal = sealFixture(fixture.fixture)
		const outcome = await quarantineOfflineAgentControlLock(
			recoveryOptions(fixture, firstSeal, {
				hosts: [{ pid: 45_011, exited: true }],
			}),
		)
		assert.equal(outcome.outcome, "quarantined")
		assert.equal("quarantinePath" in outcome, true)
		const quarantinePath = (outcome as Extract<OfflineAgentControlLockRecoveryOutcome, { outcome: "quarantined" }>)
			.quarantinePath
		assert.deepEqual(await fs.readFile(path.join(quarantinePath, "owner.json")), Buffer.alloc(0))
		assert.equal(
			await fs.readFile(path.join(quarantinePath, "retained-payload.txt"), "utf8"),
			"retained lock payload\n",
		)
		await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" })
		assert.equal(await fs.readFile(preserved.agentControlPath, "utf8"), '{"version":2,"agents":[]}\n')
		assert.equal(await fs.readFile(preserved.historyPath, "utf8"), '{"task":"retain"}\n')
		assert.equal(await fs.readFile(preserved.leasePath, "utf8"), '{"token":"other"}\n')
		assert.equal(await fs.readFile(preserved.unrelatedPath, "utf8"), "retain this sibling\n")

		const beforeRetry = (await fs.readdir(fixture.storagePath)).sort()
		const retry = await quarantineOfflineAgentControlLock(
			recoveryOptions(fixture, firstSeal, {
				hosts: [{ pid: 45_011, exited: true }],
			}),
		)
		assert.deepEqual(retry, { outcome: "already-absent", canonicalLockPath: lockPath })
		assert.deepEqual((await fs.readdir(fixture.storagePath)).sort(), beforeRetry)
		assert.deepEqual(await fs.readFile(path.join(quarantinePath, "owner.json")), Buffer.alloc(0))

		fixture.fixture.controller.resumeAfterOfflineRecovery(firstSeal)
		const nextHost = fixture.fixture.controller.openHost(45_012)
		nextHost.close()
		const nextSeal = fixture.fixture.controller.sealForOfflineRecovery()
		assert.notEqual(nextSeal, firstSeal)
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, firstSeal)),
			(error: unknown) =>
				error instanceof StorageRecoverySafetyError &&
				/not issued by this fixture controller/u.test(error.message),
		)
		assert.deepEqual(await quarantineOfflineAgentControlLock(recoveryOptions(fixture, nextSeal)), {
			outcome: "already-absent",
			canonicalLockPath: lockPath,
		})
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("accepts an old valid dead owner only after liveness proof, never from exited alone", async () => {
	const fixture = await createTestFixture()
	try {
		const lockPath = await createLock(fixture.storagePath, '{"token":"old-dead-owner","pid":45021}\n')
		await fs.utimes(lockPath, new Date(0), new Date(0))
		const host = fixture.fixture.controller.openHost(45_021)
		host.close()
		const seal = sealFixture(fixture.fixture)
		const observedPids: number[] = []
		const outcome = await quarantineOfflineAgentControlLock(
			recoveryOptions(fixture, seal, {
				hosts: [{ pid: 45_021, exited: true }],
				isProcessLive: (pid) => {
					observedPids.push(pid)
					return false
				},
			}),
		)
		assert.equal(outcome.outcome, "quarantined")
		assert.deepEqual(observedPids, [45_021])

		const liveFixture = await createTestFixture()
		try {
			const liveLock = await createLock(liveFixture.storagePath, '{"token":"claimed","pid":45022}\n')
			const liveOutcome = liveFixture.fixture.controller.sealForOfflineRecovery()
			await assert.rejects(
				quarantineOfflineAgentControlLock(
					recoveryOptions(liveFixture, liveOutcome, {
						hosts: [{ pid: 45_022, exited: true }],
						isProcessLive: liveProcess,
					}),
				),
				(error: unknown) => error instanceof StorageRecoverySafetyError && /still live/u.test(error.message),
			)
			await assertLockStillPresent(liveLock)
		} finally {
			await cleanupTestFixture(liveFixture)
		}
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("rejects unknown-owner locks when any campaign host is live or unknown", async () => {
	const fixture = await createTestFixture()
	try {
		const lockPath = await createLock(fixture.storagePath, Buffer.alloc(0))
		const seal = sealFixture(fixture.fixture)
		await assert.rejects(
			quarantineOfflineAgentControlLock(
				recoveryOptions(fixture, seal, {
					hosts: [{ pid: 45_031, exited: true }],
					isProcessLive: unknownProcess,
				}),
			),
			(error: unknown) =>
				error instanceof StorageRecoverySafetyError && /liveness is unknown/u.test(error.message),
		)
		await assertLockStillPresent(lockPath)

		await assert.rejects(
			quarantineOfflineAgentControlLock(
				recoveryOptions(fixture, seal, {
					hosts: [{ pid: 45_031, exited: true }],
					isProcessLive: liveProcess,
				}),
			),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /still live/u.test(error.message),
		)
		await assertLockStillPresent(lockPath)
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("rejects traversal and outside-root paths without touching the canonical lock", async () => {
	const fixture = await createTestFixture()
	try {
		const lockPath = await createLock(fixture.storagePath, Buffer.alloc(0))
		const seal = sealFixture(fixture.fixture)
		const traversalPath = `${fixture.fixture.fixtureRoot}${path.sep}..${path.sep}${path.basename(fixture.fixture.fixtureRoot)}${path.sep}storage`
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, seal, { storagePath: traversalPath })),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /traversal/u.test(error.message),
		)

		const outsideRoot = path.join(path.dirname(fixture.fixture.fixtureRoot), "fixture-outside")
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, seal, { storagePath: outsideRoot })),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /strict descendant/u.test(error.message),
		)
		await assertLockStillPresent(lockPath)
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("rejects symlinked storage and lock paths", async (t) => {
	const fixture = await createTestFixture()
	try {
		const outside = path.join(fixture.tempRoot, "outside")
		await fs.mkdir(outside)
		const linkedStorage = path.join(fixture.fixture.fixtureRoot, "linked-storage")
		try {
			await fs.symlink(outside, linkedStorage, "junction")
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
				t.skip("the test host does not permit symlink creation")
				return
			}
			throw error
		}
		const seal = sealFixture(fixture.fixture)
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, seal, { storagePath: linkedStorage })),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /symbolic link/u.test(error.message),
		)

		await fs.unlink(linkedStorage)
		const outsideLock = path.join(outside, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.mkdir(outsideLock)
		await fs.writeFile(path.join(outsideLock, "owner.json"), Buffer.alloc(0))
		const canonicalLock = path.join(fixture.storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.symlink(outsideLock, canonicalLock, "junction")
		await assert.rejects(
			quarantineOfflineAgentControlLock(recoveryOptions(fixture, seal)),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /symbolic link/u.test(error.message),
		)
		assert.deepEqual(await fs.readFile(path.join(outsideLock, "owner.json")), Buffer.alloc(0))
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("returns already-absent without creating quarantine or deleting unrelated storage", async () => {
	const fixture = await createTestFixture()
	try {
		const preserved = await writeStorageEvidence(fixture.storagePath)
		const seal = sealFixture(fixture.fixture)
		const outcome = await quarantineOfflineAgentControlLock(recoveryOptions(fixture, seal))
		const canonicalLockPath = path.join(fixture.storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
		assert.deepEqual(outcome, { outcome: "already-absent", canonicalLockPath })
		await assert.rejects(fs.lstat(`${canonicalLockPath}${OFFLINE_QUARANTINE_SUFFIX}`), { code: "ENOENT" })
		assert.equal(await fs.readFile(preserved.agentControlPath, "utf8"), '{"version":2,"agents":[]}\n')
		assert.equal(await fs.readFile(preserved.historyPath, "utf8"), '{"task":"retain"}\n')
		assert.equal(await fs.readFile(preserved.leasePath, "utf8"), '{"token":"other"}\n')
		assert.equal(await fs.readFile(preserved.unrelatedPath, "utf8"), "retain this sibling\n")
	} finally {
		await cleanupTestFixture(fixture)
	}
})

test("does not mark a missing lock verified while a retained closed-host PID is live", async () => {
	const fixture = await createTestFixture()
	try {
		const host = fixture.fixture.controller.openHost(45_041)
		host.close()
		const seal = sealFixture(fixture.fixture)
		await assert.rejects(
			quarantineOfflineAgentControlLock(
				recoveryOptions(fixture, seal, {
					isProcessLive: liveProcess,
				}),
			),
			(error: unknown) => error instanceof StorageRecoverySafetyError && /still live/u.test(error.message),
		)
		assert.throws(() => fixture.fixture.controller.resumeAfterOfflineRecovery(seal), /has not been verified/u)
	} finally {
		await cleanupTestFixture(fixture)
	}
})
