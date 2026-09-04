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
