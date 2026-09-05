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

	it("admits a scoped pnpm typecheck and preserves source changedFiles while capturing package requirements", async () => {
		const before = await recordPrimaryMutation()
		const verificationVersions = await captureCurrentVerification()
		const captured = verificationVersions[before.changeSetId]

		expect(captured).toMatchObject({
			contentVersion: before.contentVersion! + 1,
			contentFingerprint: expect.any(String),
			scopePath: path.join(workspace, "src"),
			commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			repositoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
		const current = primaryObligation()
		expect(current.changedFiles).toEqual(["src/a.ts"])
		expect(Object.keys(current.fileVersions ?? {})).toEqual(
			expect.arrayContaining(["src/a.ts", "package.json", "src/package.json"]),
		)
		expect(current.contentVersion).toBe(captured?.contentVersion)
		expect(provider.getVerificationProgressState(parent)).toMatchObject({
			stateFingerprint: expect.stringContaining(before.changeSetId),
			evidenceFingerprint: undefined,
		})

		const satisfied = await recordCurrentEvidence(verificationVersions)
		expect(satisfied).toMatchObject({ status: "satisfied", verification: { status: "passed" } })
	})

	const pythonVerification = async () => {
		await fs.writeFile(path.join(workspace, "app.py"), "answer = 42\n")
		await fs.mkdir(path.join(workspace, "tests"))
		await fs.writeFile(path.join(workspace, "tests/test_app.py"), "def test_answer():\n    assert True\n")
		await provider.recordPrimaryMutation(parent, await captureVerificationContent(workspace, ["app.py"]))
		const command = "python3.13 -m pytest tests"
		const versions = await captureVerification(command)
		expect(versions[primaryObligation().changeSetId]).toMatchObject({
			runner: "pytest",
			kind: "test",
			matchedFiles: ["app.py"],
		})
		return { command, versions }
	}

	it.each([undefined, false, true])(
		"requires terminal pytest validation in addition to exit zero (%s)",
		async (testValidation) => {
			const { command, versions } = await pythonVerification()
			const outcome = await recordCurrentEvidence(versions, { command, testValidation })
			expect(outcome.status).toBe(testValidation === true ? "satisfied" : "pending")
		},
	)

	it("credits only the explicitly selected tests in a mixed Python change set", async () => {
		const { command } = await pythonVerification()
		await provider.recordPrimaryMutation(
			parent,
			await captureVerificationContent(workspace, ["app.py", "tests/test_app.py"]),
		)
		const versions = await captureVerification("pytest tests/test_app.py")
		const changeSetId = primaryObligation().changeSetId
		expect(versions[changeSetId]?.matchedFiles).toEqual(["tests/test_app.py"])
		const outcome = await recordCurrentEvidence(versions, {
			command: "pytest tests/test_app.py",
			testValidation: true,
		})
		expect(outcome.status).toBe("pending")
		expect(outcome.verifiedChecks?.["tests/test_app.py"]).toEqual(["test"])
		expect(outcome.verifiedChecks?.["app.py"]).toBeUndefined()
		expect(await captureVerification(command)).toHaveProperty(changeSetId)
	})

	it.each([
		{ status: "running" as const, completedAt: undefined },
		{ status: "failed" as const, exitCode: 1 },
		{ status: "cancelled" as const, exitCode: 0 },
		{ status: "succeeded" as const, exitCode: undefined },
		{ status: "succeeded" as const, exitCode: 0, signalName: "SIGTERM" },
	])("does not credit pytest output without an actual successful terminal receipt: %j", async (receipt) => {
		const { command, versions } = await pythonVerification()
		const outcome = await recordCurrentEvidence(versions, { command, testValidation: true, ...receipt })
		expect(outcome.status).not.toBe("satisfied")
	})

	it.each(["pytest.ini", "tests/.pytest.ini", "tests/new/conftest.py"])(
		"invalidates Python evidence when collection configuration appears at %s",
		async (file) => {
			const { command, versions } = await pythonVerification()
			await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
			await fs.writeFile(path.join(workspace, file), "[pytest]\naddopts = --collect-only\n")
			const outcome = await recordCurrentEvidence(versions, { command, testValidation: true })
			expect(outcome.status).toBe("pending")
		},
	)

	it("explains missing, unknown and unsupported command associations without granting credit", async () => {
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
		const changeSetId = primaryObligation().changeSetId
		expect(
			await provider.captureCommandVerification(
				parent,
				"pytest --collect-only",
				workspace,
				[changeSetId],
				onRejected,
			),
		).toEqual({})
		expect(onRejected).toHaveBeenLastCalledWith(
			expect.objectContaining({ code: "unsupported_command", changeSetId }),
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
			kind: "format",
			matchedFiles: ["docs/notes.md", "docs/plan.md"],
		})
		await fs.writeFile(path.join(workspace, "docs", "notes.md"), "# Externally updated notes\n")
		setCommandEvidence(staleVersions)
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toMatchObject({ status: "pending" })
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(true)

		const currentVersions = (await provider.captureCommandVerification(parent, command, workspace, [
			pending.changeSetId,
		]))!
		const beforeMismatchedEvidence = primaryObligation()
		setCommandEvidence(currentVersions, { verificationChangeSetIds: ["different-change-set"] })
		await provider.recordParentVerificationEvidence(parent)
		expect(primaryObligation()).toEqual(beforeMismatchedEvidence)

		const satisfied = await recordCurrentEvidence(currentVersions)
		expect(satisfied).toMatchObject({
			status: "satisfied",
			verifiedChecks: {
				"docs/notes.md": ["format"],
				"docs/plan.md": ["format"],
			},
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
					[before.changeSetId]: { scopePath: path.join(workspace, "src"), matchedFiles: ["src/a.ts"] },
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

	it("invalidates a passing verification after source and package manifest edits", async () => {
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
		const lintRequired = primaryObligation()
		expect(lintRequired).toMatchObject({ status: "pending", changedFiles: ["src/a.ts"] })
		expect(lintRequired.verification).toBeUndefined()

		const refreshedTypeVersions = await captureCurrentVerification()
		expect((await recordCurrentEvidence(refreshedTypeVersions)).status).toBe("pending")
		const lintVersions = await captureVerification("pnpm --dir src exec eslint . --ext=ts")
		expect((await recordCurrentEvidence(lintVersions)).status).toBe("satisfied")

		await fs.writeFile(
			path.join(workspace, "package.json"),
			'{"name":"verification-root","private":true,"version":"2"}\n',
		)
		await provider.recordParentVerificationEvidence(parent)
		const packageInvalidated = primaryObligation()
		expect(packageInvalidated).toMatchObject({ status: "pending", changedFiles: ["src/a.ts"] })
		expect(provider.getVerificationProgressState(parent).evidenceFingerprint).toBeUndefined()
	})

	it("fails closed for composite, echo, and out of scope commands", async () => {
		const primary = await recordPrimaryMutation()

		await expect(
			provider.captureCommandVerification(parent, `${VALID_COMMAND} && echo done`, workspace, [
				primary.changeSetId,
			]),
		).resolves.toEqual({})
		await expect(
			provider.captureCommandVerification(parent, "echo done", workspace, [primary.changeSetId]),
		).resolves.toEqual({})
		await expect(
			provider.captureCommandVerification(parent, "pnpm --dir .. exec tsc --noEmit", workspace, [
				primary.changeSetId,
			]),
		).rejects.toThrow(/outside (the )?workspace/)
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
