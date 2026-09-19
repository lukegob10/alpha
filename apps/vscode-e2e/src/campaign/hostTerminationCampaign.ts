import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

import { runExtensionTests, type ExtensionTestRunResult } from "../runTest"
import { prepareTestProfile } from "../testProfile"
import {
	isProcessAlive,
	readProcessTreeObservation,
	startNonCooperativeHttpStream,
	terminateProcessTree,
	writeProcessTreeFixture,
	type CancellationStreamFixture,
	type ProcessTreeFixture,
	type ProcessTreeObservation,
} from "../scenarios/cancellationFixture"
import { initializeRecoveryFixture } from "../evidence/storageRecovery"
import { readBounded } from "../evidence/paths"
import { requireHeldRetentionReceipt } from "./retentionReceipt"
import type { CampaignHost } from "./types"

const execFile = promisify(execFileCallback)

export interface HostTerminationCampaignReport {
	schemaVersion: 1
	hostVersion: CampaignHost["version"]
	status: "running" | "passed" | "failed"
	runs: ExtensionTestRunResult[]
	prepareHostStatus?: ExtensionTestRunResult["status"]
	recoverHostStatus?: ExtensionTestRunResult["status"]
	streamClientClosed?: boolean
	processTreeDead?: boolean
	capacityReleased?: boolean
	workerCount?: number
	cleanupVerified?: boolean
	failure?: string
}

const waitFor = async (
	condition: () => boolean | Promise<boolean>,
	{ timeout = 60_000, description = "condition" }: { timeout?: number; description?: string } = {},
): Promise<void> => {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (await condition()) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out waiting for ${description}`)
}

const ensureGitRepository = async (workspace: string): Promise<void> => {
	try {
		await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace, windowsHide: true })
	} catch {
		await execFile("git", ["init"], { cwd: workspace, windowsHide: true })
	}
	await execFile("git", ["add", "-f", "--", ".alpha-cancellation"], { cwd: workspace, windowsHide: true })
	const { stdout } = await execFile("git", ["diff", "--cached", "--name-only"], {
		cwd: workspace,
		windowsHide: true,
	})
	if (stdout.trim().length > 0) {
		await execFile(
			"git",
			[
				"-c",
				"user.name=Alpha E2E",
				"-c",
				"user.email=alpha-e2e@local.invalid",
				"commit",
				"-m",
				"managed-agent orderly termination baseline",
			],
			{ cwd: workspace, windowsHide: true },
		)
	}
}

const readJson = async (filePath: string): Promise<unknown> =>
	JSON.parse((await readBounded(filePath, 1_048_576)).toString("utf8")) as unknown

const isValidPid = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0

const isPidGone = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return false
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH"
	}
}

const hostPidsGone = (result: ExtensionTestRunResult): boolean => {
	const pids = [result.launchedHostPid, result.extensionHostPid, result.extensionHostParentPid]
	if (!pids.every(isValidPid)) return false
	return pids.every((pid) => isPidGone(pid))
}

const assertProcessTreeReady = (value: unknown): ProcessTreeObservation => {
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	const observation = value as ProcessTreeObservation
	assert.equal(isValidPid(observation.commandPid), true)
	assert.equal(isValidPid(observation.descendantPid), true)
	assert.equal(isValidPid(observation.descendantActualPid), true)
	assert.equal(isValidPid(observation.descendantParentPid), true)
	assert.equal(observation.descendantActualPid, observation.descendantPid)
	assert.equal(observation.descendantParentPid, observation.commandPid)
	// Liveness was witnessed inside the host before closeWindow. The controller
	// reads this receipt after exit, when successful cleanup makes these PIDs dead.
	return observation
}

const assertHostRun = (result: ExtensionTestRunResult, version: string): void => {
	assert.equal(result.execution, "extension-host")
	assert.equal(result.actualVSCodeVersion, version)
	assert.equal(result.ownershipGate, "verified")
	assert.equal(result.hostExitObserved, true)
}

const readPhaseReceipt = async (artifactsDir: string, name: string): Promise<Record<string, unknown>> => {
	const value = await readJson(path.join(artifactsDir, name))
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	return value as Record<string, unknown>
}

/**
 * Owns an external stream/process fixture while two ordinary runExtensionTests
 * launches reuse one persistent profile. The first host closes its own window
 * after recording ready evidence; the second host verifies durable interruption.
 */
export async function runHostTerminationCampaign(options: {
	fixtureRoot: string
	host: CampaignHost
	signal?: AbortSignal
}): Promise<HostTerminationCampaignReport> {
	assert.equal(options.host.version, "1.122.1")
	assert.ok(options.host.executable && path.isAbsolute(options.host.executable))
	const fixture = await initializeRecoveryFixture(options.fixtureRoot)
	const report: HostTerminationCampaignReport = {
		schemaVersion: 1,
		hostVersion: options.host.version,
		status: "running",
		runs: [],
	}
	let stream: CancellationStreamFixture | undefined
	let processFixture: ProcessTreeFixture | undefined
	let processObservation: ProcessTreeObservation = {}
	try {
		const profileDir = path.join(fixture.fixtureRoot, "profile")
		const workspace = path.join(fixture.fixtureRoot, "workspace")
		const artifactsDir = path.join(fixture.fixtureRoot, "evidence")
		await prepareTestProfile({
			profileDir,
			workspace,
			artifactsDir,
			vscodeVersion: options.host.version,
			initializeProfile: true,
		})
		const streamFixture = await startNonCooperativeHttpStream()
		stream = streamFixture
		const processFixtureValue = await writeProcessTreeFixture(workspace)
		processFixture = processFixtureValue
		await ensureGitRepository(workspace)
		const readyPath = path.join(fixture.fixtureRoot, "termination-ready.json")
		const runPhase = async (phase: "prepare" | "recover"): Promise<ExtensionTestRunResult> => {
			if (options.signal?.aborted) throw new Error("Host termination campaign cancelled")
			const runId = `managed-agent-termination-${phase}`
			const timeout = AbortSignal.timeout(150_000)
			const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
			const result = await runExtensionTests({
				signal,
				retainEvidenceForCampaign: true,
				providerMode: "scripted",
				vscodeVersion: options.host.version,
				vscodeExecutablePath: options.host.executable,
				initializeProfile: false,
				profileDir,
				workspace,
				artifactsDir,
				runId,
				scenarioId: "managed-agent-orderly-termination",
				testFile: "managed-agents.termination.test",
				extensionTestsEnv: {
					ALPHA_E2E_TERMINATION_PHASE: phase,
					ALPHA_E2E_TERMINATION_STREAM_URL: streamFixture.url,
					ALPHA_E2E_TERMINATION_PROCESS_COMMAND: processFixtureValue.command,
					ALPHA_E2E_TERMINATION_PROCESS_STATE: processFixtureValue.statePath,
					ALPHA_E2E_TERMINATION_READY_PATH: readyPath,
				},
			})
			report.runs.push(result)
			assert.equal(signal.aborted, false, `${phase} host run exceeded its 150 second bound`)
			assertHostRun(result, options.host.version)
			assert.equal(result.runId, runId)
			assert.equal(result.captureComplete, true)
			await requireHeldRetentionReceipt(result.artifactsDir, runId, result.retentionResultPath)
			return result
		}

		const prepare = await runPhase("prepare")
		report.prepareHostStatus = prepare.status
		assert.equal(hostPidsGone(prepare), true)
		const ready = await readJson(readyPath)
		assert.ok(ready && typeof ready === "object" && !Array.isArray(ready))
		const readyRecord = ready as Record<string, unknown>
		assert.equal(readyRecord.phase, "prepare")
		assert.equal(readyRecord.runId, prepare.runId)
		assert.equal(readyRecord.hostVersion, options.host.version)
		assert.equal(readyRecord.extensionHostPid, prepare.extensionHostPid)
		assert.equal(readyRecord.extensionHostParentPid, prepare.extensionHostParentPid)
		assert.equal(isValidPid(readyRecord.extensionHostPid), true)
		assert.equal(isValidPid(readyRecord.extensionHostParentPid), true)
		assert.equal(readyRecord.providerFetchStartedWithSignal, true)
		assert.equal(readyRecord.streamResponseStarted, true)
		assert.equal(readyRecord.processTreeAlive, true)
		const readyProcessObservation = assertProcessTreeReady(readyRecord.processObservation)
		const workerIds = readyRecord.workerIds
		assert.ok(Array.isArray(workerIds) && workerIds.length === 2)
		report.workerCount = workerIds.length
		await waitFor(() => streamFixture.observation.clientClosed, {
			description: "external stream server to observe the orderly host close",
		})
		await waitFor(
			async () => {
				processObservation = await readProcessTreeObservation(processFixtureValue.statePath)
				return (
					!isProcessAlive(readyProcessObservation.commandPid) &&
					!isProcessAlive(readyProcessObservation.descendantActualPid)
				)
			},
			{ description: "Worker command process tree to terminate after host close" },
		)
		report.streamClientClosed = streamFixture.observation.clientClosed
		report.processTreeDead = true

		const recover = await runPhase("recover")
		report.recoverHostStatus = recover.status
		assert.equal(recover.status, "passed")
		assert.equal(recover.exitCode, 0)
		const recoveryReceipt = await readPhaseReceipt(recover.artifactsDir, "managed-agent-termination-recover.json")
		assert.equal(recoveryReceipt.runId, recover.runId)
		assert.equal(recoveryReceipt.hostVersion, options.host.version)
		assert.equal(recoveryReceipt.extensionHostPid, recover.extensionHostPid)
		assert.equal(recoveryReceipt.extensionHostParentPid, recover.extensionHostParentPid)
		assert.equal(isValidPid(recoveryReceipt.extensionHostPid), true)
		assert.equal(recoveryReceipt.capacityReleased, true)
		assert.equal(recoveryReceipt.terminalResultCount, workerIds.length)
		report.capacityReleased = recoveryReceipt.capacityReleased === true
		report.status = "passed"
	} catch (error) {
		report.status = "failed"
		report.failure = error instanceof Error ? error.message.slice(0, 500) : "host_or_evidence_failure"
	} finally {
		let cleanupFailure: string | undefined
		if (processFixture) {
			try {
				if (!isValidPid(processObservation.commandPid) || !isValidPid(processObservation.descendantActualPid)) {
					processObservation = await readProcessTreeObservation(processFixture.statePath)
				}
				await terminateProcessTree(processObservation)
				if (isValidPid(processObservation.commandPid) && isValidPid(processObservation.descendantActualPid)) {
					await waitFor(
						() =>
							!isProcessAlive(processObservation.commandPid) &&
							!isProcessAlive(processObservation.descendantActualPid),
						{ timeout: 10_000, description: "process fixture cleanup" },
					)
				}
			} catch (error) {
				cleanupFailure = error instanceof Error ? error.message : "process_fixture_cleanup_failed"
			}
		}
		try {
			await stream?.close()
		} catch (error) {
			cleanupFailure ??= error instanceof Error ? error.message : "stream_fixture_cleanup_failed"
		}
		try {
			fixture.controller.dispose()
		} catch (error) {
			cleanupFailure ??= error instanceof Error ? error.message : "fixture_controller_cleanup_failed"
		}
		const hostCleanupVerified =
			report.runs.length > 0 && report.runs.every((result) => result.hostExitObserved && hostPidsGone(result))
		report.cleanupVerified = hostCleanupVerified && cleanupFailure === undefined
		if (cleanupFailure) {
			report.status = "failed"
			report.failure ??= cleanupFailure.slice(0, 500)
		}
		if (!report.cleanupVerified && report.status === "passed") {
			report.status = "failed"
			report.failure ??= "host_or_fixture_cleanup_not_verified"
		}
		await fs.writeFile(
			path.join(fixture.fixtureRoot, "managed-agent-termination-report.json"),
			JSON.stringify(report, null, 2),
			{ flag: "wx", mode: 0o600 },
		)
	}
	return report
}
