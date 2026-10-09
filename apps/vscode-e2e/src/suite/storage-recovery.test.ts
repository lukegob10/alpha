import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"
import { AlphaCodeEventName } from "@alpha-code/types"

import { captureRunEvidence } from "../evidence/capture"
import { isWithin, readBounded, rejectSymlinkComponents } from "../evidence/paths"
import {
	AGENT_CONTROL_TRANSACTION_LOCK,
	initializeRecoveryFixture,
	quarantineOfflineAgentControlLock,
	RECOVERY_FIXTURE_MARKER,
} from "../evidence/storageRecovery"
import { waitFor } from "./utils"

class RecoveryAI {
	readonly id = "storage-recovery-scripted"
	requests = 0
	async *createMessage() {
		this.requests++
		assert.equal(this.requests, 1)
		yield { type: "text" as const, text: "Task storage recovered successfully." }
		yield { type: "usage" as const, inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}
	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt(): Promise<string> {
		return ""
	}
}

interface BundledPersistence {
	filePath: string
	withTransaction<T>(operation: () => Promise<T>): Promise<T>
	read(): Promise<unknown>
	write(state: unknown): Promise<void>
	acquireOwnerLease(
		ownerId: string,
		options: { staleMs: number; updateMs: number; onCompromised: (error: Error) => void },
	): Promise<void>
	releaseOwnerLease(ownerId: string): Promise<void>
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

	test("automatically recovers an abandoned legacy lock in the exact extension host without changing retained history", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace && path.isAbsolute(workspace))
		const storage = await fs.mkdtemp(path.join(workspace, "storage-auto-recovery-"))
		const Persistence = bundledPersistenceConstructor()
		const persistence = new Persistence(storage, { transactionWaitTimeoutMs: 1_000 })
		const state = '{"retained":"agent state"}'
		await fs.writeFile(persistence.filePath, state)
		await fs.mkdir(path.join(storage, "tasks", "retained"), { recursive: true })
		const history = path.join(storage, "tasks", "retained", "history_item.json")
		await fs.writeFile(history, '{"id":"retained"}')
		const lock = path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.mkdir(lock)
		await fs.writeFile(path.join(lock, "owner.json"), "")
		const ownerId = randomUUID()
		await persistence.acquireOwnerLease(ownerId, {
			staleMs: 60_000,
			updateMs: 10_000,
			onCompromised: () => assert.fail("Activation lease lost"),
		})
		try {
			await persistence.withTransaction(async () => {
				assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).pid, process.pid)
				assert.equal(await fs.readFile(persistence.filePath, "utf8"), state)
			})
			assert.equal(await fs.readFile(history, "utf8"), '{"id":"retained"}')
			const quarantines = (await fs.readdir(storage)).filter((name) => name.includes(".quarantine."))
			assert.equal(quarantines.length, 1)
			assert.equal((await fs.stat(path.join(storage, quarantines[0]!, "owner.json"))).size, 0)
			await new Persistence(storage, { transactionWaitTimeoutMs: 1_000 }).withTransaction(async () => undefined)
		} finally {
			await persistence.releaseOwnerLease(ownerId)
		}
	})

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
			assert.ok((await fs.stat(path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK))).isFile())
		} finally {
			release()
			await transaction
			fixture.controller.dispose()
		}
		await assert.rejects(fs.stat(path.join(storage, AGENT_CONTROL_TRANSACTION_LOCK)), { code: "ENOENT" })
	})

	test("reaches the model and completes through the real task API after an interrupted legacy publication", async function () {
		this.timeout(120_000)
		const api = globalThis.api
		const provider = (
			api as unknown as {
				sidebarProvider: {
					agentControlStore: { persistence: BundledPersistence; initialize(): Promise<void> }
					getAgentLifecycleSnapshot(id: string): { status: string } | undefined
					getLiveTask(
						id: string,
					):
						| { taskAsk?: { ask?: string }; approveAsk(): void; waitForTermination(): Promise<void> }
						| undefined
				}
			}
		).sidebarProvider
		await provider.agentControlStore.initialize()
		const persistence = provider.agentControlStore.persistence
		const profile = process.env.ALPHA_E2E_PROFILE_DIR
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace && path.isAbsolute(workspace))
		// The default runner owns sibling workspace/user-data directories in one
		// temporary root; persistent campaigns instead provide an explicit profile.
		const fixtureRoot = profile ?? path.dirname(workspace)
		await rejectSymlinkComponents(fixtureRoot)
		assert.ok(isWithin(await fs.realpath(fixtureRoot), await fs.realpath(path.dirname(persistence.filePath))))
		const lock = `${persistence.filePath}.transaction.lock`
		// Inject the interrupted old format while holding the real OS guard, so
		// no background transaction can race the fixture publication.
		await assert.rejects(
			persistence.withTransaction(async () => {
				await fs.unlink(lock)
				await fs.mkdir(lock)
				await fs.writeFile(path.join(lock, "owner.json"), "")
				throw new Error("Injected legacy publication interruption")
			}),
			/Injected legacy publication interruption/,
		)
		const model = new RecoveryAI()
		const completed = new Set<string>()
		const onCompleted = (id: string) => completed.add(id)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const taskId = await api.startNewTask({
				configuration: {
					...api.getConfiguration(),
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "code",
					autoApprovalEnabled: true,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
					enableCheckpoints: false,
				},
				text: "Reply with one short acknowledgement. Do not use tools or commands.",
			})
			let approved = false
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (!approved && task?.taskAsk?.ask === "completion_result") {
						approved = true
						task.approveAsk()
					}
					return completed.has(taskId) && provider.getAgentLifecycleSnapshot(taskId)?.status === "completed"
				},
				{ timeout: 90_000, description: "model completion after automatic lock recovery" },
			)
			await provider.getLiveTask(taskId)?.waitForTermination()
			assert.equal(model.requests, 1)
			assert.ok(await api.isTaskInHistory(taskId))
			const history = JSON.parse(
				(
					await readBounded(
						path.join(path.dirname(persistence.filePath), "tasks", taskId, "api_conversation_history.json"),
						256 * 1_024,
					)
				).toString("utf8"),
			)
			assert.ok(Array.isArray(history) && history.length > 0)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
		}
	})
})
