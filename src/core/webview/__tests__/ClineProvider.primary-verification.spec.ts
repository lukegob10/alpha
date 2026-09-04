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
			contentVersion: before.contentVersion,
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
		await provider.recordPrimaryMutation(parent, { "unknown-command-scope": "unknown" }, true)
		await provider.releasePrimaryMutation(parent, "workspace-command")
		expect(primaryObligation()).toMatchObject({ workspacePath: workspace, scopeUnresolved: true })
		expect(store.getParentCompletionDecision(parent.taskId).allowed).toBe(false)
	})

	it("does not strand a receipt when its mailbox projection fails", async () => {
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
			await expect(provider.recordPrimaryMutation(parent, fileVersions, false, token)).resolves.toBe(true)
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
		expect(store.getParentCompletionDecision(parent.taskId, parent.taskId).allowed).toBe(false)
	})
})
