import * as path from "path"

import {
	AgentControlStore,
	InMemoryAgentControlPersistence,
	type ParentCommandVerificationEvidence,
} from "../AgentControlStore"

const workspacePath = path.resolve("/workspace")
const otherWorkspacePath = path.resolve("/other-workspace")

const createClock = (initial = 1_000) => {
	let current = initial
	return {
		now: () => current,
		set: (value: number) => {
			current = value
		},
	}
}

const setup = async () => {
	const persistence = new InMemoryAgentControlPersistence()
	const clock = createClock()
	const store = new AgentControlStore(persistence, clock.now)
	await store.initialize()
	await store.ensureRoot({ taskId: "root-1", objective: "Coordinate work", status: "running" })
	return { store, persistence, clock }
}

const recordPrimary = (store: AgentControlStore, fileVersions: Record<string, string>, at = 2_000) =>
	store.recordPrimaryMutation({
		rootTaskId: "root-1",
		parentTaskId: "root-1",
		workspacePath,
		fileVersions,
		at,
	})

type VerificationVersion = NonNullable<ParentCommandVerificationEvidence["verificationVersions"]>[string]

const verificationVersion = (
	obligation: { contentVersion?: number; contentFingerprint?: string },
	override: Partial<VerificationVersion> = {},
): VerificationVersion => ({
	contentVersion: obligation.contentVersion!,
	contentFingerprint: obligation.contentFingerprint!,
	scopePath: workspacePath,
	commandDigest: "command-digest",
	repositoryDigest: "repository-digest",
	...override,
})

const verificationEvidence = (
	changeSetId: string,
	obligation: { contentVersion?: number; contentFingerprint?: string },
	override: Partial<ParentCommandVerificationEvidence> = {},
): ParentCommandVerificationEvidence => ({
	toolCallId: "verify-tool-call",
	executionId: "verify-execution",
	status: "succeeded",
	exitCode: 0,
	startedAt: 2_100,
	completedAt: 2_200,
	command: "pnpm test",
	verificationChangeSetIds: [changeSetId],
	cwd: workspacePath,
	verificationVersions: {
		[changeSetId]: verificationVersion(obligation),
	},
	...override,
})

const recordAppliedWorker = async (
	store: AgentControlStore,
	changeSetId: string,
	changedFiles: string[],
	workerTaskId: string,
	at: number,
) =>
	store.recordWorkerChangeSet({
		rootTaskId: "root-1",
		parentTaskId: "root-1",
		workerTaskId,
		workerPath: `/root/${workerTaskId}`,
		workerNickname: workerTaskId,
		groupId: `${workerTaskId}-group`,
		changeSet: {
			id: changeSetId,
			status: "applied",
			changedFiles,
			createdAt: at - 100,
			updatedAt: at,
		},
		reviewSource: "apply",
		at,
	})

describe("AgentControlStore primary verification", () => {
	it("records a primary ledger change set and treats identical replays as no-ops", async () => {
		const { store } = await setup()

		expect(await recordPrimary(store, {}, 1_900)).toBeUndefined()
		expect(store.getVerificationObligations()).toEqual([])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)

		const first = await recordPrimary(store, {
			"src/b.ts": "version-b-1",
			"src/a.ts": "version-a-1",
		})
		expect(first).toMatchObject({
			id: "primary-change:root-1",
			changeSetId: "primary-change:root-1",
			origin: "primary",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			workerTaskId: "root-1",
			status: "pending",
			workspacePath,
			fileVersions: {
				"src/a.ts": "version-a-1",
				"src/b.ts": "version-b-1",
			},
			changedFiles: ["src/a.ts", "src/b.ts"],
			contentVersion: 1,
			contentFingerprint: expect.any(String),
			appliedAt: 2_000,
		})

		const replay = await recordPrimary(
			store,
			{
				"src/a.ts": "version-a-1",
				"src/b.ts": "version-b-1",
			},
			2_500,
		)
		expect(replay).toMatchObject({
			id: first?.id,
			contentVersion: first?.contentVersion,
			contentFingerprint: first?.contentFingerprint,
			updatedAt: first?.updatedAt,
			appliedAt: first?.appliedAt,
		})
		expect(store.getVerificationObligations()).toEqual([replay])
	})

	it("reconciles changed content, advances the version, and invalidates prior evidence", async () => {
		const { store, clock } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!

		const passed = await store.recordParentVerificationEvidence("root-1", [
			verificationEvidence(primary.changeSetId, primary),
		])
		expect(passed).toMatchObject([{ status: "satisfied", verification: { status: "passed" } }])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)

		clock.set(3_000)
		const reconciled = (await store.reconcileVerificationContent(
			"root-1",
			primary.changeSetId,
			workspacePath,
			{ "src/example.ts": "version-2" },
			"root-1",
		))!
		expect(reconciled).toMatchObject({
			status: "pending",
			contentVersion: primary.contentVersion! + 1,
			contentFingerprint: expect.any(String),
			fileVersions: { "src/example.ts": "version-2" },
		})
		expect(reconciled.verification).toBeUndefined()
		expect(reconciled.contentFingerprint).not.toBe(primary.contentFingerprint)
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)

		const replay = await store.reconcileVerificationContent(
			"root-1",
			primary.changeSetId,
			workspacePath,
			{ "src/example.ts": "version-2" },
			"root-1",
		)
		expect(replay?.contentVersion).toBe(reconciled.contentVersion)
	})

	it("keeps ordinary completion available when no primary mutation is recorded", async () => {
		const { store } = await setup()

		expect(store.getParentCompletionDecision("root-1")).toEqual({
			allowed: true,
			blockingObligations: [],
		})
	})

	it.each([
		{
			name: "a running command",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, { status: "running", completedAt: undefined }),
		},
		{
			name: "a pre-change command",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, { startedAt: 1_999, completedAt: 2_050 }),
		},
		{
			name: "stale content versions",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, {
					verificationVersions: {
						[changeSetId]: verificationVersion(obligation, {
							contentVersion: obligation.contentVersion! + 1,
							contentFingerprint: "stale-fingerprint",
						}),
					},
				}),
		},
		{
			name: "a command in the wrong cwd",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, { cwd: otherWorkspacePath }),
		},
		{
			name: "missing captured versions",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, { verificationVersions: undefined }),
		},
		{
			name: "a scope that does not cover the workspace change",
			makeEvidence: (changeSetId: string, obligation: { contentVersion?: number; contentFingerprint?: string }) =>
				verificationEvidence(changeSetId, obligation, {
					verificationVersions: {
						[changeSetId]: verificationVersion(obligation, { scopePath: otherWorkspacePath }),
					},
				}),
		},
	] as const)("does not credit $name as verification", async ({ makeEvidence }) => {
		const { store } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!

		expect(
			await store.recordParentVerificationEvidence("root-1", [makeEvidence(primary.changeSetId, primary)]),
		).toEqual([])
		expect(store.getVerificationObligations()[0]).toMatchObject({ status: "pending" })
		expect(store.getVerificationObligations()[0].verification).toBeUndefined()
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("requires a zero-exit, signal-free successful command for the current content", async () => {
		const { store } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!

		expect(
			await store.recordParentVerificationEvidence("root-1", [
				verificationEvidence(primary.changeSetId, primary, { exitCode: 1 }),
			]),
		).toEqual([])
		expect(
			await store.recordParentVerificationEvidence("root-1", [
				verificationEvidence(primary.changeSetId, primary, { signalName: "SIGTERM" }),
			]),
		).toEqual([])
		expect(store.getVerificationObligations()[0]).toMatchObject({ status: "pending" })
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it.each(["failed", "cancelled"] as const)("records a %s command as failed debt", async (status) => {
		const { store } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!

		const failed = await store.recordParentVerificationEvidence("root-1", [
			verificationEvidence(primary.changeSetId, primary, {
				status,
				exitCode: status === "failed" ? 1 : undefined,
				completedAt: 2_300,
			}),
		])
		expect(failed).toMatchObject([
			{
				status: "failed",
				verification: { status: "failed", executionId: "verify-execution" },
			},
		])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("lets a later failure invalidate an earlier pass and a later pass clear it again", async () => {
		const { store } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!

		await expect(
			store.recordParentVerificationEvidence("root-1", [
				verificationEvidence(primary.changeSetId, primary, {
					toolCallId: "pass-1",
					executionId: "execution-pass-1",
				}),
			]),
		).resolves.toMatchObject([{ status: "satisfied" }])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)

		const failed = await store.recordParentVerificationEvidence("root-1", [
			verificationEvidence(primary.changeSetId, primary, {
				toolCallId: "failure-1",
				executionId: "execution-failure-1",
				status: "failed",
				exitCode: 1,
				startedAt: 2_300,
				completedAt: 2_400,
			}),
		])
		expect(failed).toMatchObject([{ status: "failed", verification: { executionId: "execution-failure-1" } }])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)

		const passedAgain = await store.recordParentVerificationEvidence("root-1", [
			verificationEvidence(primary.changeSetId, primary, {
				toolCallId: "pass-2",
				executionId: "execution-pass-2",
				startedAt: 2_500,
				completedAt: 2_600,
			}),
		])
		expect(passedAgain).toMatchObject([{ status: "satisfied", verification: { executionId: "execution-pass-2" } }])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)
	})

	it("persists primary verification debt and evidence across reloads", async () => {
		const { persistence, store } = await setup()
		const primary = (await recordPrimary(store, { "src/example.ts": "version-1" }))!
		const pending = store.getVerificationObligations()

		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getVerificationObligations()).toEqual(pending)
		expect(reloaded.getParentCompletionDecision("root-1").allowed).toBe(false)

		const evidence = verificationEvidence(primary.changeSetId, primary, {
			toolCallId: "reload-pass",
			executionId: "reload-execution",
		})
		await expect(reloaded.recordParentVerificationEvidence("root-1", [evidence])).resolves.toMatchObject([
			{
				status: "satisfied",
				verification: {
					status: "passed",
					cwd: workspacePath,
					contentVersion: primary.contentVersion,
					contentFingerprint: primary.contentFingerprint,
					scopePath: workspacePath,
					commandDigest: "command-digest",
					repositoryDigest: "repository-digest",
				},
			},
		])

		const reloadedAgain = new AgentControlStore(persistence)
		await reloadedAgain.initialize()
		expect(reloadedAgain.getVerificationObligations()).toEqual(reloaded.getVerificationObligations())
		expect(reloadedAgain.getParentCompletionDecision("root-1")).toEqual({
			allowed: true,
			blockingObligations: [],
		})
	})

	it("invalidates overlapping applied Worker evidence while preserving unrelated evidence", async () => {
		const { store, clock } = await setup()
		const shared = (
			await recordAppliedWorker(store, "worker-shared-change", ["src/shared.ts"], "worker-shared", 2_000)
		).obligation!
		const unrelated = (
			await recordAppliedWorker(store, "worker-other-change", ["src/other.ts"], "worker-other", 2_000)
		).obligation!

		clock.set(2_100)
		const sharedCurrent = (await store.reconcileVerificationContent(
			"root-1",
			"worker-shared-change",
			workspacePath,
			{ "src/shared.ts": "worker-version-1" },
			"root-1",
		))!
		const unrelatedCurrent = (await store.reconcileVerificationContent(
			"root-1",
			"worker-other-change",
			workspacePath,
			{ "src/other.ts": "worker-version-1" },
			"root-1",
		))!

		await store.recordParentVerificationEvidence("root-1", [
			verificationEvidence(shared.changeSetId, sharedCurrent, {
				toolCallId: "shared-pass",
				executionId: "shared-execution",
			}),
			verificationEvidence(unrelated.changeSetId, unrelatedCurrent, {
				toolCallId: "unrelated-pass",
				executionId: "unrelated-execution",
			}),
		])
		expect(store.getVerificationObligations({ workerTaskId: "worker-shared" })[0]).toMatchObject({
			status: "satisfied",
			verification: { executionId: "shared-execution" },
		})
		expect(store.getVerificationObligations({ workerTaskId: "worker-other" })[0]).toMatchObject({
			status: "satisfied",
			verification: { executionId: "unrelated-execution" },
		})

		clock.set(3_000)
		await recordPrimary(store, { "src/shared.ts": "primary-version-2" }, 3_000)

		expect(store.getVerificationObligations({ workerTaskId: "worker-shared" })[0]).toMatchObject({
			status: "pending",
			contentVersion: sharedCurrent.contentVersion! + 1,
		})
		expect(store.getVerificationObligations({ workerTaskId: "worker-shared" })[0].verification).toBeUndefined()
		expect(store.getVerificationObligations({ workerTaskId: "worker-other" })[0]).toMatchObject({
			status: "satisfied",
			verification: { executionId: "unrelated-execution" },
		})
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("blocks an empty primary mutation reservation and retains it across reload", async () => {
		const { persistence, store } = await setup()

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "mutation-1")

		expect(store.getVerificationObligations()).toMatchObject([
			{
				id: "primary-change:root-1",
				origin: "primary",
				changedFiles: [],
				mutationReservations: ["mutation-1"],
				status: "pending",
			},
		])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)

		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()

		expect(reloaded.getVerificationObligations()).toMatchObject([
			{
				id: "primary-change:root-1",
				changedFiles: [],
				mutationReservations: ["mutation-1"],
				status: "pending",
			},
		])
		expect(reloaded.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("removes an empty provisional reservation only after its token is released", async () => {
		const { store } = await setup()

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "mutation-1")
		await store.releasePrimaryMutation("root-1", "root-1", "unknown-token")
		expect(store.getVerificationObligations()).toMatchObject([
			{ id: "primary-change:root-1", mutationReservations: ["mutation-1"], status: "pending" },
		])

		await store.releasePrimaryMutation("root-1", "root-1", "mutation-1")

		expect(store.getVerificationObligations()).toEqual([])
		expect(store.getParentCompletionDecision("root-1")).toEqual({
			allowed: true,
			blockingObligations: [],
		})
	})

	it("preserves verification debt when a reserved mutation publishes actual changes", async () => {
		const { store } = await setup()

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "mutation-1")
		const primary = (await recordPrimary(store, { "src/changed.ts": "version-1" }))!

		await store.releasePrimaryMutation("root-1", "root-1", "mutation-1")

		expect(store.getVerificationObligations()).toMatchObject([
			{
				id: primary.changeSetId,
				changedFiles: ["src/changed.ts"],
				mutationReservations: [],
				status: "pending",
			},
		])
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("records a final receipt and settles its reservation in one transaction", async () => {
		const { store, persistence } = await setup()

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "mutation-1")
		const primary = await store.recordPrimaryMutation({
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			workspacePath,
			fileVersions: { "src/changed.ts": "version-1" },
			reservationToken: "mutation-1",
			at: 2_000,
		})

		expect(primary).toMatchObject({
			changedFiles: ["src/changed.ts"],
			mutationReservations: [],
			status: "pending",
		})
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(false)

		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getVerificationObligations()[0]?.mutationReservations).toEqual([])
	})

	it("does not infer a safe repair for a non-atomic reserved receipt after reload", async () => {
		const { store, persistence } = await setup()

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "legacy-mutation")
		await recordPrimary(store, { "src/changed.ts": "version-1" })

		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getVerificationObligations()[0]).toMatchObject({
			changedFiles: ["src/changed.ts"],
			mutationReservations: ["legacy-mutation"],
		})
		expect(reloaded.getParentCompletionDecision("root-1").allowed).toBe(false)
	})

	it("restores a satisfied snapshot after a proven no-op reservation release", async () => {
		const { store } = await setup()
		const primary = (await recordPrimary(store, { "src/unchanged.ts": "version-1" }))!
		const evidence = verificationEvidence(primary.changeSetId, primary, {
			toolCallId: "before-reservation",
			executionId: "before-execution",
		})
		await store.recordParentVerificationEvidence("root-1", [evidence])
		const satisfiedSnapshot = store.getVerificationObligations()[0]

		await store.reservePrimaryMutation("root-1", "root-1", workspacePath, "mutation-1")
		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "pending",
			mutationReservations: ["mutation-1"],
		})
		await expect(store.recordParentVerificationEvidence("root-1", [evidence])).resolves.toEqual([])
		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "pending",
			verification: satisfiedSnapshot.verification,
		})

		await store.releasePrimaryMutation("root-1", "root-1", "mutation-1")

		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "satisfied",
			changedFiles: satisfiedSnapshot.changedFiles,
			contentVersion: satisfiedSnapshot.contentVersion,
			contentFingerprint: satisfiedSnapshot.contentFingerprint,
			verification: satisfiedSnapshot.verification,
		})
		expect(store.getParentCompletionDecision("root-1").allowed).toBe(true)
	})

	it("accumulates every declared check per changed file and clears coverage after an edit", async () => {
		const { store } = await setup()
		const primary = (await store.recordPrimaryMutation({
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			workspacePath,
			fileVersions: { "src/required.ts": "version-1" },
			verificationRequirements: { "src/required.ts": ["test", "types", "lint"] },
			at: 2_000,
		}))!
		const evidenceFor = (kind: VerificationVersion["kind"], executionId: string) =>
			verificationEvidence(primary.changeSetId, primary, {
				toolCallId: `${kind}-tool-call`,
				executionId,
				verificationVersions: {
					[primary.changeSetId]: verificationVersion(primary, {
						kind,
						matchedFiles: ["src/required.ts"],
					}),
				},
			})

		await store.recordParentVerificationEvidence("root-1", [evidenceFor("test", "test-execution")])
		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "pending",
			verifiedChecks: { "src/required.ts": ["test"] },
		})
		await store.recordParentVerificationEvidence("root-1", [evidenceFor("types", "types-execution")])
		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "pending",
			verifiedChecks: { "src/required.ts": ["test", "types"] },
		})
		await store.recordParentVerificationEvidence("root-1", [evidenceFor("format", "format-execution")])
		expect(store.getVerificationObligations()[0]).toMatchObject({
			status: "pending",
			verifiedChecks: { "src/required.ts": ["format", "test", "types"] },
		})
		const completed = await store.recordParentVerificationEvidence("root-1", [
			evidenceFor("lint", "lint-execution"),
		])
		expect(completed).toMatchObject([
			{
				status: "satisfied",
				verifiedChecks: { "src/required.ts": ["format", "lint", "test", "types"] },
			},
		])

		const reconciled = await store.reconcileVerificationContent(
			"root-1",
			primary.changeSetId,
			workspacePath,
			{ "src/required.ts": "version-2" },
			"root-1",
		)
		expect(reconciled).toMatchObject({ status: "pending", contentVersion: primary.contentVersion! + 1 })
		expect(reconciled?.verifiedChecks).toBeUndefined()
		expect(reconciled?.verification).toBeUndefined()
	})
})
