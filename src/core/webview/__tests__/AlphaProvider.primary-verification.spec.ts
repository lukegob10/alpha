import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SubagentGroupState } from "@alpha-code/types"
import { managedSubagentWorktreeService, type ManagedWorkerArtifact } from "@alpha-code/core"

import {
	AgentControlStore,
	InMemoryAgentControlPersistence,
	type ParentCommandVerificationEvidence,
} from "../../agent/AgentControlStore"
import { captureVerificationContent } from "../../agent/VerificationScope"
import { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"

const VALID_COMMAND = "pnpm --dir src exec tsc --noEmit"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("AlphaProvider primary verification", () => {
	let workspace: string
	let outside: string
	let store: AgentControlStore
	let provider: AlphaProvider
	let parent: any
	let commandEvidence: ParentCommandVerificationEvidence[]
	let executionNumber: number
	let cancellation: AbortController

	beforeEach(async () => {
		workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-primary-verification-")))
		outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-primary-verification-outside-")))
		await fs.mkdir(path.join(workspace, "src"), { recursive: true })
		await fs.writeFile(path.join(workspace, "package.json"), '{"name":"verification-root","private":true}\n')
		await fs.writeFile(path.join(workspace, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n')
		await fs.writeFile(
			path.join(workspace, "src", "package.json"),
			'{"name":"verification-src","private":true,"scripts":{"check-types":"tsc --noEmit"}}\n',
		)
		await fs.writeFile(
			path.join(workspace, "src", "tsconfig.json"),
			'{"compilerOptions":{"strict":true},"include":["**/*.ts"]}\n',
		)
		await fs.writeFile(
			path.join(workspace, "src", "eslint.config.mjs"),
			'export default [{ "files": ["**/*.ts"], "rules": { "no-undef": "error" } }]\n',
		)
		await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const value = 1\n")

		store = new AgentControlStore(new InMemoryAgentControlPersistence())
		await store.initialize()
		const root = await store.ensureRoot({ taskId: "parent-1", objective: "Coordinate work", status: "running" })
		commandEvidence = []
		executionNumber = 0
		cancellation = new AbortController()
		parent = {
			taskId: "parent-1",
			taskKind: "primary",
			cwd: workspace,
			metadata: { task: "Coordinate work" },
			alphaMessages: [],
			abort: false,
			abandoned: false,
			getCommandExecutionEvidence: vi.fn(() => commandEvidence),
			getTaskLifetimeCancellationSignal: vi.fn(() => cancellation.signal),
		}
		provider = Object.assign(Object.create(AlphaProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			getAgentControlRootTaskId: vi.fn(() => parent.taskId),
			getLiveTask: vi.fn(() => parent),
			ensureAgentControlRoot: vi.fn(async () => root),
			synchronizeParentVerificationObligations: vi.fn(async () => undefined),
			publishParentVerificationTransition: vi.fn(async () => undefined),
			refreshParentVerificationProjections: vi.fn(async () => undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			publishTaskHistoryUpdate: vi.fn(async () => undefined),
		}) as AlphaProvider
		parent.providerRef = new WeakRef(provider)
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	})

	const primaryObligation = () => store.getVerificationObligations({ parentTaskId: parent.taskId })[0]!

	it.each(["explore", "review", "worker"] as const)("tracks shared %s mutations", async (role) => {
		const child = {
			taskId: "shared-child",
			taskKind: "subagent",
			subagentRole: role,
			cwd: workspace,
			subagentContextManifest: {
				parentTaskId: parent.taskId,
				runtimePolicy: { role, authorityModel: "parent", mutate: true, sharedWorkspace: true },
			},
			getTaskLifetimeCancellationSignal: () => new AbortController().signal,
		} as Task
		Reflect.set(provider, "subagentDescriptors", new Map([[child.taskId, { parent }]]))
		await store.createAgent({
			taskId: child.taskId,
			parentTaskId: parent.taskId,
			nickname: role,
			role,
			objective: "Correct the shared source",
			status: "running",
		})
		await provider.reservePrimaryMutation(child, "shared-edit")
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(false)
		await fs.writeFile(path.join(workspace, "src/a.ts"), "export const value = 2\n")
		await expect(
			provider.recordPrimaryMutation(
				child,
				await captureVerificationContent(workspace, ["src/a.ts"]),
				false,
				"shared-edit",
			),
		).resolves.toBe(true)
		expect(primaryObligation()).toMatchObject({ changedFiles: ["src/a.ts"], mutationReservations: [] })
		expect(store.getVerificationObligations({ parentTaskId: child.taskId })).toEqual([])
		expect(store.getAgent(child.taskId)?.snapshot?.metadata?.sharedWorkspaceChangedFiles).toEqual(["src/a.ts"])
	})

	it("propagates task cancellation to reservation admission without creating mutation debt", async () => {
		const cancellation = new AbortController()
		parent.getTaskLifetimeCancellationSignal.mockReturnValue(cancellation.signal)
		cancellation.abort()
		await expect(provider.reservePrimaryMutation(parent, "cancelled-command")).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(store.getVerificationObligations({ parentTaskId: parent.taskId })).toEqual([])
	})

	const recordPrimaryMutation = async () => {
		await provider.recordPrimaryMutation(parent, await captureVerificationContent(workspace, ["src/a.ts"]))
		return primaryObligation()
	}

	const captureVerification = async (command = VALID_COMMAND) => {
		const obligation = primaryObligation()
		return (await provider.captureCommandVerification(parent, command, workspace, [obligation.changeSetId]))!
	}

	const captureCurrentVerification = () => captureVerification()

	const recordAppliedWorker = async () => {
		await store.recordWorkerChangeSet({
			rootTaskId: parent.taskId,
			parentTaskId: parent.taskId,
			workerTaskId: "worker-1",
			workerNickname: "Worker",
			groupId: "worker-group",
			reviewSource: "apply",
			changeSet: {
				id: "worker-change",
				status: "applied",
				changedFiles: ["src/a.ts"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		})
	}

	const setCommandEvidence = (
		verificationVersions: NonNullable<ParentCommandVerificationEvidence["verificationVersions"]>,
		override: Partial<ParentCommandVerificationEvidence> = {},
	) => {
		const obligation = primaryObligation()
		const executionId = `execution-${++executionNumber}`
		commandEvidence = [
			{
				toolCallId: `verify-${executionNumber}`,
				executionId,
				status: "succeeded",
				exitCode: 0,
				startedAt: obligation.appliedAt! + 1,
				completedAt: obligation.appliedAt! + 2,
				verificationChangeSetIds: [obligation.changeSetId],
				cwd: workspace,
				command: VALID_COMMAND,
				verificationVersions,
				...override,
			},
		]
	}

	const recordCurrentEvidence = async (
		verificationVersions: NonNullable<ParentCommandVerificationEvidence["verificationVersions"]>,
		override: Partial<ParentCommandVerificationEvidence> = {},
	) => {
		setCommandEvidence(verificationVersions, override)
		await provider.recordParentVerificationEvidence(parent)
		return primaryObligation()
	}

	it.each(["tox -e py", "hatch test", "pnpm run ci:custom", "pytest --collect-only", "echo diagnostic"])(
		"records only process assurance for an explicitly associated approved command: %s",
		async (command) => {
			const before = await recordPrimaryMutation()
			const versions = await captureVerification(command)
			expect(versions[before.changeSetId]).toMatchObject({
				assurance: "process",
				matchedFiles: ["src/a.ts"],
			})
			expect(versions[before.changeSetId]).not.toHaveProperty("kind")
			const outcome = await recordCurrentEvidence(versions, { command })
			expect(outcome.verification).toMatchObject({ status: "passed", assurance: "process" })
		},
	)

	it.each(["missing", "malformed", "oversized"])(
		"does not require an invented Worker check when the manifest is %s",
		async (manifest) => {
			await recordAppliedWorker()
			if (manifest === "missing") await fs.unlink(path.join(workspace, "src/package.json"))
			else
				await fs.writeFile(
					path.join(workspace, "src/package.json"),
					manifest === "malformed" ? "{" : "x".repeat(300_000),
				)
			await captureVerification("custom-ci")
			await expect(provider.recordParentVerificationEvidence(parent)).resolves.toBeUndefined()
			expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)
			expect(primaryObligation().verification).toBeUndefined()
			expect(primaryObligation().verificationRequirements).toBeUndefined()
		},
	)

	it.each(["primary", "worker"] as const)(
		"invalidates unavailable optional %s evidence without reinstating a completion gate",
		async (origin) => {
			if (origin === "worker") await recordAppliedWorker()
			else await recordPrimaryMutation()
			const versions = await captureCurrentVerification()
			const passed = await recordCurrentEvidence(versions)
			expect(passed.verification?.status).toBe("passed")
			await fs.unlink(path.join(workspace, "src/a.ts"))
			await fs.mkdir(path.join(workspace, "src/a.ts"))
			await expect(provider.recordParentVerificationEvidence(parent)).resolves.toBeUndefined()
			const invalidated = primaryObligation()
			expect(invalidated.contentVersion).toBeGreaterThan(passed.contentVersion!)
			expect(invalidated.verification).toBeUndefined()
			expect(invalidated.scopeUnresolved).not.toBe(true)
			expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)
			await fs.rmdir(path.join(workspace, "src/a.ts"))
			await fs.writeFile(path.join(workspace, "src/a.ts"), "export const value = 1\n")
			setCommandEvidence(versions)
			await provider.recordParentVerificationEvidence(parent)
			expect(primaryObligation().verification).toBeUndefined()
		},
	)

	it("captures the associated content without inferring package requirements", async () => {
		const before = await recordPrimaryMutation()
		const verificationVersions = await captureCurrentVerification()
		const captured = verificationVersions[before.changeSetId]

		expect(captured).toMatchObject({
			contentVersion: before.contentVersion,
			contentFingerprint: expect.any(String),
			scopePath: workspace,
			commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			repositoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
		const current = primaryObligation()
		expect(current.changedFiles).toEqual(["src/a.ts"])
		expect(Object.keys(current.fileVersions ?? {})).toEqual(["src/a.ts"])
		expect(current.verificationRequirements).toBeUndefined()
		expect(current.contentVersion).toBe(captured?.contentVersion)
		expect(provider.getVerificationProgressState(parent)).toMatchObject({
			stateFingerprint: expect.stringContaining(before.changeSetId),
			evidenceFingerprint: undefined,
		})

		const satisfied = await recordCurrentEvidence(verificationVersions)
		expect(satisfied).toMatchObject({ status: "satisfied", verification: { status: "passed" } })
		const progress = provider.getVerificationProgressState(parent).evidenceFingerprint
		expect(progress).toBeDefined()
		await recordCurrentEvidence(verificationVersions)
		expect(provider.getVerificationProgressState(parent).evidenceFingerprint).toBe(progress)
	})

	it("preserves durable evidence when its UI projection fails", async () => {
		await recordPrimaryMutation()
		const versions = await captureCurrentVerification()
		vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockRejectedValueOnce(new Error("UI unavailable"))
		const logged = deferred()
		const error = vi.spyOn(console, "error").mockImplementation(() => logged.resolve())
		try {
			const outcome = await recordCurrentEvidence(versions)
			expect(outcome.verification).toMatchObject({ status: "passed", assurance: "process" })
			await logged.promise
			expect(error).toHaveBeenCalled()
		} finally {
			error.mockRestore()
		}
	})

	it("reads completion after durable evidence without waiting for its UI publication", async () => {
		await recordPrimaryMutation()
		const versions = await captureCurrentVerification()
		setCommandEvidence(versions)
		for (const [index, status] of (
			["completed", "completed", "completed", "interrupted", "interrupted"] as const
		).entries()) {
			const taskId = `settled-child-${index}`
			const summary = index === 0 ? "Reviewed the implementation and its remaining risks. ".repeat(500) : status
			await store.createAgent({
				taskId,
				parentTaskId: parent.taskId,
				nickname: `Child ${index}`,
				role: "review",
				objective: "Inspect the implementation",
				status,
				snapshot: { summary },
			})
			await store.appendEvent({
				sender: taskId,
				recipient: parent.taskId,
				kind: "result",
				name: `agent_${status}`,
				payload: { taskId, status, summary },
			})
		}
		const claim = await store.claimMailbox(parent.taskId, { channel: "automatic", kinds: ["result"] })
		await store.settleMailboxClaim(parent.taskId, claim.claimId, "acknowledge")
		const children = store.listDescendants(parent.taskId)
		const mailbox = store.getSnapshot().mailbox
		const publicationEntered = deferred()
		const publicationPending = deferred()
		vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementationOnce(async () => {
			publicationEntered.resolve()
			await publicationPending.promise
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let settled = false
		const decision = provider.getParentCompletionDecision(parent).then((result) => {
			settled = true
			return result
		})
		try {
			await publicationEntered.promise
			expect(primaryObligation().verification).toMatchObject({ status: "passed", assurance: "process" })
			// Drain the in-memory completion read while the controlled UI promise remains held.
			await vi.advanceTimersByTimeAsync(0)
			expect(settled, "Optional UI publication must not hold the durable completion decision").toBe(true)
			await expect(decision).resolves.toMatchObject({ allowed: true })
			expect(store.listDescendants(parent.taskId)).toEqual(children)
			expect(store.getSnapshot().mailbox).toEqual(mailbox)
		} finally {
			publicationPending.resolve()
			await decision
			await vi.advanceTimersByTimeAsync(0)
			vi.useRealTimers()
		}
	})

	it("coalesces held evidence publications and projects the latest durable receipt", async () => {
		await recordPrimaryMutation()
		const versions = await captureCurrentVerification()
		setCommandEvidence(versions)
		const firstExecution = commandEvidence[0]!.executionId
		const publicationEntered = deferred()
		const publicationPending = deferred()
		const latestPublished = deferred()
		const projectedExecutions: Array<string | undefined> = []
		let activePublications = 0
		let maximumPublications = 0
		vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementation(async () => {
			projectedExecutions.push(primaryObligation().verification?.executionId)
			activePublications++
			maximumPublications = Math.max(maximumPublications, activePublications)
			if (projectedExecutions.length === 1) {
				publicationEntered.resolve()
				await publicationPending.promise
			} else latestPublished.resolve()
			activePublications--
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const first = provider.recordParentVerificationEvidence(parent)
		try {
			await publicationEntered.promise
			await recordCurrentEvidence(versions, { status: "failed", exitCode: 1 })
			await recordCurrentEvidence(versions)
			const latestExecution = commandEvidence[0]!.executionId
			expect(primaryObligation().verification?.executionId).toBe(latestExecution)
			expect(projectedExecutions).toEqual([firstExecution])
			expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce()
			publicationPending.resolve()
			await latestPublished.promise
			await vi.advanceTimersByTimeAsync(0)
			expect(projectedExecutions).toEqual([firstExecution, latestExecution])
			expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(2)
			expect(maximumPublications).toBe(1)
		} finally {
			publicationPending.resolve()
			await first
			await vi.advanceTimersByTimeAsync(0)
			vi.useRealTimers()
		}
	})

	it.each(["task cancellation", "provider disposal"] as const)(
		"drops a queued evidence projection after %s without changing durable evidence",
		async (ending) => {
			await recordPrimaryMutation()
			const versions = await captureCurrentVerification()
			setCommandEvidence(versions)
			const publicationEntered = deferred()
			const publicationPending = deferred()
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementationOnce(async () => {
				publicationEntered.resolve()
				await publicationPending.promise
			})
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const first = provider.recordParentVerificationEvidence(parent)
			try {
				await publicationEntered.promise
				await recordCurrentEvidence(versions)
				const committed = primaryObligation()
				if (ending === "task cancellation") cancellation.abort()
				else Reflect.set(provider, "_disposed", true)
				publicationPending.resolve()
				await first
				await vi.advanceTimersByTimeAsync(0)
				expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce()
				expect(primaryObligation()).toEqual(committed)
			} finally {
				publicationPending.resolve()
				await first
				await vi.advanceTimersByTimeAsync(0)
				vi.useRealTimers()
			}
		},
	)

	it.each(["review", "worker"] as const)(
		"reads completion after saving a recovered %s group while UI publication remains pending",
		async (role) => {
			const projected: SubagentGroupState = {
				groupId: "recovered-group",
				parentTaskId: parent.taskId,
				createdAt: 1,
				status: "completed",
				agents: [
					{
						taskId: "recovered-review",
						nickname: "Reviewer",
						role,
						objective: "Review the implementation",
						status: "completed",
						summary: "Older summary",
						usage: { inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0 },
					},
				],
			}
			const retained = structuredClone(projected)
			retained.agents[0]!.summary = "Current retained summary"
			const updateHistory = vi.fn(async () => [])
			const artifact: ManagedWorkerArtifact = {
				id: "recovered-change",
				taskId: "recovered-review",
				status: "discarded",
				createdAt: 1,
				updatedAt: 2,
				gitRoot: workspace,
				logicalWorkspace: workspace,
				logicalWorkspaceFromRoot: "",
				baselineCommit: "a".repeat(40),
				writeScope: ["src"],
				gitRelativeScope: ["src"],
				fileWriteScope: [],
				gitRelativeFileScope: [],
				changes: [{ status: "M", path: "src/a.ts", binary: false }],
			}
			const load =
				role === "worker"
					? vi.spyOn(managedSubagentWorktreeService, "load").mockResolvedValue(artifact)
					: undefined
			if (role === "worker") {
				projected.agents[0]!.changeSet = {
					id: artifact.id,
					status: "pending_review",
					createdAt: 1,
					updatedAt: 1,
					changedFiles: ["src/a.ts"],
				}
				retained.agents[0]!.changeSet = structuredClone(projected.agents[0]!.changeSet)
				Object.assign(provider, {
					context: { globalStorageUri: { fsPath: workspace } },
					getLiveTask: vi.fn((taskId: string) => (taskId === parent.taskId ? parent : undefined)),
					getTaskWithId: vi.fn(async () => ({
						historyItem: {
							id: artifact.taskId,
							number: 1,
							ts: 1,
							task: "Review",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					})),
					updateTaskHistory: updateHistory,
					log: vi.fn(),
				})
			}
			await store.createAgent({
				taskId: "recovered-review",
				parentTaskId: parent.taskId,
				nickname: "Reviewer",
				role,
				objective: "Review the implementation",
				status: "completed",
			})
			parent.alphaMessages = [{ ts: 1, type: "say", say: "subagent_group", subagentGroup: projected }]
			Reflect.set(provider, "preparedSubagentGroups", new Map([[projected.groupId, { group: retained }]]))
			for (const method of ["synchronizeParentVerificationObligations", "refreshParentVerificationProjections"]) {
				Reflect.set(provider, method, Reflect.get(AlphaProvider.prototype, method))
			}
			const publicationEntered = deferred()
			const publicationPending = deferred()
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementationOnce(async () => {
				publicationEntered.resolve()
				await publicationPending.promise
			})
			const upsert = vi.fn(
				async (
					group: SubagentGroupState,
					guard?: () => boolean,
					options: { deferPublication?: boolean } = {},
				) => {
					if (guard && !guard()) return
					parent.alphaMessages[0].subagentGroup = structuredClone(group)
					if (!options.deferPublication) await provider.postStateToWebviewWithoutTaskHistory()
				},
			)
			parent.upsertSubagentGroup = upsert
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			let settled = false
			const decision = provider.getParentCompletionDecision(parent).then((result) => {
				settled = true
				return result
			})
			try {
				await publicationEntered.promise
				await vi.advanceTimersByTimeAsync(0)
				expect(settled, "Recovered group publication must not hold the durable completion decision").toBe(true)
				await expect(decision).resolves.toMatchObject({ allowed: true })
				expect(parent.alphaMessages[0].subagentGroup.agents[0].summary).toBe("Current retained summary")
				expect(upsert.mock.calls[0]?.[2]).toEqual({ deferPublication: true })
				if (role === "worker") {
					expect(updateHistory).toHaveBeenCalledWith(
						expect.objectContaining({
							subagentChangeSet: expect.objectContaining({ status: "discarded" }),
						}),
						{ broadcast: false },
					)
				}
			} finally {
				publicationPending.resolve()
				await decision
				await vi.advanceTimersByTimeAsync(0)
				vi.useRealTimers()
				load?.mockRestore()
			}
			expect(parent.alphaMessages[0].subagentGroup.agents[0].summary).toBe("Current retained summary")
		},
	)

	it("keeps completion pending until a recovered group is saved durably", async () => {
		const projected: SubagentGroupState = {
			groupId: "durable-group",
			parentTaskId: parent.taskId,
			createdAt: 1,
			status: "completed",
			agents: [],
		}
		const retained = { ...structuredClone(projected), completedAt: 2 }
		parent.alphaMessages = [{ ts: 1, type: "say", say: "subagent_group", subagentGroup: projected }]
		Reflect.set(provider, "preparedSubagentGroups", new Map([[projected.groupId, { group: retained }]]))
		Reflect.set(
			provider,
			"synchronizeParentVerificationObligations",
			Reflect.get(AlphaProvider.prototype, "synchronizeParentVerificationObligations"),
		)
		const saveEntered = deferred()
		const savePending = deferred()
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			saveEntered.resolve()
			await savePending.promise
			parent.alphaMessages[0].subagentGroup = structuredClone(group)
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let settled = false
		const decision = provider.getParentCompletionDecision(parent).then((result) => {
			settled = true
			return result
		})
		try {
			await saveEntered.promise
			await vi.advanceTimersByTimeAsync(0)
			expect(settled, "The durable group save must remain a completion barrier").toBe(false)
			expect(parent.alphaMessages[0].subagentGroup).toEqual(projected)
			savePending.resolve()
			await expect(decision).resolves.toMatchObject({ allowed: true })
			expect(parent.alphaMessages[0].subagentGroup).toEqual(retained)
		} finally {
			savePending.resolve()
			await decision
			await vi.advanceTimersByTimeAsync(0)
			vi.useRealTimers()
		}
	})

	it.each([
		["primary", "first"],
		["primary", "second"],
		["worker", "first"],
		["worker", "second"],
	])(
		"invalidates and refreshes %s evidence when the %s observation detects a change",
		async (origin, observation) => {
			if (origin === "worker") await recordAppliedWorker()
			else await recordPrimaryMutation()
			const versions = await captureCurrentVerification()
			const priorPublished = deferred()
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementationOnce(async () => {
				priorPublished.resolve()
			})
			const passed = await recordCurrentEvidence(versions)
			await priorPublished.promise
			const changeContent = () => fs.writeFile(path.join(workspace, "src/a.ts"), "export const value = 2\n")
			if (observation === "first") await changeContent()
			else {
				const reconcile = store.reconcileVerificationContent.bind(store)
				vi.spyOn(store, "reconcileVerificationContent").mockImplementationOnce(async (...args) => {
					const result = await reconcile(...args)
					await changeContent()
					return result
				})
			}
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockClear()
			const published = deferred()
			vi.mocked(provider.postStateToWebviewWithoutTaskHistory).mockImplementationOnce(async () => {
				published.resolve()
			})
			await provider.recordParentVerificationEvidence(parent)
			await published.promise
			expect(primaryObligation().verification).toBeUndefined()
			expect(primaryObligation().contentVersion).toBeGreaterThan(passed.contentVersion!)
			expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce()
		},
	)

	it("does not invalidate newer evidence when rejecting an older command identity", async () => {
		await recordPrimaryMutation()
		const versions = await captureCurrentVerification()
		await recordCurrentEvidence(versions)
		const older = structuredClone(commandEvidence[0])
		const newer = await recordCurrentEvidence(versions)
		commandEvidence = [{ ...older, command: "different command" }, ...commandEvidence]
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toEqual(newer)
	})

	it("preserves a newer receipt committed while stale observation waits for ledger ownership", async () => {
		await recordPrimaryMutation()
		const versions = await captureCurrentVerification()
		await recordCurrentEvidence(versions)
		const newer = { ...structuredClone(commandEvidence[0]), executionId: "newer-execution" }
		commandEvidence[0].command = "different command"
		const invalidate = store.invalidateVerificationEvidence.bind(store)
		vi.spyOn(store, "invalidateVerificationEvidence").mockImplementationOnce(async (...args) => {
			await store.recordParentVerificationEvidence(parent.taskId, [newer])
			return invalidate(...args)
		})
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation().verification).toMatchObject({ executionId: "newer-execution", status: "passed" })
	})

	it.each([
		["primary", true],
		["primary", false],
		["worker", true],
		["worker", false],
	] as const)(
		"preserves a newer %s receipt when the first content observation fails (prior receipt: %s)",
		async (origin, priorReceipt) => {
			if (origin === "worker") await recordAppliedWorker()
			else await recordPrimaryMutation()
			const versions = await captureCurrentVerification()
			setCommandEvidence(versions)
			if (priorReceipt) await provider.recordParentVerificationEvidence(parent)
			const newer = {
				...structuredClone(commandEvidence[0]),
				executionId: "newer-execution",
				completedAt: commandEvidence[0].completedAt! + 1,
			}
			let observationStarted!: () => void
			const started = new Promise<void>((resolve) => {
				observationStarted = resolve
			})
			let failObservation!: (error: Error) => void
			const failedObservation = new Promise<never>((_resolve, reject) => {
				failObservation = reject
			})
			const realpath = vi.spyOn(fs, "realpath").mockImplementationOnce(() => {
				observationStarted()
				return failedObservation
			})
			try {
				const reading = provider.recordParentVerificationEvidence(parent)
				await started
				await store.recordParentVerificationEvidence(parent.taskId, [newer])
				const committed = primaryObligation()
				failObservation(new Error("Content observation failed"))
				await reading
				expect(primaryObligation()).toEqual(committed)
				expect(primaryObligation().verification).toMatchObject({
					executionId: "newer-execution",
					status: "passed",
				})
			} finally {
				realpath.mockRestore()
			}
		},
	)

	const pythonVerification = async () => {
		await fs.writeFile(path.join(workspace, "app.py"), "answer = 42\n")
		await fs.mkdir(path.join(workspace, "tests"))
		await fs.writeFile(path.join(workspace, "tests/test_app.py"), "def test_answer():\n    assert True\n")
		await provider.recordPrimaryMutation(parent, await captureVerificationContent(workspace, ["app.py"]))
		const command = "python3.13 -m pytest tests"
		const versions = await captureVerification(command)
		expect(versions[primaryObligation().changeSetId]).toMatchObject({
			assurance: "process",
			matchedFiles: ["app.py"],
		})
		return { command, versions }
	}

	it("associates filtered tests with the explicit change set without claiming test coverage", async () => {
		await pythonVerification()
		await provider.recordPrimaryMutation(
			parent,
			await captureVerificationContent(workspace, ["app.py", "tests/test_app.py"]),
		)
		const versions = await captureVerification("pytest tests/test_app.py")
		const changeSetId = primaryObligation().changeSetId
		expect(versions[changeSetId]?.matchedFiles).toEqual(["app.py", "tests/test_app.py"])
		const outcome = await recordCurrentEvidence(versions, {
			command: "pytest tests/test_app.py",
		})
		expect(outcome.verification).toMatchObject({ status: "passed", assurance: "process" })
		expect(outcome.verification).not.toHaveProperty("kind")
	})

	it.each([
		{ status: "running" as const, completedAt: undefined },
		{ status: "failed" as const, exitCode: 1 },
		{ status: "cancelled" as const, exitCode: 0 },
		{ status: "denied" as const, exitCode: 0 },
		{ status: "timed_out" as const, exitCode: 0 },
		{ status: "succeeded" as const, exitCode: undefined },
		{ status: "succeeded" as const, exitCode: 0, signalName: "SIGTERM" },
	])("does not credit pytest output without an actual successful terminal receipt: %j", async (receipt) => {
		const { command, versions } = await pythonVerification()
		const outcome = await recordCurrentEvidence(versions, { command, ...receipt })
		expect(outcome.status).not.toBe("satisfied")
	})

	it("explains unknown command associations without granting credit", async () => {
		const { command } = await pythonVerification()
		const onRejected = vi.fn()
		expect(await provider.captureCommandVerification(parent, command, workspace, [], onRejected)).toBeUndefined()
		expect(onRejected).not.toHaveBeenCalled()
		expect(await provider.captureCommandVerification(parent, command, workspace, ["unknown"], onRejected)).toEqual(
			{},
		)
		expect(onRejected).toHaveBeenLastCalledWith(
			expect.objectContaining({ code: "unknown_change_set", changeSetId: "unknown" }),
		)
	})

	it("keeps optional evidence for prose edits without requiring it for completion", async () => {
		await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
		await fs.writeFile(path.join(workspace, "docs", "plan.md"), "# Plan\n")
		await fs.writeFile(path.join(workspace, "docs", "notes.md"), "# Notes\n")
		await provider.recordPrimaryMutation(
			parent,
			await captureVerificationContent(workspace, ["docs/plan.md", "docs/notes.md"]),
		)
		const pending = primaryObligation()
		const command = "pnpm exec prettier --check docs/plan.md docs/notes.md"

		expect(pending).toMatchObject({
			changedFiles: ["docs/notes.md", "docs/plan.md"],
			status: "pending",
			verificationRequirements: undefined,
		})
		expect(await provider.captureCommandVerification(parent, command, workspace, [])).toBeUndefined()
		expect(store.getParentCompletionDecision(parent.taskId)).toMatchObject({
			allowed: true,
			blockingObligations: [],
		})

		const staleVersions = (await provider.captureCommandVerification(parent, command, workspace, [
			pending.changeSetId,
		]))!
		expect(staleVersions[pending.changeSetId]).toMatchObject({
			assurance: "process",
			matchedFiles: ["docs/notes.md", "docs/plan.md"],
		})
		await fs.writeFile(path.join(workspace, "docs", "notes.md"), "# Externally updated notes\n")
		setCommandEvidence(staleVersions, { command })
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toMatchObject({ status: "pending" })
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)

		const currentVersions = (await provider.captureCommandVerification(parent, command, workspace, [
			pending.changeSetId,
		]))!
		const beforeMismatchedEvidence = primaryObligation()
		setCommandEvidence(currentVersions, { command, verificationChangeSetIds: ["different-change-set"] })
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toEqual(beforeMismatchedEvidence)

		const satisfied = await recordCurrentEvidence(currentVersions, { command })
		expect(satisfied).toMatchObject({
			status: "satisfied",
			verification: { status: "passed", assurance: "process" },
		})
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)
	})

	it.each(["primary", "worker"] as const)(
		"credits a real %s Task admission through a workspace alias",
		async (kind) => {
			const alias = path.join(outside, "workspace-alias")
			await fs.symlink(workspace, alias, "junction")
			parent.cwd = alias
			const rootTaskId = parent.taskId
			if (kind === "worker") {
				const worker = await store.createAgent({
					taskId: "outer-worker",
					parentTaskId: rootTaskId,
					rootTaskId,
					nickname: "outer",
					role: "worker",
					objective: "Integrate nested work",
					status: "running",
				})
				parent.taskId = worker.taskId
				parent.taskKind = "subagent"
				parent.subagentRole = "worker"
				parent.subagentContextManifest = { runtimePolicy: { role: "worker" } }
				Object.assign(provider, { getAgentControlRootTaskId: vi.fn(() => rootTaskId) })
				await store.recordWorkerChangeSet({
					rootTaskId,
					parentTaskId: worker.taskId,
					workerTaskId: "nested-worker",
					workerPath: `${worker.path}/nested`,
					workerNickname: "nested",
					groupId: "nested-group",
					changeSet: {
						id: "nested-change",
						status: "applied",
						changedFiles: ["src/a.ts"],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					reviewSource: "apply",
				})
			} else {
				await recordPrimaryMutation()
			}
			const before = primaryObligation()
			const task = Object.assign(Object.create(Task.prototype), {
				taskId: parent.taskId,
				taskKind: parent.taskKind,
				subagentRole: parent.subagentRole,
				subagentContextManifest: parent.subagentContextManifest,
				workspacePath: alias,
				alphaMessages: [],
				providerRef: new WeakRef(provider),
				commandExecutionEvidence: new Map(),
				abort: false,
			}) as Task
			await task.admitCommandExecution("verify-alias", "execution-alias", VALID_COMMAND, alias, [
				before.changeSetId,
			])
			const admitted = task.getCommandExecutionEvidence()[0]!
			expect(admitted).toMatchObject({
				cwd: workspace,
				verificationVersions: {
					[before.changeSetId]: { scopePath: workspace, matchedFiles: ["src/a.ts"] },
				},
			})
			expect(primaryObligation().workspacePath).toBe(workspace)
			commandEvidence = [{ ...admitted, status: "succeeded", exitCode: 0, completedAt: admitted.startedAt + 1 }]
			await provider.recordParentVerificationEvidence(parent)
			expect(primaryObligation()).toMatchObject({ status: "satisfied", verification: { status: "passed" } })
			expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)
		},
	)

	it("retains canonical reserved debt if an aliased workspace disappears during a command", async () => {
		const alias = path.join(outside, "workspace-alias")
		await fs.symlink(workspace, alias, "junction")
		parent.cwd = alias
		await provider.reservePrimaryMutation(parent, "workspace-command")
		expect(primaryObligation().workspacePath).toBe(workspace)
		await fs.rename(workspace, path.join(outside, "moved-workspace"))
		await expect(
			provider.recordPrimaryMutation(parent, { "unknown-command-scope": "unknown" }, true, "workspace-command"),
		).resolves.toBe(true)
		expect(primaryObligation()).toMatchObject({
			workspacePath: workspace,
			scopeUnresolved: true,
			mutationReservations: [],
		})
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(false)
	})

	it("does not strand an unresolved receipt when its mailbox projection fails", async () => {
		const token = "workspace-command"
		await provider.reservePrimaryMutation(parent, token)
		await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const value = 2\n")
		const fileVersions = await captureVerificationContent(workspace, ["src/a.ts"])
		const projectionError = new Error("verification projection unavailable")
		const appendEvent = vi.spyOn(store, "appendEvent").mockRejectedValue(projectionError)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const publish = vi.fn(async (...args: [any, any]) => {
			await (AlphaProvider.prototype as any).publishParentVerificationTransition.apply(provider, args)
		})
		Object.assign(provider, { publishParentVerificationTransition: publish })

		try {
			await expect(provider.recordPrimaryMutation(parent, fileVersions, true, token)).resolves.toBe(true)
			expect(appendEvent).toHaveBeenCalledOnce()
		} finally {
			errorSpy.mockRestore()
			appendEvent.mockRestore()
		}

		expect(publish).toHaveBeenCalledOnce()
		expect(primaryObligation()).toMatchObject({
			changedFiles: ["src/a.ts"],
			mutationReservations: [],
			status: "pending",
		})
		expect(store.getParentCompletionDecision(parent.taskId).blockingObligations).toHaveLength(1)
	})

	it("returns an affirmed unresolved receipt when the projection boundary rejects", async () => {
		const token = "workspace-command"
		await provider.reservePrimaryMutation(parent, token)
		await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const value = 2\n")
		const fileVersions = await captureVerificationContent(workspace, ["src/a.ts"])
		const projectionError = new Error("verification projection crashed")
		const publish = vi.fn().mockRejectedValue(projectionError)
		Object.assign(provider, { publishParentVerificationTransition: publish })
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		try {
			await expect(provider.recordPrimaryMutation(parent, fileVersions, true, token)).resolves.toBe(true)
			expect(errorSpy).toHaveBeenCalledWith(
				"[AlphaProvider] Failed to project a durable primary mutation receipt",
				projectionError,
			)
		} finally {
			errorSpy.mockRestore()
		}

		expect(publish).toHaveBeenCalledOnce()
		expect(primaryObligation()).toMatchObject({
			changedFiles: ["src/a.ts"],
			mutationReservations: [],
			status: "pending",
		})
		expect(store.getParentCompletionDecision(parent.taskId).blockingObligations).toHaveLength(1)
	})

	it("rejects a receipt for the wrong reservation token without mutating or settling the active reservation", async () => {
		await provider.reservePrimaryMutation(parent, "workspace-command")
		await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const value = 2\n")
		const fileVersions = await captureVerificationContent(workspace, ["src/a.ts"])

		await expect(provider.releasePrimaryMutation(parent, "different-command")).rejects.toThrow(
			"did not match an active reservation",
		)
		expect(primaryObligation()).toMatchObject({
			changedFiles: [],
			mutationReservations: ["workspace-command"],
			status: "pending",
		})

		await expect(provider.recordPrimaryMutation(parent, fileVersions, false, "different-command")).rejects.toThrow(
			"did not match an active reservation",
		)
		expect(primaryObligation()).toMatchObject({
			changedFiles: [],
			mutationReservations: ["workspace-command"],
			status: "pending",
		})

		await expect(provider.recordPrimaryMutation(parent, fileVersions, false, "workspace-command")).resolves.toBe(
			true,
		)
		expect(primaryObligation()).toMatchObject({
			changedFiles: ["src/a.ts"],
			mutationReservations: [],
			status: "pending",
		})
	})

	it("records a deeply nested file without inferring unrelated verification dependencies", async () => {
		const token = "deep-workspace-command"
		const relativeFile = [...Array.from({ length: 8 }, (_, index) => `level-${index}`), "deep.ts"].join("/")
		const absoluteFile = path.join(workspace, ...relativeFile.split("/"))
		await fs.mkdir(path.dirname(absoluteFile), { recursive: true })
		await fs.writeFile(absoluteFile, "export const deeplyNested = true\n")
		await provider.reservePrimaryMutation(parent, token)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		try {
			await expect(
				provider.recordPrimaryMutation(
					parent,
					await captureVerificationContent(workspace, [relativeFile]),
					false,
					token,
				),
			).resolves.toBe(true)
			expect(errorSpy).not.toHaveBeenCalled()
		} finally {
			errorSpy.mockRestore()
		}

		expect(primaryObligation()).toMatchObject({
			changedFiles: [relativeFile],
			fileVersions: { [relativeFile]: expect.any(String) },
			mutationReservations: [],
			status: "pending",
		})
		expect(primaryObligation().scopeUnresolved).not.toBe(true)
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)
	})

	it("invalidates associated source changes without inferring new requirements from manifests", async () => {
		await recordPrimaryMutation()
		const firstVersions = await captureCurrentVerification()
		const firstSatisfied = await recordCurrentEvidence(firstVersions)
		expect(firstSatisfied.status).toBe("satisfied")
		const firstProgress = provider.getVerificationProgressState(parent)
		expect(firstProgress.evidenceFingerprint).toBeDefined()

		await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const value = 2\n")
		const afterSourceEdit = await provider.recordParentVerificationEvidence(parent)
		expect(afterSourceEdit).toBeUndefined()
		const sourceInvalidated = primaryObligation()
		expect(sourceInvalidated).toMatchObject({ status: "pending", changedFiles: ["src/a.ts"] })
		expect(provider.getVerificationProgressState(parent)).toMatchObject({
			evidenceFingerprint: undefined,
		})
		expect(provider.getVerificationProgressState(parent).stateFingerprint).not.toBe(firstProgress.stateFingerprint)

		const secondVersions = await captureCurrentVerification()
		expect((await recordCurrentEvidence(secondVersions)).status).toBe("satisfied")

		await fs.writeFile(
			path.join(workspace, "src", "package.json"),
			'{"name":"verification-src","private":true,"scripts":{"check-types":"tsc --noEmit","lint":"eslint ."}}\n',
		)
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toMatchObject({
			status: "satisfied",
			changedFiles: ["src/a.ts"],
			verification: { assurance: "process" },
		})
		expect(primaryObligation().verificationRequirements).toBeUndefined()
	})

	it("keeps execution cwd confined while allowing explicitly associated sibling files", async () => {
		const primary = await recordPrimaryMutation()
		await fs.mkdir(path.join(workspace, "tools"))
		const versions = await provider.captureCommandVerification(
			parent,
			"node check-sibling.js && echo done",
			path.join(workspace, "tools"),
			[primary.changeSetId],
		)
		expect(versions?.[primary.changeSetId]).toMatchObject({
			scopePath: workspace,
			matchedFiles: ["src/a.ts"],
			assurance: "process",
		})
		await expect(
			provider.captureCommandVerification(parent, VALID_COMMAND, outside, [primary.changeSetId]),
		).rejects.toThrow(/outside (the )?workspace/)

		expect(primaryObligation()).toMatchObject({ status: "pending", contentVersion: primary.contentVersion })
	})

	it("never satisfies a running or failed command outcome", async () => {
		await recordPrimaryMutation()
		const verificationVersions = await captureCurrentVerification()

		const running = await recordCurrentEvidence(verificationVersions, {
			status: "running",
			completedAt: undefined,
		})
		expect(running.status).toBe("pending")

		const failed = await recordCurrentEvidence(verificationVersions, {
			status: "failed",
			exitCode: 1,
			completedAt: primaryObligation().appliedAt! + 3,
		})
		expect(failed).toMatchObject({ status: "failed", verification: { status: "failed" } })
		expect(store.getParentCompletionDecision(parent.taskId, parent.taskId).allowed).toBe(true)
	})
})
