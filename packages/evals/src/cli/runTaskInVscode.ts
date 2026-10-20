import * as fs from "fs"
import * as path from "path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"

import pWaitFor from "p-wait-for"
import { execa } from "execa"

import {
	type AlphaSay,
	type ToolUsage,
	TaskCommandName,
	AlphaCodeEventName,
	IpcMessageType,
	EVALS_SETTINGS,
	type ExecutionIdentity,
	type TokenUsage,
	type TaskEvent,
	openAiModelInfoSaneDefaults,
} from "@alpha-code/types"
import { IpcClient } from "@alpha-code/ipc"

import { updateTask, createTaskMetrics, updateTaskMetrics, createToolError } from "../db/index"
import { EVALS_REPO_PATH, getTaskWorkspacePath } from "../exercises/index"

import { type PresentationModelCallPolicy, type RunTaskOptions } from "./types"
import { isDockerContainer, copyConversationHistory, mergeToolUsage, waitForSubprocessWithTimeout } from "./utils"
import {
	evaluatorIpcEndpoint,
	requireVscodeExecutablePath,
	vscodeLaunch,
	type IsolatedVscodeLaunch,
} from "./vscodeLaunch"
import { MessageLogDeduper } from "./messageLogDeduper"
import { readExecutionIdentity } from "../../../../src/extension/executionIdentity"

type BenchmarkHost = IsolatedVscodeLaunch & {
	profileRoot: string
	expectedIdentity: ExecutionIdentity
	assertRunnerAncestry: (runnerPid: number, currentPid: number) => Promise<void>
	assertProfileOwnership: () => Promise<void>
}

async function prepareBenchmarkHost(): Promise<BenchmarkHost> {
	const selectedExecutable = requireVscodeExecutablePath(process.env.VSCODE_EXECUTABLE_PATH)
	const executablePath = await fs.promises.realpath(selectedExecutable)
	if (!(await fs.promises.lstat(executablePath)).isFile()) throw new Error("Benchmark host is not an executable file")
	// These existing test adapters are local-source tooling; the container image owns its installed host/profile.
	// Keep the literal imports typechecked without requiring apps/ to be present in that image.
	let adapters: [
		typeof import("../../../../apps/vscode-e2e/src/testProfile"),
		typeof import("../../../../apps/vscode-e2e/src/hostOwnership"),
	]
	try {
		adapters = await Promise.all([
			import("../../../../apps/vscode-e2e/src/testProfile"),
			import("../../../../apps/vscode-e2e/src/hostOwnership"),
		])
	} catch (cause) {
		throw new Error("Local benchmarks require the complete Alpha source checkout and its VS Code test adapters", {
			cause,
		})
	}
	const [{ prepareTestProfile, assertOwnedTestRoot }, { assertRunnerAncestry }] = adapters
	const extensionDevelopmentPath = await fs.promises.realpath(
		fileURLToPath(new URL("../../../../src", import.meta.url)),
	)
	const expectedIdentity = await readExecutionIdentity(extensionDevelopmentPath, "1.138.0")
	const profile = await prepareTestProfile({ vscodeVersion: "1.138.0" })
	if (!profile.temporaryRoot) throw new Error("The benchmark test adapter did not create an owned temporary profile")
	const profileRoot = profile.temporaryRoot
	const sharedDataDir = path.join(profileRoot, "shared-data")
	await fs.promises.mkdir(sharedDataDir)
	return {
		executablePath,
		extensionDevelopmentPath,
		userDataDir: profile.userDataDir,
		extensionsDir: profile.extensionsDir,
		sharedDataDir,
		profileRoot,
		expectedIdentity,
		assertRunnerAncestry,
		assertProfileOwnership: () => assertOwnedTestRoot(profileRoot, "temporary"),
	}
}

async function assertOwnedHistory(host: BenchmarkHost, storageRoot: string, taskId: string): Promise<void> {
	await host.assertProfileOwnership()
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid benchmark history task identity")
	const root = await fs.promises.realpath(host.profileRoot)
	const taskRoot = path.join(storageRoot, "tasks", taskId)
	const relative = path.relative(host.profileRoot, taskRoot)
	if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("Benchmark history must remain inside the owned profile")
	let current = host.profileRoot
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component)
		const stat = await fs.promises.lstat(current)
		if (stat.isSymbolicLink()) throw new Error("Benchmark history must not follow symlinks")
		const resolved = path.relative(root, await fs.promises.realpath(current))
		if (!resolved || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved))
			throw new Error("Benchmark history resolved outside the owned profile")
	}
	for (const filename of ["api_conversation_history.json", "ui_messages.json", "agent_turn_events.jsonl"]) {
		try {
			const file = path.join(taskRoot, filename)
			const stat = await fs.promises.lstat(file)
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Benchmark history must contain regular files")
			const resolved = path.relative(root, await fs.promises.realpath(file))
			if (resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved))
				throw new Error("Benchmark history file resolved outside the owned profile")
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
		}
	}
}

function governedCostSettings(run: RunTaskOptions["run"]) {
	if (typeof run.campaignHardCapUsd !== "number") return undefined
	const reservation = run.taskCostCapUsd
	if (typeof reservation !== "number" || !Number.isFinite(reservation) || reservation <= 0)
		throw new Error("Governed evaluation requires a positive finite task cost reservation")
	const configured = run.settings?.allowedMaxCost
	const limit =
		typeof configured === "number" && Number.isFinite(configured) && configured > 0
			? Math.min(configured, reservation)
			: reservation
	if (run.settings?.apiProvider !== "openai" || !run.model?.trim() || run.settings.openAiModelId !== run.model)
		throw new Error("Governed evaluation requires the configured OpenAI model to match the run identity")
	const requirePrice = (name: string, value: number | null | undefined): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`Governed evaluation requires known finite nonnegative ${name}`)
		return value
	}
	const pricing = {
		inputPrice: requirePrice("inputPrice", run.inputPrice),
		outputPrice: requirePrice("outputPrice", run.outputPrice),
		cacheReadsPrice: requirePrice("cacheReadsPrice", run.cacheReadsPrice),
		cacheWritesPrice: requirePrice("cacheWritesPrice", run.cacheWritesPrice),
	}
	return {
		allowedMaxCost: limit,
		openAiCustomModelInfo: {
			...openAiModelInfoSaneDefaults,
			...run.settings.openAiCustomModelInfo,
			...pricing,
		},
	}
}

export const runTaskInVscode = async ({
	run,
	task,
	publish,
	logger,
	jobToken,
	workspaceRoot,
	onExecutionIdentity,
}: RunTaskOptions) => {
	const controller = new AbortController()
	let client: IpcClient | undefined
	let subprocess: ReturnType<typeof execa> | undefined
	let retainHistory: (() => Promise<void>) | undefined
	let benchmarkHost: BenchmarkHost | undefined
	const costSettings = governedCostSettings(run)
	let presentationPolicy: PresentationModelCallPolicy | undefined
	let latestObservedCost: number | undefined
	let costCancellationSent = false
	let costBudgetExceeded = false
	let costAccountingFailure: Error | undefined
	let hostExitObserved = false
	let alphaTaskId: string | undefined
	let finishEventEffects: (() => Promise<void>) | undefined
	let eventEffectsUncertain = false
	let observedRuntimeCount = 0
	const processState: { failure?: { error: unknown } } = {}
	const throwIfProcessFailed = () => {
		if (processState.failure) throw processState.failure.error
	}
	let failure: { error: unknown } | undefined
	let outcome: "agent_error" | "budget_exhausted" | "cancelled" | "completed" = "completed"
	try {
		const { language, exercise } = task
		const workspacePath = workspaceRoot ?? getTaskWorkspacePath(task)
		const taskPromptPath = path.join(workspacePath, "prompt.md")
		const prompt = fs.readFileSync(
			fs.existsSync(taskPromptPath) ? taskPromptPath : path.resolve(EVALS_REPO_PATH, `prompts/${language}.md`),
			"utf-8",
		)
		const containerized = isDockerContainer()
		if (!containerized && task.benchmarkTaskIdentity) benchmarkHost = await prepareBenchmarkHost()
		const ipcSocketPath = evaluatorIpcEndpoint(
			run.id,
			task.id,
			process.platform,
			benchmarkHost ? randomBytes(8).toString("hex") : undefined,
		)
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			ROO_CODE_IPC_SOCKET_PATH: ipcSocketPath,
		}
		if (jobToken) env.ROO_CODE_CLOUD_TOKEN = jobToken
		const cancelSignal = controller.signal
		const logDir = containerized
			? `/var/log/evals/runs/${run.id}`
			: path.join(os.tmpdir(), "evals", "runs", String(run.id))

		const launch = vscodeLaunch(workspacePath, containerized, process.platform, benchmarkHost)
		logger.info(`launching ${launch.command}`)

		// Sleep for a random amount of time between 5 and 10 seconds, unless we're
		// running in a container, in which case there are no issues with flooding
		// VSCode with new windows.
		if (!containerized && !benchmarkHost) {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 5_000 + 5_000))
		}

		if (benchmarkHost) {
			delete env.ELECTRON_RUN_AS_NODE
			delete env.VSCODE_IPC_HOOK_CLI
			delete env.VSCODE_PORTABLE
			logger.info(`retaining isolated benchmark profile -> ${benchmarkHost.profileRoot}`)
		}
		subprocess = execa(launch.command, launch.args, { env, extendEnv: false, cancelSignal, shell: false })
		// Observe rejection immediately, before startup sleeps or IPC polling attach another await.
		void subprocess.catch((error: unknown) => {
			processState.failure ??= { error }
		})

		// If debugging, add `--verbose` to `command` and uncomment the following line.
		// subprocess.stdout.pipe(process.stdout)

		// Give VSCode some time to spawn before connecting to its unix socket.
		await new Promise((resolve) => setTimeout(resolve, 3_000))
		throwIfProcessFailed()
		let attempts = 5

		while (true) {
			try {
				client = new IpcClient(ipcSocketPath)
				await pWaitFor(() => client!.isReady, { interval: 250, timeout: 1_000 })
				break
			} catch (_error) {
				const disconnected = client
				client = undefined
				disconnected?.disconnect()
				throwIfProcessFailed()
				attempts--

				if (attempts <= 0) {
					logger.error(`unable to connect to IPC socket -> ${ipcSocketPath}`)
					throw new Error("Unable to connect.")
				}
			}
		}

		let taskStartedAt = Date.now()
		if ((task.benchmarkTaskIdentity || costSettings) && !client.executionIdentity)
			throw new Error("Executed harness identity unavailable; refusing a paid benchmark request")
		if (costSettings && client.capabilities?.targetedTaskCancellation !== true)
			throw new Error("Governed evaluation requires verified targeted task cancellation support")
		if (costSettings) {
			if (client.capabilities?.presentationModelCallOptOut !== true)
				throw new Error("Governed evaluation requires verified presentation model call opt-out support")
			presentationPolicy = { schemaVersion: 1, presentationModelCalls: false, presentationModelCallOptOut: true }
		}
		if (client.executionIdentity) {
			if (client.executionIdentity.hostVersion !== "1.138.0")
				throw new Error("Evaluator requires exact VS Code 1.138.0")
			if (benchmarkHost) {
				if (!client.serverProcess) throw new Error("Benchmark host process identity is unavailable")
				await benchmarkHost.assertRunnerAncestry(process.pid, client.serverProcess.pid)
				const actual = client.executionIdentity
				const expected = benchmarkHost.expectedIdentity
				if (
					actual.extensionId !== expected.extensionId ||
					actual.extensionVersion !== expected.extensionVersion ||
					actual.entrypointDigest !== expected.entrypointDigest ||
					actual.manifestDigest !== expected.manifestDigest
				)
					throw new Error("Executed benchmark host does not match the current extension source build")
			}
			await fs.promises.writeFile(
				`${logger.path}${task.benchmarkTaskIdentity ? `.task-${task.id}` : ""}.execution.json`,
				JSON.stringify({
					...client.executionIdentity,
					serverProcess: client.serverProcess ?? null,
					observedAt: new Date().toISOString(),
					runnerImageId: process.env.EVALS_RUNNER_IMAGE_ID ?? null,
					...(costSettings
						? {
								governance: {
									targetedTaskCancellation: true,
									...presentationPolicy,
									observedCostLimitUsd: costSettings.allowedMaxCost,
									campaignAdmissionLimitUsd: run.campaignHardCapUsd,
									inFlightResponseMayOvershoot: true,
									pricingBasis: "configured-run-prices",
									pricing: {
										inputPrice: costSettings.openAiCustomModelInfo.inputPrice,
										outputPrice: costSettings.openAiCustomModelInfo.outputPrice,
										cacheReadsPrice: costSettings.openAiCustomModelInfo.cacheReadsPrice,
										cacheWritesPrice: costSettings.openAiCustomModelInfo.cacheWritesPrice,
									},
								},
							}
						: {}),
					...(benchmarkHost
						? {
								ownershipGate: "verified",
								executablePath: benchmarkHost.executablePath,
								profileRoot: benchmarkHost.profileRoot,
								userDataDir: benchmarkHost.userDataDir,
								extensionsDir: benchmarkHost.extensionsDir,
								sharedDataDir: benchmarkHost.sharedDataDir,
								extensionDevelopmentPath: benchmarkHost.extensionDevelopmentPath,
								ipcSocketPath,
							}
						: {}),
				}) + "\n",
				{ mode: 0o600 },
			)
			if (presentationPolicy) await onExecutionIdentity?.(client.executionIdentity, presentationPolicy)
			else await onExecutionIdentity?.(client.executionIdentity)
		}
		let taskFinishedAt: number | undefined
		let taskAbortedAt: number | undefined
		let taskTimedOut: boolean = false
		let taskMetricsId: number | undefined
		let isClientDisconnected = false
		let rootStarted = false
		const timeoutMs = (run.timeout || 5) * 60 * 1_000
		const effectsDeadline = Date.now() + timeoutMs
		const runtimeUsage = new Map<string, { usage?: TokenUsage; tools: ToolUsage; terminal: boolean }>()
		const cancelRoot = () => {
			if (costCancellationSent || isClientDisconnected) return
			if (costSettings && !alphaTaskId) return
			costCancellationSent = true
			client!.sendCommand({
				commandName: TaskCommandName.CancelTask,
				...(costSettings && alphaTaskId ? { data: { taskId: alphaTaskId } } : {}),
			})
		}
		let effectsAccepting = true
		let pendingEffects = 0
		let eventTail = Promise.resolve()
		const failEffects = (error: unknown) => {
			processState.failure ??= { error }
			effectsAccepting = false
			try {
				cancelRoot()
			} catch {
				// Preserve the write/protocol failure; owned subprocess cleanup remains mandatory.
			}
		}
		const effectOwnerClosed = () => controller.signal.aborted || Boolean(processState.failure)
		const aggregateUsage = (): { usage: TokenUsage; tools: ToolUsage } => {
			const usage: TokenUsage = {
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: 0,
				totalCacheReads: 0,
				contextTokens: alphaTaskId ? (runtimeUsage.get(alphaTaskId)?.usage?.contextTokens ?? 0) : 0,
			}
			const tools: ToolUsage = {}
			for (const runtime of runtimeUsage.values()) {
				if (runtime.usage) {
					usage.totalCost += runtime.usage.totalCost
					usage.totalTokensIn += runtime.usage.totalTokensIn
					usage.totalTokensOut += runtime.usage.totalTokensOut
					usage.totalCacheWrites = (usage.totalCacheWrites ?? 0) + (runtime.usage.totalCacheWrites ?? 0)
					usage.totalCacheReads = (usage.totalCacheReads ?? 0) + (runtime.usage.totalCacheReads ?? 0)
				}
				for (const [name, count] of Object.entries(runtime.tools)) {
					const key = name as keyof ToolUsage
					const previous = tools[key]
					tools[key] = {
						attempts: (previous?.attempts ?? 0) + count.attempts,
						failures: (previous?.failures ?? 0) + count.failures,
					}
				}
			}
			return { usage, tools }
		}
		const observeEvent = (event: TaskEvent) => {
			const { eventName, payload } = event
			if (eventName === AlphaCodeEventName.TaskCreated || eventName === AlphaCodeEventName.TaskStarted) {
				const id = payload[0]
				// The fresh owned host accepts one benchmark root. Bind it before the first awaited effect.
				if (!alphaTaskId) {
					alphaTaskId = id
					const historyTaskId = id
					const host = benchmarkHost
					const extensionId = client!.executionIdentity?.extensionId
					if (containerized || host) {
						let storageRoot: string | undefined
						if (host) {
							if (!extensionId || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(extensionId))
								throw new Error("Invalid verified extension identity for benchmark history")
							storageRoot = path.join(
								host.userDataDir,
								"User",
								"globalStorage",
								extensionId.toLowerCase(),
							)
						}
						retainHistory = async () => {
							if (host && storageRoot) await assertOwnedHistory(host, storageRoot, historyTaskId)
							await copyConversationHistory({
								alphaTaskId: historyTaskId,
								logDir,
								language,
								exercise,
								iteration: task.iteration,
								logger,
								...(storageRoot ? { storageRoot } : {}),
							})
						}
					}
				}
				const runtime = runtimeUsage.get(id)
				if (!runtime) {
					if (runtimeUsage.size >= 256) throw new Error("Evaluator runtime identity bound exceeded")
					runtimeUsage.set(id, { tools: {}, terminal: false })
					observedRuntimeCount = runtimeUsage.size
				} else if (eventName === AlphaCodeEventName.TaskStarted) runtime.terminal = false
			}
			if (
				eventName === AlphaCodeEventName.TaskTokenUsageUpdated ||
				eventName === AlphaCodeEventName.TaskCompleted
			) {
				const runtime = runtimeUsage.get(payload[0])
				if (!runtime) throw new Error("Evaluator received usage before its runtime identity was started")
				const next = payload[1]
				if (
					!next ||
					typeof next.totalCost !== "number" ||
					!Number.isFinite(next.totalCost) ||
					next.totalCost < 0
				)
					throw (costAccountingFailure ??= new Error(
						"Governed evaluation received unavailable or invalid actual cost",
					))
				const previous = runtime.usage
				runtime.usage = {
					...next,
					totalCost: Math.max(previous?.totalCost ?? 0, next.totalCost),
					totalTokensIn: Math.max(previous?.totalTokensIn ?? 0, next.totalTokensIn),
					totalTokensOut: Math.max(previous?.totalTokensOut ?? 0, next.totalTokensOut),
					totalCacheReads: Math.max(previous?.totalCacheReads ?? 0, next.totalCacheReads ?? 0),
					totalCacheWrites: Math.max(previous?.totalCacheWrites ?? 0, next.totalCacheWrites ?? 0),
				}
				mergeToolUsage(runtime.tools, payload[2] ?? {})
				const aggregate = aggregateUsage()
				latestObservedCost = aggregate.usage.totalCost
				if (eventName === AlphaCodeEventName.TaskCompleted) {
					if (payload[0] === alphaTaskId && payload[3].isSubtask)
						throw new Error("Evaluator root completion was marked as a subtask")
					runtime.terminal = true
					if (
						costSettings &&
						payload[0] === alphaTaskId &&
						[...runtimeUsage.values()].some((runtime) => !runtime.terminal || !runtime.usage)
					)
						throw (costAccountingFailure ??= new Error(
							"Governed evaluation ended with unsettled child usage",
						))
				}
				if (
					costSettings &&
					eventName === AlphaCodeEventName.TaskTokenUsageUpdated &&
					latestObservedCost >= costSettings.allowedMaxCost
				) {
					costBudgetExceeded = true
					cancelRoot()
				}
				return aggregate
			}
			if (eventName === AlphaCodeEventName.TaskAborted) {
				const runtime = runtimeUsage.get(payload[0])
				if (costSettings && !runtime?.usage)
					throw (costAccountingFailure ??= new Error(
						"Governed evaluation ended without observed actual cost",
					))
				if (runtime) runtime.terminal = true
			}
			if (
				costSettings &&
				eventName === AlphaCodeEventName.TaskAborted &&
				payload[0] === alphaTaskId &&
				[...runtimeUsage.values()].some((runtime) => !runtime.terminal || !runtime.usage)
			)
				throw (costAccountingFailure ??= new Error("Governed evaluation ended with unsettled child usage"))
			return undefined
		}
		finishEventEffects = async () => {
			effectsAccepting = false
			if (!pendingEffects) return
			if (controller.signal.aborted) {
				eventEffectsUncertain = true
				return
			}
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer)
					controller.signal.removeEventListener("abort", aborted)
				}
				const aborted = () => {
					eventEffectsUncertain = true
					cleanup()
					reject(new Error("Evaluator event effects cancelled before settlement"))
				}
				const timer = setTimeout(
					() => {
						eventEffectsUncertain = true
						cleanup()
						reject(new Error("Evaluator event effects exceeded the existing task deadline"))
					},
					Math.max(0, effectsDeadline - Date.now()),
				)
				controller.signal.addEventListener("abort", aborted, { once: true })
				void eventTail.then(
					() => {
						cleanup()
						resolve()
					},
					(error) => {
						cleanup()
						reject(error)
					},
				)
			})
		}

		const ignoreEvents: Record<"broadcast" | "log", AlphaCodeEventName[]> = {
			broadcast: [AlphaCodeEventName.Message],
			log: [AlphaCodeEventName.TaskTokenUsageUpdated, AlphaCodeEventName.TaskAskResponded],
		}

		const loggableSays: AlphaSay[] = [
			"error",
			"command_output",
			"rooignore_error",
			"diff_error",
			"condense_context",
			"condense_context_error",
			"api_req_rate_limit_wait",
			"api_req_retry_delayed",
			"api_req_retried",
		]

		let isApiUnstable = false
		const messageLogDeduper = new MessageLogDeduper()

		const processEvent = async (taskEvent: TaskEvent, snapshot: ReturnType<typeof aggregateUsage> | undefined) => {
			if (effectOwnerClosed()) return
			const { eventName, payload } = taskEvent

			if (
				eventName === AlphaCodeEventName.Message &&
				payload[0].message.say &&
				["api_req_retry_delayed", "api_req_retried"].includes(payload[0].message.say)
			) {
				isApiUnstable = true
			}

			// Publish all events except for these to Redis.
			if (!ignoreEvents.broadcast.includes(eventName)) {
				await publish({ ...taskEvent, taskId: task.id })
				if (effectOwnerClosed()) return
			}

			// Log all events except for these.
			// For message events we only log non-partial messages.
			if (
				!ignoreEvents.log.includes(eventName) &&
				(eventName !== AlphaCodeEventName.Message ||
					(payload[0].message.say && loggableSays.includes(payload[0].message.say)) ||
					payload[0].message.partial !== true)
			) {
				// Dedupe identical repeated message events (same message.ts + same payload)
				if (eventName === AlphaCodeEventName.Message) {
					const action = payload[0]?.action as string | undefined
					const message = payload[0]?.message
					if (!messageLogDeduper.shouldLog(action, message)) {
						return
					}
				}

				// Extract tool name for tool-related messages for clearer logging
				let logEventName: string = eventName
				if (eventName === AlphaCodeEventName.Message && payload[0]?.message?.ask === "tool") {
					try {
						const textJson = JSON.parse(payload[0].message.text ?? "{}")
						if (textJson.tool) {
							logEventName = `${eventName} (tool: ${textJson.tool})`
						}
					} catch {
						// If parsing fails, use the default event name
					}
				} else if (eventName === AlphaCodeEventName.Message && payload[0]?.message?.ask === "command") {
					logEventName = `${eventName} (command)`
				} else if (
					eventName === AlphaCodeEventName.Message &&
					payload[0]?.message?.ask === "completion_result"
				) {
					logEventName = `${eventName} (completion_result)`
				}
				logger.info(`${logEventName} ->`, payload)
			}

			if (eventName === AlphaCodeEventName.TaskStarted && payload[0] === alphaTaskId && !rootStarted) {
				rootStarted = true
				taskStartedAt = Date.now()

				const taskMetrics = await createTaskMetrics({
					cost: 0,
					tokensIn: 0,
					tokensOut: 0,
					tokensContext: 0,
					duration: 0,
					cacheWrites: 0,
					cacheReads: 0,
				})
				if (effectOwnerClosed()) return

				await updateTask(task.id, { taskMetricsId: taskMetrics.id, startedAt: new Date() })
				if (effectOwnerClosed()) return

				taskStartedAt = Date.now()
				taskMetricsId = taskMetrics.id
			}

			if (eventName === AlphaCodeEventName.TaskToolFailed) {
				const [_taskId, toolName, error] = payload
				await createToolError({ taskId: task.id, toolName, error })
				if (effectOwnerClosed()) return
			}

			if (
				eventName === AlphaCodeEventName.TaskTokenUsageUpdated ||
				eventName === AlphaCodeEventName.TaskCompleted
			) {
				if (!taskMetricsId || !snapshot) throw new Error("Evaluator usage has no root metrics owner")

				const duration = Date.now() - taskStartedAt

				const { totalCost, totalTokensIn, totalTokensOut, contextTokens, totalCacheWrites, totalCacheReads } =
					snapshot.usage

				await updateTaskMetrics(taskMetricsId, {
					cost: totalCost,
					tokensIn: totalTokensIn,
					tokensOut: totalTokensOut,
					tokensContext: contextTokens,
					duration,
					cacheWrites: totalCacheWrites ?? 0,
					cacheReads: totalCacheReads ?? 0,
					toolUsage: snapshot.tools,
				})
				if (effectOwnerClosed()) return
			}

			if (eventName === AlphaCodeEventName.TaskAborted && payload[0] === alphaTaskId) {
				taskAbortedAt = Date.now()
			}

			if (eventName === AlphaCodeEventName.TaskCompleted && payload[0] === alphaTaskId) {
				taskFinishedAt = Date.now()
			}
		}

		client.on(IpcMessageType.TaskEvent, (taskEvent) => {
			if (!effectsAccepting || effectOwnerClosed()) return eventTail
			try {
				// EventEmitter does not await listeners. Capture identity/usage immediately, then own ordered effects.
				if (pendingEffects >= 1024) throw new Error("Evaluator event effect queue bound exceeded")
				const snapshot = observeEvent(taskEvent)
				pendingEffects++
				eventTail = eventTail
					.then(() => processEvent(taskEvent, snapshot))
					.catch(failEffects)
					.finally(() => {
						pendingEffects--
					})
			} catch (error) {
				failEffects(error)
			}
			return eventTail
		})

		client.on(IpcMessageType.Disconnect, () => {
			logger.info(`disconnected from IPC socket -> ${ipcSocketPath}`)
			isClientDisconnected = true
		})

		client.sendCommand({
			commandName: TaskCommandName.StartNewTask,
			data: {
				...(presentationPolicy ? { presentationModelCalls: presentationPolicy.presentationModelCalls } : {}),
				configuration: {
					...EVALS_SETTINGS,
					openAiApiKey: process.env.OPENAI_API_KEY,
					openAiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
					...run.settings, // Allow the provided settings to override the default connection settings.
					...costSettings,
				},
				text: prompt,
			},
		})

		try {
			await pWaitFor(
				() => !!taskFinishedAt || !!taskAbortedAt || isClientDisconnected || !!processState.failure,
				{
					interval: 1_000,
					timeout: timeoutMs,
				},
			)
		} catch (_error) {
			taskTimedOut = true
			logger.error("time limit reached")

			if (alphaTaskId && !isClientDisconnected) {
				logger.info("cancelling task")
				cancelRoot()
				await new Promise((resolve) => setTimeout(resolve, 5_000)) // Allow some time for the task to cancel.
			}

			taskFinishedAt = Date.now()
		}

		throwIfProcessFailed()
		if (costAccountingFailure) throw costAccountingFailure
		if (costSettings && taskTimedOut)
			throw new Error("Governed evaluation did not reach a terminal event before timeout")
		await finishEventEffects()
		throwIfProcessFailed()
		if (!taskFinishedAt && !taskTimedOut && !taskAbortedAt) {
			logger.error("client disconnected before task finished")
			throw new Error("Client disconnected before task completion.")
		}
		if (costSettings && latestObservedCost === undefined) {
			costAccountingFailure = new Error("Governed evaluation ended without observed actual cost")
			throw costAccountingFailure
		}

		// Execution completion precedes the separate grading/trial-finalization boundary in processTask.
		logger.info("setting task finished at")
		await updateTask(task.id, { finishedAt: new Date() })

		if (alphaTaskId && !isClientDisconnected) {
			logger.info("closing task")
			client.sendCommand({ commandName: TaskCommandName.CloseTask })
			await new Promise((resolve) => setTimeout(resolve, 2_000)) // Allow some time for the window to close.
		}

		// Only throw for API instability if the task didn't complete successfully.
		// If taskFinishedAt is set via TaskCompleted event, the task succeeded despite
		// API retries, so re-running from scratch would waste resources.
		if (isApiUnstable && !taskFinishedAt) {
			throw new Error("API is unstable, throwing to trigger a retry.")
		}

		outcome = costBudgetExceeded
			? "budget_exhausted"
			: taskTimedOut
				? "agent_error"
				: taskAbortedAt
					? "cancelled"
					: "completed"
	} catch (error) {
		failure = { error }
	} finally {
		if (failure) controller.abort()
		try {
			await finishEventEffects?.()
		} catch (error) {
			failure ??= { error }
			controller.abort()
		}
		try {
			client?.disconnect()
		} catch (error) {
			failure ??= { error }
		} finally {
			try {
				// A successful isolated benchmark closes its own window through IPC; observe normal close before aborting.
				if (!benchmarkHost || failure || outcome !== "completed") controller.abort()
				if (subprocess) {
					await waitForSubprocessWithTimeout({ subprocess, logger })
					hostExitObserved = true
				}
			} catch (error) {
				// Abort-induced Execa rejection is expected during owned cleanup.
				if (!(error && typeof error === "object" && "isCanceled" in error && error.isCanceled === true)) {
					failure ??= { error }
				}
			} finally {
				controller.abort()
				try {
					await retainHistory?.()
				} catch (error) {
					failure ??= { error }
				}
			}
		}
	}
	if (costSettings && subprocess) {
		try {
			await fs.promises.writeFile(
				`${logger.path}.task-${task.id}.cost.json`,
				JSON.stringify({
					schemaVersion: 1,
					taskId: task.id,
					observedCostLimitUsd: costSettings.allowedMaxCost,
					latestObservedCostUsd: latestObservedCost ?? null,
					costBudgetExceeded,
					costCancellationSent,
					costAccountingFailed: Boolean(costAccountingFailure),
					rootTaskId: alphaTaskId ?? null,
					observedRuntimeCount,
					presentationModelCallPolicy: presentationPolicy ?? null,
					eventEffectsUncertain,
					hostExitObserved,
					inFlightResponseMayOvershoot: true,
				}) + "\n",
				{ mode: 0o600 },
			)
		} catch (error) {
			failure ??= { error }
		}
	}
	if (failure) throw failure.error
	return outcome
}
