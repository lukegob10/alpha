import * as assert from "assert"

import { RooCodeEventName, type RooCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const CANONICAL_MODE_SLUGS = ["architect", "code", "ask", "debug", "orchestrator"]

type ScriptChunk =
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

class ModeSwitchScriptedAI {
	readonly id = "mode-switch-e2e"
	removeFromCache?: () => void
	readonly requestedTaskIds: string[] = []
	private turn = 0
	private releaseInitialRequest: (() => void) | undefined
	private readonly initialRequestGate = new Promise<void>((resolve) => {
		this.releaseInitialRequest = resolve
	})

	allowModeSwitches(): void {
		this.releaseInitialRequest?.()
		this.releaseInitialRequest = undefined
	}

	async *createMessage(
		_systemPrompt: string,
		_messages: unknown[],
		metadata?: { taskId?: string },
	): AsyncGenerator<ScriptChunk> {
		if (!metadata?.taskId) throw new Error("Scripted mode-switch E2E request is missing metadata.taskId")
		this.requestedTaskIds.push(metadata.taskId)

		if (this.turn === 0) {
			await this.initialRequestGate
		}

		const calls = [
			{
				name: "switch_mode",
				arguments: { mode_slug: "architect", reason: "Enter the canonical planning mode." },
			},
			{ name: "switch_mode", arguments: { mode_slug: "code", reason: "Return to implementation mode." } },
			{ name: "attempt_completion", arguments: { result: "Mode switch verified." } },
		]
		const call = calls[this.turn++]
		if (!call) throw new Error(`Unexpected scripted mode-switch turn ${this.turn}`)

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
				taskAsk?: { ask?: string }
				approveAsk(): void
				getTaskApiConfigName(): Promise<string | undefined>
				getTaskMode(): Promise<string>
		  }
		| undefined
	setTaskMode(
		taskId: string,
		mode: string,
		options?: { postState?: boolean; applyModeProfile?: boolean },
	): Promise<void>
	getStateToPostToWebview(): Promise<{ currentTaskId?: string; mode?: string }>
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

	test("switches Code to Plan and back in one task and provider configuration", async () => {
		const provider = getHostProvider()
		const completedTaskIds = new Set<string>()
		const switchedModes: Array<{ taskId: string; mode: string }> = []
		let taskId: string | undefined
		let scriptedAI: ModeSwitchScriptedAI | undefined
		const onTaskCompleted = (completedTaskId: string) => completedTaskIds.add(completedTaskId)
		const onModeSwitched = (switchedTaskId: string, mode: string) => {
			switchedModes.push({ taskId: switchedTaskId, mode })
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
				text: "Plan this task, return to Code, and complete without opening a new task.",
			})

			await waitFor(() => scriptedAI!.requestedTaskIds.length === 1, { timeout: 30_000, interval: 25 })
			const initialTask = provider.getLiveTask(taskId)
			assert.ok(initialTask, "The mode-switch task was not registered with the extension host")
			const initialApi = initialTask.api
			const initialApiConfiguration = initialTask.apiConfiguration
			const initialApiConfigName = await initialTask.getTaskApiConfigName()
			assert.equal(await initialTask.getTaskMode(), "code")
			assert.equal(initialApiConfiguration.apiProvider, "fake-ai")
			assert.strictEqual(initialApiConfiguration.fakeAi, scriptedAI)

			scriptedAI.allowModeSwitches()

			await waitFor(
				() =>
					completedTaskIds.has(taskId!) ||
					provider.getLiveTask(taskId!)?.taskAsk?.ask === "completion_result",
				{ timeout: 30_000, interval: 25 },
			)
			if (!completedTaskIds.has(taskId)) {
				const task = provider.getLiveTask(taskId)
				assert.ok(task, "The mode-switch task disappeared before completion could be accepted")
				task.approveAsk()
			}
			await waitFor(() => completedTaskIds.has(taskId!), { timeout: 30_000, interval: 25 })

			assert.deepStrictEqual(
				switchedModes.filter((event) => event.taskId === taskId).map((event) => event.mode),
				["architect", "code"],
			)
			assert.deepStrictEqual(scriptedAI.requestedTaskIds, [taskId, taskId, taskId])
			const completedTask = provider.getLiveTask(taskId)
			assert.strictEqual(completedTask, initialTask)
			assert.strictEqual(completedTask.api, initialApi)
			assert.strictEqual(completedTask.apiConfiguration, initialApiConfiguration)
			assert.equal(await completedTask.getTaskApiConfigName(), initialApiConfigName)
			assert.equal(await completedTask.getTaskMode(), "code")
			const state = await provider.getStateToPostToWebview()
			assert.equal(state.currentTaskId, taskId)
			assert.equal(state.mode, "code")
		} finally {
			scriptedAI?.allowModeSwitches()
			globalThis.api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
			globalThis.api.off(RooCodeEventName.TaskModeSwitched, onModeSwitched)
			await globalThis.api.clearCurrentTask().catch(() => undefined)
		}
	})
})
