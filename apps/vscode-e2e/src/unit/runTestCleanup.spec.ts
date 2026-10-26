import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostLaunchFailureError } from "../hostLaunch"
import { runExtensionTests } from "../runTest"
import { TestRunError } from "../runFailure"
import { ImprovementCaptureHelperError } from "../evidence/improvementCapture"

test("a pre-host helper cleanup failure retains the lease and forbids later evidence or host dispatch", async () => {
	for (const cleanupVerified of [false, true]) {
		const root = await realpath(await mkdtemp(join(tmpdir(), "alpha-capture-lease-")))
		let releases = 0
		let launches = 0
		let afterRuns = 0
		try {
			const result = await runExtensionTests(
				{
					providerMode: "scripted",
					vscodeVersion: "1.138.0",
					profileDir: join(root, "profile"),
					workspace: join(root, "workspace"),
					artifactsDir: join(root, "artifacts"),
					initializeProfile: true,
					scenarioId: "problem-solving-attempt",
					improvementEvidence: true,
					improvementTaskId: "repo-cache-invalidation@1",
				},
				{
					acquireLease: async () => async () => {
						releases++
					},
					launch: async () => {
						launches++
						return 0
					},
					afterRun: async () => {
						afterRuns++
					},
					improvementCaptureInvoker: async () => {
						throw new ImprovementCaptureHelperError(cleanupVerified, true)
					},
				},
			)
			assert.equal(launches, 0)
			assert.equal(result.launchedHostPid, undefined)
			assert.equal(result.captureHelperCleanupVerified, cleanupVerified)
			assert.equal(result.failure, "host-cancelled")
			assert.equal(releases, cleanupVerified ? 1 : 0)
			if (!cleanupVerified) {
				assert.equal(afterRuns, 0)
				assert.equal(result.captureComplete, false)
				await assert.rejects(stat(join(result.artifactsDir, "manifest.json")), { code: "ENOENT" })
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}
})

test("an automatic timeout releases a profile lease only after both root close and tree cleanup are verified", async () => {
	let releases = 0
	for (const { observed, verified } of [
		{ observed: false, verified: true },
		{ observed: true, verified: false },
		{ observed: true, verified: true },
	]) {
		const root = await realpath(await mkdtemp(join(tmpdir(), "alpha-timeout-lease-")))
		try {
			const result = await runExtensionTests(
				{
					providerMode: "scripted",
					vscodeVersion: "1.138.0",
					profileDir: join(root, "profile"),
					workspace: join(root, "workspace"),
					artifactsDir: join(root, "artifacts"),
					initializeProfile: true,
				},
				{
					acquireLease: async () => async () => {
						releases++
					},
					launchHost: async (_options, onSpawn) => {
						onSpawn?.(123)
						throw new HostLaunchFailureError("host-execution-timeout", observed, verified)
					},
				},
			)
			assert.equal(result.status, "blocked")
			assert.equal(result.failure, "host-execution-timeout")
			assert.equal(result.hostExitObserved, observed)
			assert.equal(result.hostCleanupVerified, verified)
			assert.equal(releases, observed && verified ? 1 : 0)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}
})

test("automatic execution deadlines are explicit bounded options and cannot alter interactive setup", async () => {
	const options = {
		providerMode: "live-copilot" as const,
		vscodeVersion: "1.138.0",
		modelId: "model",
		profileDir: join(tmpdir(), "deadline-options-profile"),
		workspace: join(tmpdir(), "deadline-options-workspace"),
		artifactsDir: join(tmpdir(), "deadline-options-artifacts"),
	}
	const invalidDeadline = (error: unknown) => {
		assert.ok(error instanceof TestRunError)
		assert.equal(error.code, "invalid-options")
		assert.match(error.message, /Automatic execution timeout/)
		return true
	}
	for (const executionTimeoutMs of [0, -1, 0.5, NaN, Infinity, 86_400_001]) {
		await assert.rejects(runExtensionTests({ ...options, executionTimeoutMs }), invalidDeadline)
	}
	await assert.rejects(
		runExtensionTests({
			...options,
			setup: true,
			executionTimeoutMs: 1_000,
		}),
		invalidDeadline,
	)
})
