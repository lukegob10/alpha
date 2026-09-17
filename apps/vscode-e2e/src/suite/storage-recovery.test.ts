import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"

import { captureRunEvidence } from "../evidence/capture"
import { isWithin, readBounded, rejectSymlinkComponents } from "../evidence/paths"
import {
	AGENT_CONTROL_TRANSACTION_LOCK,
	initializeRecoveryFixture,
	quarantineOfflineAgentControlLock,
	RECOVERY_FIXTURE_MARKER,
} from "../evidence/storageRecovery"

interface BundledPersistence {
	filePath: string
	withTransaction<T>(operation: () => Promise<T>): Promise<T>
	read(): Promise<unknown>
	write(state: unknown): Promise<void>
}
type PersistenceConstructor = new (storage: string, options: { transactionWaitTimeoutMs: number }) => BundledPersistence

function bundledPersistenceConstructor(): PersistenceConstructor {
	// Exercise the production class already bundled into the extension, not a second test lock implementation.
	const provider = (
		globalThis.api as unknown as {
			sidebarProvider?: { agentControlStore?: { persistence?: { constructor?: unknown } } }
		}
	).sidebarProvider
	const constructor = provider?.agentControlStore?.persistence?.constructor
	assert.equal(
		typeof constructor,
		"function",
		"The activated extension must expose its bundled persistence to this host test",
	)
	return constructor as PersistenceConstructor
}

suite("Agent-control failure evidence and isolated offline recovery", function () {
	this.timeout(30_000)

	test("retains empty ownership evidence across fresh persistence instances, then repairs only the offline fixture lock", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace && path.isAbsolute(workspace), "An isolated extension-host workspace is required")
		await rejectSymlinkComponents(workspace)
		const root = await fs.realpath(await fs.mkdtemp(path.join(workspace, "storage-recovery-")))
		const fixture = await initializeRecoveryFixture(root)
		const storage = path.join(root, "storage")
		await fs.mkdir(path.join(storage, "tasks", "retained-task"), { recursive: true })
		const state = {
			version: 2,
			updatedAt: 1,
			nextSequence: 1,
			agents: [],
			tombstones: [],
			mailbox: [],
			mailboxCursors: {},
			verificationObligations: [],
		}
		const stateBytes = JSON.stringify(state)
		await fs.writeFile(path.join(storage, "agent_control.json"), stateBytes)
		await fs.writeFile(path.join(storage, "tasks", "retained-task", "history_item.json"), '{"id":"retained-task"}')
		const lock = path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.mkdir(lock)
		await fs.writeFile(path.join(lock, "owner.json"), "")
		const Persistence = bundledPersistenceConstructor()
		let effects = 0
		for (let attempt = 0; attempt < 2; attempt++) {
			const persistence = new Persistence(storage, { transactionWaitTimeoutMs: 1_000 })
			await assert.rejects(
				persistence.withTransaction(async () => {
					effects++
					return "must not run"
				}),
				(error: unknown) => error instanceof Error && (error as { code?: string }).code === "ELOCKOWNER",
			)
			assert.equal((await fs.stat(path.join(lock, "owner.json"))).size, 0)
		}
		assert.equal(effects, 0)
		const evidence = await captureRunEvidence({
			artifactsRoot: path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR ?? workspace, "storage-recovery-evidence"),
			runId: `empty-lock-${randomUUID()}`,
			metadata: {
				scenarioId: "storage-empty-owner",
				hostVersion: vscode.version,
				provider: "scripted",
				taskIds: [],
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				outcome: "failed",
			},
			storagePath: storage,
			failure: { phase: "persistence", code: "ELOCKOWNER" },
			assertSourceOwned: async (candidate) => {
				assert.ok(isWithin(root, candidate) && candidate !== root)
				assert.ok((await readBounded(path.join(root, RECOVERY_FIXTURE_MARKER), 512)).length > 0)
			},
		})
		assert.equal(evidence.summary.code, "ELOCKOWNER")
		assert.ok(
			(await fs.readFile(path.join(evidence.artifactDirectory, "storage-lock.json"), "utf8")).includes(
				"empty-owner",
			),
		)
		// No host was launched against this fixture: both failed transactions have settled, and the gate forbids new launches.
		const registrySeal = fixture.controller.sealForOfflineRecovery()
		const repair = await quarantineOfflineAgentControlLock({
			fixtureRoot: root,
			storagePath: storage,
			hosts: [],
			fixtureController: fixture.controller,
			registrySeal,
		})
		assert.equal(repair.outcome, "quarantined")
		if (repair.outcome === "quarantined")
			assert.equal((await fs.stat(path.join(repair.quarantinePath, "owner.json"))).size, 0)
		assert.equal(await fs.readFile(path.join(storage, "agent_control.json"), "utf8"), stateBytes)
		assert.equal(
			await fs.readFile(path.join(storage, "tasks", "retained-task", "history_item.json"), "utf8"),
			'{"id":"retained-task"}',
		)
		fixture.controller.resumeAfterOfflineRecovery(registrySeal)
		const healthyRuntime = fixture.controller.openHost(process.pid)
		const restarted = new Persistence(storage, { transactionWaitTimeoutMs: 1_000 })
		try {
			await restarted.withTransaction(async () => {
				await restarted.write({ ...state, updatedAt: 2 })
				effects++
			})
		} finally {
			healthyRuntime.close()
			fixture.controller.dispose()
		}
		assert.equal(effects, 1)
		assert.equal(((await restarted.read()) as { updatedAt: number }).updatedAt, 2)
		assert.ok(await fs.stat(evidence.manifestPath), "Failure evidence must survive successful recovery")
	})

	test("never quarantines a live production transaction owner", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace && path.isAbsolute(workspace))
		const root = await fs.realpath(await fs.mkdtemp(path.join(workspace, "storage-live-owner-")))
		const fixture = await initializeRecoveryFixture(root)
		const storage = path.join(root, "storage")
		await fs.mkdir(storage)
		const Persistence = bundledPersistenceConstructor()
		const holder = new Persistence(storage, { transactionWaitTimeoutMs: 1_000 })
		let entered!: () => void
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve
		})
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const transaction = holder.withTransaction(async () => {
			entered()
			await barrier
		})
		await enteredPromise
		try {
			await assert.rejects(
				quarantineOfflineAgentControlLock({
					fixtureRoot: root,
					storagePath: storage,
					hosts: [],
					fixtureController: fixture.controller,
					registrySeal: fixture.controller.sealForOfflineRecovery(),
				}),
			)
			assert.ok(await fs.stat(path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK, "owner.json")))
		} finally {
			release()
			await transaction
			fixture.controller.dispose()
		}
		await assert.rejects(fs.stat(path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK)), { code: "ENOENT" })
	})
})
