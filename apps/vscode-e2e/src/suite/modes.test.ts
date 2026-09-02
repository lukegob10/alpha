import * as assert from "assert"

import { RooCodeEventName, type RooCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const CANONICAL_MODE_SLUGS = ["architect", "code", "ask", "debug", "orchestrator"]

type ScriptChunk =
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

interface ModeSwitchRuntime {
	initialRequestGate: Promise<void>
	releaseInitialRequest?: () => void
	removeFromCache?: () => void
}

const modeSwitchRuntimes = new WeakMap<object, ModeSwitchRuntime>()

class ModeSwitchScriptedAI {
	readonly id = "mode-switch-e2e"
	readonly dispatchedToolNames: string[] = []
	readonly requestedTaskIds: string[] = []
	private turn = 0

	constructor() {
		let releaseInitialRequest: (() => void) | undefined
		const initialRequestGate = new Promise<void>((resolve) => {
			releaseInitialRequest = resolve
		})
		modeSwitchRuntimes.set(this, { initialRequestGate, releaseInitialRequest })
	}

	get removeFromCache(): (() => void) | undefined {
		return modeSwitchRuntimes.get(this)?.removeFromCache
	}

	set removeFromCache(value: (() => void) | undefined) {
		const runtime = modeSwitchRuntimes.get(this)
		if (runtime) runtime.removeFromCache = value
	}

	allowModeSwitches(): void {
		const runtime = modeSwitchRuntimes.get(this)
		runtime?.releaseInitialRequest?.()
		if (runtime) runtime.releaseInitialRequest = undefined
	}

	async *createMessage(
		_systemPrompt: string,
		_messages: unknown[],
		metadata?: { taskId?: string },
	): AsyncGenerator<ScriptChunk> {
		if (!metadata?.taskId) throw new Error("Scripted mode-switch E2E request is missing metadata.taskId")
		this.requestedTaskIds.push(metadata.taskId)

		if (this.turn === 0) {
			await modeSwitchRuntimes.get(this)?.initialRequestGate
		}

		const calls = [
			{
				name: "switch_mode",
				arguments: { mode_slug: "architect", reason: "Enter the canonical planning mode." },
			},
			{
				name: "attempt_completion",
				arguments: { result: "<proposed_plan>\nMode switch verified.\n</proposed_plan>" },
			},
			{
				name: "attempt_completion",
				arguments: { result: "Returned to Code and continued in the same task." },
			},
		]
		const call = calls[this.turn++]
		if (!call) throw new Error(`Unexpected scripted mode-switch turn ${this.turn}`)
		this.dispatchedToolNames.push(call.name)

		yield {
			type: "tool_call",
			id: `mode-switch-e2e-${metadata.taskId}-${this.turn}`,
			name: call.name,
			arguments: JSON.stringify(call.arguments),
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: "mode-switch-scripted-e2e",
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

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

interface ModeHostProvider {
	getModes(): Promise<Array<{ slug: string; name: string }>>
	getLiveTask(taskId: string):
		| {
				api: unknown
				apiConfiguration: RooCodeSettings
				abort?: boolean
				clineMessages?: Array<{ ask?: string; say?: string; text?: string; partial?: boolean }>
				didComplete?: boolean
				isInitialized?: boolean
				isStreaming?: boolean
				isTaskLoopActive?: boolean
				isWaitingForFirstChunk?: boolean
				off(eventName: string | symbol, listener: (taskId: string, mode: string) => void): void
				on(eventName: string | symbol, listener: (taskId: string, mode: string) => void): void
				taskAsk?: { ask?: string }
				approveAsk(): void
				getTaskApiConfigName(): Promise<string | undefined>
				getTaskMode(): Promise<string>
				resumeCompletedTaskFollowup(text: string, images?: string[]): Promise<void>
		  }
		| undefined
	setTaskMode(
		taskId: string,
		mode: string,
		options?: { postState?: boolean; applyModeProfile?: boolean },
	): Promise<void>
	getStateToPostToWebview(): Promise<{ currentTaskId?: string; mode?: string }>
}

const getTaskStartupDiagnostics = async (provider: ModeHostProvider, taskId: string) => {
	const task = provider.getLiveTask(taskId)
	const state = await provider.getStateToPostToWebview()

	return {
		taskId,
		currentTaskId: state.currentTaskId,
		mode: state.mode,
		liveTaskFound: Boolean(task),
		isInitialized: task?.isInitialized,
		isTaskLoopActive: task?.isTaskLoopActive,
		isWaitingForFirstChunk: task?.isWaitingForFirstChunk,
		isStreaming: task?.isStreaming,
		didComplete: task?.didComplete,
		abort: task?.abort,
		askAsk: task?.taskAsk?.ask,
		transcriptTail: task?.clineMessages?.slice(-5).map(({ ask, say, text, partial }) => ({
			askMessage: ask ?? say,
			partial,
			text: text?.slice(0, 500),
		})),
	}
}

const getHostProvider = (): ModeHostProvider => {
	const provider = (globalThis.api as unknown as { sidebarProvider?: ModeHostProvider }).sidebarProvider
	assert.ok(provider, "The extension API did not expose its host provider to the extension-host test")
	return provider
}

suite("Alpha Modes", function () {
	setDefaultSuiteTimeout(this)

	test("defaults to Code and keeps architect-backed Plan plus legacy modes loadable", async () => {
		const provider = getHostProvider()
		const switchedModes: string[] = []
		let taskId: string | undefined
		const onModeSwitched = (switchedTaskId: string, mode: string) => {
			if (switchedTaskId === taskId) switchedModes.push(mode)
		}

		globalThis.api.on(RooCodeEventName.TaskModeSwitched, onModeSwitched)

		try {
			const registeredModes = await provider.getModes()
			assert.deepStrictEqual(
				registeredModes.map(({ slug }) => slug),
				CANONICAL_MODE_SLUGS,
			)
			assert.ok(registeredModes.some(({ slug }) => slug === "architect"))
			assert.ok(!registeredModes.some(({ slug }) => slug === "plan"))

			const initialState = await provider.getStateToPostToWebview()
			assert.equal(initialState.currentTaskId, undefined)
			assert.equal(initialState.mode, "code")

			taskId = await globalThis.api.startNewTask({
				configuration: {
					...globalThis.api.getConfiguration(),
					autoApprovalEnabled: true,
				},
			})
			const task = provider.getLiveTask(taskId)
			assert.ok(task, "The default-mode task was not registered with the extension host")
			assert.equal(await task.getTaskMode(), "code")

			for (const mode of CANONICAL_MODE_SLUGS) {
				await provider.setTaskMode(taskId, mode, { applyModeProfile: false })
				assert.equal(await task.getTaskMode(), mode)
			}

			assert.deepStrictEqual(switchedModes, CANONICAL_MODE_SLUGS)
			const state = await provider.getStateToPostToWebview()
			assert.equal(state.currentTaskId, taskId)
			assert.equal(state.mode, "orchestrator")
		} finally {
			globalThis.api.off(RooCodeEventName.TaskModeSwitched, onModeSwitched)
			await globalThis.api.clearCurrentTask().catch(() => undefined)
		}
	})

	test("keeps one task and provider when the model plans and the user returns to Code", async () => {
		const provider = getHostProvider()
		const completedTaskIds: string[] = []
		const switchedModes: Array<{ taskId: string; mode: string }> = []
		const localSwitchedModes: string[] = []
		let taskId: string | undefined
		let initialTask: ReturnType<ModeHostProvider["getLiveTask"]>
		let scriptedAI: ModeSwitchScriptedAI | undefined
		const onTaskCompleted = (completedTaskId: string) => completedTaskIds.push(completedTaskId)
		const onModeSwitched = (switchedTaskId: string, mode: string) => {
			switchedModes.push({ taskId: switchedTaskId, mode })
		}
		const onLocalModeSwitched = (switchedTaskId: string, mode: string) => {
			if (switchedTaskId === taskId) localSwitchedModes.push(mode)
		}

		globalThis.api.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
		globalThis.api.on(RooCodeEventName.TaskModeSwitched, onModeSwitched)

		try {
			scriptedAI = new ModeSwitchScriptedAI()
			const configuration: RooCodeSettings = {
				...globalThis.api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: scriptedAI,
				mode: "code",
				autoApprovalEnabled: true,
				alwaysAllowModeSwitch: true,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}

			taskId = await globalThis.api.startNewTask({
				configuration,
				text: "Plan this task, let me return it to Code, and continue without opening a new task.",
			})

			await waitFor(() => scriptedAI!.requestedTaskIds.length === 1, {
				timeout: 30_000,
				interval: 25,
				description: "the first scripted provider request",
				onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
			})
			initialTask = provider.getLiveTask(taskId)
			assert.ok(initialTask, "The mode-switch task was not registered with the extension host")
			initialTask.on(RooCodeEventName.TaskModeSwitched, onLocalModeSwitched)
			const initialApi = initialTask.api
			const initialApiConfiguration = initialTask.apiConfiguration
			const initialApiConfigName = await initialTask.getTaskApiConfigName()
			assert.equal(await initialTask.getTaskMode(), "code")
			assert.equal(initialApiConfiguration.apiProvider, "fake-ai")
			assert.strictEqual(initialApiConfiguration.fakeAi, scriptedAI)

			scriptedAI.allowModeSwitches()

			await waitFor(() => scriptedAI!.requestedTaskIds.length === 2, {
				timeout: 30_000,
				interval: 25,
				description: "the Architect plan request",
				onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
			})
			await waitFor(
				() =>
					completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length >= 1 ||
					provider.getLiveTask(taskId!)?.taskAsk?.ask === "completion_result",
				{
					timeout: 30_000,
					interval: 25,
					description: "the scripted mode-switch task to reach its completion boundary",
					onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
				},
			)
			assert.equal(await initialTask.getTaskMode(), "architect")
			assert.deepStrictEqual(scriptedAI.dispatchedToolNames, ["switch_mode", "attempt_completion"])
			if (completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length < 1) {
				const task = provider.getLiveTask(taskId)
				assert.ok(task, "The mode-switch task disappeared before completion could be accepted")
				task.approveAsk()
			}
			await waitFor(() => completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length >= 1, {
				timeout: 30_000,
				interval: 25,
				description: "the accepted Architect plan to complete",
				onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
			})

			const completedTask = provider.getLiveTask(taskId)
			assert.ok(completedTask, "The completed Architect task was not retained")
			assert.strictEqual(completedTask, initialTask)
			assert.strictEqual(completedTask.api, initialApi)
			assert.strictEqual(completedTask.apiConfiguration, initialApiConfiguration)
			assert.equal(await completedTask.getTaskApiConfigName(), initialApiConfigName)

			// Plan mode deliberately cannot dispatch switch_mode. Returning to Code is
			// an explicit host/user transition, after which the completed task resumes.
			await provider.setTaskMode(taskId, "code", { applyModeProfile: false })
			assert.equal(await completedTask.getTaskMode(), "code")
			await completedTask.resumeCompletedTaskFollowup("Continue this retained task in Code.")
			await waitFor(() => scriptedAI!.requestedTaskIds.length === 3, {
				timeout: 30_000,
				interval: 25,
				description: "the same-task Code continuation request",
				onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
			})
			await waitFor(
				() =>
					completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length >= 2 ||
					provider.getLiveTask(taskId!)?.taskAsk?.ask === "completion_result",
				{
					timeout: 30_000,
					interval: 25,
					description: "the retained Code task completion boundary",
					onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
				},
			)
			if (completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length < 2) {
				provider.getLiveTask(taskId)?.approveAsk()
			}
			await waitFor(() => completedTaskIds.filter((completedTaskId) => completedTaskId === taskId).length >= 2, {
				timeout: 30_000,
				interval: 25,
				description: "the retained Code task to complete",
				onTimeout: () => getTaskStartupDiagnostics(provider, taskId!),
			})

			assert.deepStrictEqual(scriptedAI.requestedTaskIds, [taskId, taskId, taskId])
			assert.deepStrictEqual(scriptedAI.dispatchedToolNames, [
				"switch_mode",
				"attempt_completion",
				"attempt_completion",
			])
			assert.deepStrictEqual(
				switchedModes.filter((event) => event.taskId === taskId).map((event) => event.mode),
				["architect", "code"],
			)
			assert.deepStrictEqual(localSwitchedModes, ["architect", "code"])
			assert.strictEqual(provider.getLiveTask(taskId), initialTask)
			assert.strictEqual(initialTask.api, initialApi)
			assert.strictEqual(initialTask.apiConfiguration, initialApiConfiguration)
			const state = await provider.getStateToPostToWebview()
			assert.equal(state.currentTaskId, taskId)
			assert.equal(state.mode, "code")
		} finally {
			scriptedAI?.allowModeSwitches()
			initialTask?.off(RooCodeEventName.TaskModeSwitched, onLocalModeSwitched)
			globalThis.api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
			globalThis.api.off(RooCodeEventName.TaskModeSwitched, onModeSwitched)
			await globalThis.api.clearCurrentTask().catch(() => undefined)
		}
	})
})
