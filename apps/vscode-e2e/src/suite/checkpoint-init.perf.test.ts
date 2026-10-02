import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import * as vscode from "vscode"

import type { AlphaMessage } from "@alpha-code/types"

import { waitFor, waitUntilCompleted } from "./utils"

const execFileAsync = promisify(execFile)

type CheckpointServiceProbe = {
	isInitialized: boolean
	baseHash?: string
	saveCheckpoint(description: string): Promise<{ commit?: string } | undefined>
	restoreCheckpoint(commitHash: string): Promise<void>
}

type CheckpointTaskProbe = {
	didComplete: boolean
	taskAsk?: AlphaMessage
	checkpointService?: CheckpointServiceProbe
	waitForTermination(): Promise<void>
}

type CheckpointHostProbe = {
	getLiveTask(taskId: string): CheckpointTaskProbe | undefined
	log(message: string): void
}

class CheckpointProbeAI {
	readonly id = "checkpoint-init-probe"
	private releaseTurn!: () => void
	private readonly turnGate = new Promise<void>((resolve) => {
		this.releaseTurn = resolve
	})

	release() {
		this.releaseTurn()
	}

	async *createMessage(): AsyncGenerator<{ type: "text"; text: string }> {
		await this.turnGate
		yield { type: "text", text: "The checkpoint initialization probe is complete." }
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

	async countTokens(): Promise<number> {
		return 1
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

const parseServiceInitialization = (message: string) => {
	const match = message.match(/initialized shadow repo with base commit .+ in (\d+)ms \((.+)\)$/)
	assert.ok(match, `Checkpoint service initialization log did not include timing phases: ${message}`)
	const duration = match[1]
	const phases = match[2]
	assert.ok(duration && phases, `Checkpoint service timing log was incomplete: ${message}`)
	return { durationMs: Number(duration), phases }
}

const parseNestedGitScan = (message: string, taskId: string) => {
	assert.ok(
		message.includes(`task ${taskId} scan phases:`),
		`Nested Git scan timing belonged to another task: ${message}`,
	)
	const match = message.match(/exclude-pattern discovery (\d+)ms, ripgrep resolution\/process (\d+)ms/)
	assert.ok(match, `Nested Git scan log did not include phase timings: ${message}`)
	const excludePatternDiscoveryMs = match[1]
	const ripgrepResolutionProcessMs = match[2]
	assert.ok(excludePatternDiscoveryMs && ripgrepResolutionProcessMs, `Nested Git scan log was incomplete: ${message}`)
	return {
		excludePatternDiscoveryMs: Number(excludePatternDiscoveryMs),
		ripgrepResolutionProcessMs: Number(ripgrepResolutionProcessMs),
	}
}

suite("Checkpoint initialization on the reference VS Code host", function () {
	this.timeout(180_000)

	test("records task and service latency and verifies save/restore on a disposable workspace", async () => {
		assert.equal(vscode.version, "1.125.0", "This benchmark must run on the reference VS Code host")
		assert.equal(
			process.env.ALPHA_E2E_PROVIDER_MODE,
			"scripted",
			"This benchmark must use the deterministic provider",
		)
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifactsDir)

		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace, "The checkpoint benchmark requires its disposable workspace")
		const workspaceDataset = process.env.ALPHA_CHECKPOINT_BENCHMARK_DATASET ?? "runner fixture"
		const workspaceFileCount = await countWorkspaceFiles(workspace)
		const api = globalThis.api
		const host = (api as unknown as { sidebarProvider: CheckpointHostProbe }).sidebarProvider
		assert.ok(host)
		const originalConfiguration = api.getConfiguration()
		const originalProviderLog = host.log
		const samples: Array<{
			sampleIndex: number
			taskId: string
			taskStartToReadyMs: number
			serviceDurationMs: number
			nestedGitScan: { excludePatternDiscoveryMs: number; ripgrepResolutionProcessMs: number }
			phases: string
		}> = []
		const serviceLogs: string[] = []
		const nestedGitScanLogs: string[] = []
		const verificationDirectory = path.join(workspace, `.alpha-checkpoint-roundtrip-${randomUUID()}`)
		let activeScripted: CheckpointProbeAI | undefined
		let activeTask: CheckpointTaskProbe | undefined
		const gitLookupCommand = process.platform === "win32" ? "where.exe" : "which"
		const { stdout: gitLookupOutput } = await execFileAsync(gitLookupCommand, ["git"])
		const gitExecutablePaths = gitLookupOutput
			.split(/\r?\n/)
			.map((candidate) => candidate.trim())
			.filter(Boolean)
		assert.ok(gitExecutablePaths[0], "The benchmark host must resolve the Git executable")
		const { stdout: gitVersionOutput } = await execFileAsync(gitExecutablePaths[0], ["--version"])

		host.log = function (message: string) {
			if (message.includes("initialized shadow repo with base commit")) serviceLogs.push(message)
			if (message.includes("scan phases: exclude-pattern discovery")) nestedGitScanLogs.push(message)
			originalProviderLog.call(host, message)
		}

		try {
			for (let sampleIndex = 0; sampleIndex < 3; sampleIndex++) {
				const scripted = (activeScripted = new CheckpointProbeAI())
				const previousLogCount = serviceLogs.length
				const previousNestedGitScanLogCount = nestedGitScanLogs.length
				const beganTask = performance.now()
				const taskId = await api.startNewTask({
					text: "Wait for the checkpoint service, then complete the probe.",
					configuration: {
						...originalConfiguration,
						apiProvider: "fake-ai" as const,
						fakeAi: scripted,
						mode: "code",
						autoApprovalEnabled: true,
						approvalMode: "auto",
						requestDelaySeconds: 0,
						writeDelayMs: 0,
						enableCheckpoints: true,
					},
				})

				await waitFor(() => host.getLiveTask(taskId)?.checkpointService?.isInitialized === true, {
					description: `checkpoint service ${sampleIndex + 1} to initialize`,
					timeout: 60_000,
					interval: 20,
				})
				const taskStartToReadyMs = performance.now() - beganTask
				const initLog = serviceLogs.slice(previousLogCount).at(-1)
				assert.ok(initLog, `Checkpoint service ${sampleIndex + 1} did not emit its initialization timing`)
				const nestedGitScanLog = nestedGitScanLogs.slice(previousNestedGitScanLogCount).at(-1)
				assert.ok(
					nestedGitScanLog,
					`Checkpoint service ${sampleIndex + 1} did not emit its nested Git scan timing`,
				)
				const serviceTiming = parseServiceInitialization(initLog)
				samples.push({
					sampleIndex,
					taskId,
					taskStartToReadyMs: Number(taskStartToReadyMs.toFixed(2)),
					serviceDurationMs: serviceTiming.durationMs,
					nestedGitScan: parseNestedGitScan(nestedGitScanLog, taskId),
					phases: serviceTiming.phases,
				})

				if (sampleIndex === 0) {
					const service = host.getLiveTask(taskId)?.checkpointService
					assert.ok(service?.isInitialized)
					await fs.mkdir(verificationDirectory)
					const trackedFile = path.join(verificationDirectory, "tracked.txt")
					const checkpointSentinel = path.join(verificationDirectory, "checkpoint-sentinel.txt")
					const laterSentinel = path.join(verificationDirectory, "later-sentinel.txt")
					await fs.writeFile(trackedFile, "saved tracked content")
					await fs.writeFile(checkpointSentinel, "saved untracked content")
					const checkpoint = await service.saveCheckpoint("Exact-host checkpoint restore probe")
					assert.ok(checkpoint?.commit)

					await fs.writeFile(trackedFile, "changed after checkpoint")
					await fs.writeFile(laterSentinel, "must be removed by restore")
					await service.restoreCheckpoint(checkpoint.commit)
					assert.equal(await fs.readFile(trackedFile, "utf8"), "saved tracked content")
					assert.equal(await fs.readFile(checkpointSentinel, "utf8"), "saved untracked content")
					await assert.rejects(fs.access(laterSentinel))
				}

				const task = (activeTask = host.getLiveTask(taskId)!)
				assert.ok(task)
				const completion = waitUntilCompleted({ api, taskId })
				scripted.release()
				await completion
				assert.equal(task.didComplete, true)
				assert.notEqual(
					task.taskAsk?.ask,
					"completion_result",
					"Completion must finalize without acknowledgement",
				)
				await task.waitForTermination()
				await api.clearCurrentTask()
				activeTask = undefined
				activeScripted = undefined
			}

			const serviceDurations = samples.map(({ serviceDurationMs }) => serviceDurationMs).sort((a, b) => a - b)
			const report = {
				schemaVersion: 1,
				hostVersion: vscode.version,
				extensionHostNode: process.versions.node,
				provider: "scripted",
				git: {
					executablePath: gitExecutablePaths[0],
					resolvedPaths: gitExecutablePaths,
					version: gitVersionOutput.trim(),
					initArgs: ["--template", ""],
					config: [
						"core.ignorestat=false",
						"core.splitIndex=false",
						"commit.gpgSign=false",
						"user.name=Alpha",
						"user.email=noreply@example.com",
					],
				},
				workspaceDataset,
				workspaceFileCount,
				samples,
				medianServiceDurationMs: serviceDurations[Math.floor(serviceDurations.length / 2)],
				measurementBoundary:
					"Task start to checkpoint readiness includes task startup and service initialization. Service duration, setup phases, and the nested Git scan breakdown are emitted by ShadowCheckpointService. The ripgrep phase includes binary resolution and the child process. VS Code process launch and extension activation are excluded.",
				restoreVerification:
					"saved tracked and untracked files restored; post-checkpoint untracked file removed",
			}
			await fs.writeFile(path.join(artifactsDir, "checkpoint-init-perf.json"), JSON.stringify(report, null, 2), {
				flag: "wx",
			})
			console.log(`[checkpoint-init-perf] ${JSON.stringify(report)}`)
		} finally {
			host.log = originalProviderLog
			activeScripted?.release()
			if (activeTask) {
				await waitFor(() => activeTask?.didComplete === true, {
					description: "the active checkpoint probe to finalize completion",
					timeout: 30_000,
				}).catch(() => undefined)
				await activeTask.waitForTermination().catch(() => undefined)
			}
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(originalConfiguration).catch(() => undefined)
			await fs.rm(verificationDirectory, { recursive: true, force: true })
		}
	})
})

async function countWorkspaceFiles(root: string): Promise<number> {
	let count = 0
	const directories = [root]
	while (directories.length > 0) {
		const directory = directories.pop()!
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) directories.push(path.join(directory, entry.name))
			else if (entry.isFile()) count++
		}
	}
	return count
}
