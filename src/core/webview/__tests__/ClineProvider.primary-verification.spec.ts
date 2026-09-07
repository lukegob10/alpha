import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	AgentControlStore,
	InMemoryAgentControlPersistence,
	type ParentCommandVerificationEvidence,
} from "../../agent/AgentControlStore"
import { captureVerificationContent } from "../../agent/VerificationScope"
import { Task } from "../../task/Task"
import { ClineProvider } from "../ClineProvider"

const VALID_COMMAND = "pnpm --dir src exec tsc --noEmit"

describe("ClineProvider primary verification", () => {
	let workspace: string
	let outside: string
	let store: AgentControlStore
	let provider: ClineProvider
	let parent: any
	let commandEvidence: ParentCommandVerificationEvidence[]
	let executionNumber: number

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
		parent = {
			taskId: "parent-1",
			taskKind: "primary",
			cwd: workspace,
			metadata: { task: "Coordinate work" },
			clineMessages: [],
			getCommandExecutionEvidence: vi.fn(() => commandEvidence),
			getTaskLifetimeCancellationSignal: vi.fn(() => new AbortController().signal),
		}
		provider = Object.assign(Object.create(ClineProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			getAgentControlRootTaskId: vi.fn(() => parent.taskId),
			ensureAgentControlRoot: vi.fn(async () => root),
			synchronizeParentVerificationObligations: vi.fn(async () => undefined),
			publishParentVerificationTransition: vi.fn(async () => undefined),
			refreshParentVerificationProjections: vi.fn(async () => undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		}) as ClineProvider
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	})

	const primaryObligation = () => store.getVerificationObligations({ parentTaskId: parent.taskId })[0]!

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
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			const outcome = await recordCurrentEvidence(versions)
			expect(outcome.verification).toMatchObject({ status: "passed", assurance: "process" })
			expect(error).toHaveBeenCalled()
		} finally {
			error.mockRestore()
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
			const passed = await recordCurrentEvidence(versions)
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
			await provider.recordParentVerificationEvidence(parent)
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
				clineMessages: [],
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
			await (ClineProvider.prototype as any).publishParentVerificationTransition.apply(provider, args)
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
				"[ClineProvider] Failed to project a durable primary mutation receipt",
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
