import type {
	ApprovalMode,
	HistoryItem,
	ProviderSettings,
	TaskReasoningPreference,
	TaskReasoningProjection,
} from "@alpha-code/types"
import { openAiModelInfoSaneDefaults } from "@alpha-code/types"

import { buildApiHandler } from "../../../api"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { Task } from "../../task/Task"

const providerTestState = vi.hoisted(() => ({
	constructedTaskOptions: [] as Array<Record<string, any>>,
	nextTaskId: 0,
}))

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: { joinPath: vi.fn(), file: vi.fn() },
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn(), update: vi.fn() }),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: { uriScheme: "vscode", language: "en", appName: "Visual Studio Code" },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	ConfigurationTarget: { Global: 1 },
	version: "1.125.0",
}))

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options: Record<string, any>) {
		providerTestState.constructedTaskOptions.push(options)
		const task = {
			taskId: options.historyItem?.id ?? options.taskId ?? `created-${++providerTestState.nextTaskId}`,
			instanceId: `instance-${providerTestState.nextTaskId}`,
			taskKind: "primary",
			alphaMessages: [],
			parentTask: options.parentTask,
			rootTask: options.rootTask,
			reasoningPreference: options.reasoningPreference ??
				options.historyItem?.reasoningPreference ?? { kind: "default" },
			apiConfiguration: options.apiConfiguration,
			start: vi.fn(),
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			setTaskApiConfigName: vi.fn(),
		}
		return task
	}),
	getSubagentAllowedToolNames: vi.fn(() => undefined),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: vi.fn(() => ({
			id: "reasoning-model",
			info: { supportsReasoningEffort: ["low", "medium", "high"] },
		})),
		prepareModel: vi.fn(),
		dispose: vi.fn(),
	})),
}))

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn(() => true),
		createInstance: vi.fn(),
		get instance() {
			return { trackEvent: vi.fn(), trackError: vi.fn(), setProvider: vi.fn(), captureModeSwitch: vi.fn() }
		},
	},
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{ slug: "code", name: "Code", roleDefinition: "code", groups: ["read", "edit"] },
		{ slug: "architect", name: "Architect", roleDefinition: "architect", groups: ["read", "edit"] },
	],
	getModeBySlug: vi.fn(() => ({ slug: "code", name: "Code", roleDefinition: "code", groups: ["read", "edit"] })),
	getAllModes: vi.fn(() => []),
	defaultModeSlug: "code",
	planModeSlug: "architect",
}))

vi.mock("../../prompts/sections/custom-instructions")
vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn(), codeMode: "code" }))
vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return { getName: () => "test", applyDiff: vi.fn() }
	}),
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return { initializeFilePaths: vi.fn(), dispose: vi.fn() }
	}),
}))
vi.mock("../../../api/providers/fetchers/modelCache", () => ({ getModels: vi.fn(), flushModels: vi.fn() }))
vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../utils/safeWriteJson")
vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("delay", () => {
	const delay = () => Promise.resolve()
	return { default: delay }
})

type FakeTask = {
	taskId: string
	abort: boolean
	abandoned: boolean
	reasoningPreference: TaskReasoningPreference
	apiConfiguration: ProviderSettings
	updateReasoningPreference: import("vitest").Mock
	getReasoningState: import("vitest").Mock
	setTaskApprovalMode: import("vitest").Mock
	getTaskApprovalMode: import("vitest").Mock
}

const baseConfiguration: ProviderSettings = {
	apiProvider: "openai",
	openAiModelId: "reasoning-model",
	reasoningEffort: "medium",
}

function projection(taskId: string, preference: TaskReasoningPreference): TaskReasoningProjection {
	const effective = preference.kind === "effort" ? preference : { kind: "default" as const }
	return {
		taskId,
		requested: preference,
		effective,
		capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
	}
}

function fakeTask(taskId: string, preference: TaskReasoningPreference = { kind: "default" }): FakeTask {
	let approvalMode: ApprovalMode = "auto"
	const task = {
		taskId,
		abort: false,
		abandoned: false,
		reasoningPreference: preference,
		apiConfiguration: { ...baseConfiguration },
		updateReasoningPreference: vi.fn(async (next: TaskReasoningPreference) => {
			task.reasoningPreference = next
		}),
		getReasoningState: vi.fn(() => projection(taskId, task.reasoningPreference)),
		setTaskApprovalMode: vi.fn((next: ApprovalMode) => {
			approvalMode = next
			return true
		}),
		getTaskApprovalMode: vi.fn(() => approvalMode),
	}
	return task
}

function providerHarness(tasks: FakeTask[] = [], composer: TaskReasoningPreference = { kind: "default" }) {
	const state: Record<string, any> = {
		mode: "code",
		currentApiConfigName: "base-profile",
		newTaskReasoningPreference: composer,
		apiConfiguration: { ...baseConfiguration },
		enableCheckpoints: true,
		checkpointTimeout: 30,
		experiments: {},
	}
	const taskMap = new Map(tasks.map((task) => [task.taskId, task]))
	const contextProxy = {
		getValue: vi.fn((key: string) => state[key]),
		getValues: vi.fn(() => ({ ...state })),
		setValue: vi.fn(async (key: string, value: unknown) => {
			state[key] = value
		}),
		setValues: vi.fn(async (values: Record<string, unknown>) => Object.assign(state, values)),
		setProviderSettings: vi.fn(async (settings: ProviderSettings) => Object.assign(state, settings)),
	}
	const provider = Object.create(AlphaProvider.prototype) as AlphaProvider & Record<string, any>
	const taskSessions = new TaskSessionRegistry()
	Object.assign(provider, {
		contextProxy,
		taskStack: tasks,
		newTaskDraftMode: "code",
		context: { secrets: {}, workspaceState: { get: vi.fn(() => undefined) } },
		getLiveTask: vi.fn((taskId: string) => taskMap.get(taskId)),
		getCurrentTask: vi.fn(() => tasks[0]),
		getProviderSettingsSnapshot: vi.fn(() => ({ ...state.apiConfiguration })),
		getReasoningProjection: vi.fn(async (task?: FakeTask) =>
			task ? task.getReasoningState() : projection("composer", state.newTaskReasoningPreference),
		),
		postStateToWebview: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		removeTaskFromStack: vi.fn(async () => undefined),
		addTaskToStack: vi.fn(async (task: Task, options: { focus?: boolean } = {}) => {
			taskSessions.register(task, options)
		}),
		updateGlobalState: vi.fn(async (key: string, value: unknown) => {
			state[key] = value
		}),
		setValues: vi.fn(async (values: Record<string, unknown>) => Object.assign(state, values)),
		log: vi.fn(),
		taskSessions,
		taskCreationCallback: vi.fn(),
		agentControlStore: { retryPendingMailboxClaimSettlements: vi.fn(async () => undefined) },
		getState: vi.fn(async () => ({
			apiConfiguration: { ...baseConfiguration },
			enableCheckpoints: true,
			checkpointTimeout: 30,
			experiments: {},
		})),
		providerSettingsManager: {
			getAvailableProfile: vi.fn(async () => undefined),
			listConfig: vi.fn(async () => []),
			getModeConfigId: vi.fn(async () => undefined),
			getProfile: vi.fn(async () => ({ ...baseConfiguration })),
		},
	})
	for (const task of tasks) taskSessions.register(task as unknown as Task)
	return { provider, contextProxy, state, taskMap }
}

function resetTaskConstructor() {
	providerTestState.constructedTaskOptions.length = 0
	providerTestState.nextTaskId = 0
	vi.mocked(Task).mockClear()
}

describe("AlphaProvider reasoning preference boundaries", () => {
	beforeEach(() => {
		resetTaskConstructor()
	})

	it("serializes repeated increases using the saved level while retaining task identity", async () => {
		const first = fakeTask("first", { kind: "effort", effort: "low" })
		const second = fakeTask("second", { kind: "effort", effort: "low" })
		const { provider, contextProxy } = providerHarness([first, second])
		let finish!: () => void
		let started!: () => void
		const writing = new Promise<void>((resolve) => {
			started = resolve
		})
		first.updateReasoningPreference.mockImplementationOnce(async (preference: TaskReasoningPreference) => {
			started()
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			first.reasoningPreference = preference
		})
		const increase = provider.adjustTaskReasoningEffort("first", 1)
		const increaseAgain = provider.adjustTaskReasoningEffort("first", 1)
		await writing
		expect(first.updateReasoningPreference).toHaveBeenCalledTimes(1)
		finish()
		await Promise.all([increase, increaseAgain])
		expect(first.updateReasoningPreference.mock.calls).toEqual([
			[{ kind: "effort", effort: "medium" }],
			[{ kind: "effort", effort: "high" }],
		])
		expect(second.updateReasoningPreference).not.toHaveBeenCalled()
		expect(contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("does not persist an increase past the maximum and advances the blank composer's preference", async () => {
		const task = fakeTask("first", { kind: "effort", effort: "high" })
		const { provider, state } = providerHarness([task], { kind: "effort", effort: "low" })
		await provider.adjustTaskReasoningEffort("first", 1)
		expect(task.updateReasoningPreference).not.toHaveBeenCalled()
		await provider.adjustTaskReasoningEffort(undefined, 1)
		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "medium" })
		expect(task.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
	})

	it("projects VS Code LM reasoning without waiting for model selection", async () => {
		const prepareModel = vi.fn(() => new Promise<void>(() => undefined))
		vi.mocked(buildApiHandler).mockReturnValueOnce({
			getModel: vi.fn(() => ({
				id: "copilot/gpt-5.6-luna",
				info: { supportsReasoningEffort: ["low", "medium", "high"] },
			})),
			prepareModel,
			dispose: vi.fn(),
		} as never)
		const { provider } = providerHarness()

		const pending = (AlphaProvider.prototype as any).resolveReasoningCapabilities.call(
			provider,
			{ apiProvider: "vscode-lm", vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-5.6-luna" } },
			{ kind: "default" },
		)

		expect(prepareModel).not.toHaveBeenCalled()
		const result = await pending
		expect(result.capabilities).toEqual({
			kind: "effort",
			efforts: ["low", "medium", "high"],
			canDisable: true,
		})
	})

	it.each([
		{ provider: "openai-native", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
		{ provider: "openai-codex", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
		{ provider: "bedrock", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
		{ provider: "meta", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
		{ provider: "anthropic", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
		{ provider: "gemini", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
		{ provider: "xai", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
		{ provider: "openrouter", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
	] as const)(
		"projects bundled $provider reasoning without constructing a provider",
		async ({ provider: apiProvider, efforts, defaultEffort }) => {
			const { provider, state, contextProxy } = providerHarness()
			state.apiConfiguration = { apiProvider }
			vi.mocked(buildApiHandler).mockClear()

			const result = await provider.getReasoningCapabilities()

			expect(result).toMatchObject({
				requested: { kind: "default" },
				effective: { kind: "effort", effort: defaultEffort },
				capabilities: { kind: "effort", efforts, canDisable: false },
			})
			expect(buildApiHandler).not.toHaveBeenCalled()
			expect(contextProxy.setValue).not.toHaveBeenCalled()
		},
	)

	it("uses the configured native model instead of another provider's custom capabilities", async () => {
		const { provider, state, contextProxy } = providerHarness()
		const configuration: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-fable-5-1",
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsReasoningEffort: ["low"] },
		}
		state.apiConfiguration = configuration

		const result = await provider.getReasoningCapabilities(undefined, { kind: "effort", effort: "max" })

		expect(result).toMatchObject({
			requested: { kind: "effort", effort: "max" },
			effective: { kind: "effort", effort: "max" },
			capabilities: { kind: "effort", efforts: ["low", "medium", "high", "xhigh", "max"], canDisable: false },
		})
		expect(configuration.reasoningEffort).toBeUndefined()
		expect(contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("retains the legacy OpenRouter model selection when previewing reasoning", async () => {
		const { provider, state } = providerHarness()
		state.apiConfiguration = {
			apiProvider: "openrouter",
			openRouterModelId: "google/gemini-4-argon",
		}

		const result = await provider.getReasoningCapabilities(undefined, { kind: "effort", effort: "high" })

		expect(result).toMatchObject({
			effective: { kind: "effort", effort: "high" },
			capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: false },
		})
	})

	it.each(["removed-model", "__proto__", "constructor"])(
		"does not assign default or stale custom capabilities to unknown curated model %s",
		async (apiModelId) => {
			const { provider, state } = providerHarness()
			state.apiConfiguration = {
				apiProvider: "openai-native",
				apiModelId,
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsReasoningEffort: ["low", "high"] },
			}

			const result = await provider.getReasoningCapabilities(undefined, { kind: "effort", effort: "high" })

			expect(result).toMatchObject({
				requested: { kind: "effort", effort: "high" },
				effective: { kind: "off" },
				capabilities: { kind: "unavailable" },
				fallbackReason: "unavailable",
			})
		},
	)

	it.each(["low", "high"] as const)(
		"keeps a live Copilot task's resolved %s state instead of replacing it with an unavailable preview",
		async (effort) => {
			const task = fakeTask("task-a", { kind: "effort", effort })
			task.apiConfiguration = {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", id: "opaque-provider-model-id" },
			}
			const accepted = projection(task.taskId, task.reasoningPreference)
			task.getReasoningState.mockReturnValue(accepted)
			const { provider } = providerHarness([task])
			const preview = vi.spyOn(provider, "resolveReasoningCapabilities").mockResolvedValue({
				requested: task.reasoningPreference,
				effective: { kind: "off" },
				capabilities: { kind: "unavailable", canDisable: false },
				fallbackReason: "unavailable",
			})

			const result = await (AlphaProvider.prototype as any).getReasoningProjection.call(provider, task)

			expect(result).toEqual(accepted)
			expect(preview).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])(
		"preserves the task-owned Copilot projection without a second capability resolution (pending: %s)",
		async (pending) => {
			const task = fakeTask("task-a", { kind: "effort", effort: "high" })
			task.apiConfiguration = { apiProvider: "vscode-lm" }
			const { taskId: _taskId, ...selected } = projection(task.taskId, task.reasoningPreference)
			const current = {
				...selected,
				effective: { kind: "effort" as const, effort: pending ? ("low" as const) : ("high" as const) },
			}
			const accepted = {
				...selected,
				taskId: task.taskId,
				current,
				pending,
			}
			task.getReasoningState.mockReturnValue(accepted)
			const { provider } = providerHarness([task])
			const refreshed = {
				...current,
				effective: { kind: "effort" as const, effort: "low" as const },
			}
			const preview = vi.spyOn(provider, "resolveReasoningCapabilities").mockResolvedValue(refreshed)

			const result = await (AlphaProvider.prototype as any).getReasoningProjection.call(provider, task)

			expect(result).toEqual(accepted)
			expect(preview).not.toHaveBeenCalled()
		},
	)

	it("keeps a rehydrating task's identity and saved preference in its catalog projection", async () => {
		const task = fakeTask("task-a", { kind: "effort", effort: "high" })
		task.apiConfiguration = { apiProvider: "openai-native", apiModelId: "gpt-5.6-sol" }
		task.getReasoningState.mockReturnValue(undefined)
		const { provider } = providerHarness([task], { kind: "effort", effort: "low" })

		const result = await (AlphaProvider.prototype as any).getReasoningProjection.call(provider, task)

		expect(result).toMatchObject({
			taskId: task.taskId,
			requested: { kind: "effort", effort: "high" },
			effective: { kind: "effort", effort: "high" },
			capabilities: { kind: "effort" },
		})
	})

	it("serializes task reasoning changes behind an in-flight provider profile write", async () => {
		const task = fakeTask("task-a")
		const { provider } = providerHarness([task])
		const events: string[] = []
		let releaseProfile!: () => void
		const profileReady = new Promise<void>((resolve) => {
			releaseProfile = resolve
		})
		;(provider as any).setTaskProviderProfileWithinQueue = vi.fn(async () => {
			events.push("profile:start")
			await profileReady
			events.push("profile:end")
		})
		task.updateReasoningPreference.mockImplementation(async () => {
			events.push("reasoning")
		})

		const profilePromise = provider.setTaskProviderProfile("task-a", "profile-b", baseConfiguration)
		await Promise.resolve()
		const reasoningPromise = provider.setTaskReasoningPreference("task-a", { kind: "effort", effort: "high" })
		await Promise.resolve()

		expect(events).toEqual(["profile:start"])
		expect(task.updateReasoningPreference).not.toHaveBeenCalled()
		releaseProfile()
		await Promise.all([profilePromise, reasoningPromise])

		expect(events).toEqual(["profile:start", "profile:end", "reasoning"])
	})

	it("keeps task lanes isolated and leaves the composer preference independent", async () => {
		const first = fakeTask("task-a")
		const second = fakeTask("task-b")
		const { provider, contextProxy, state } = providerHarness([first, second], { kind: "effort", effort: "low" })

		await Promise.all([
			provider.setTaskReasoningPreference("task-a", { kind: "effort", effort: "high" }),
			provider.setTaskReasoningPreference("task-b", { kind: "off" }),
		])

		expect(first.updateReasoningPreference).toHaveBeenCalledWith({ kind: "effort", effort: "high" })
		expect(second.updateReasoningPreference).toHaveBeenCalledWith({ kind: "off" })
		expect(contextProxy.setValue).not.toHaveBeenCalled()
		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "low" })
	})

	it("updates the default composer preference without changing an existing task", async () => {
		const task = fakeTask("task-a", { kind: "effort", effort: "high" })
		const { provider, state } = providerHarness([task])

		const stateProjection = await provider.setTaskReasoningPreference(undefined, { kind: "effort", effort: "low" })

		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "low" })
		expect(task.updateReasoningPreference).not.toHaveBeenCalled()
		expect(stateProjection).toMatchObject({ requested: { kind: "effort", effort: "low" } })
	})

	it("remembers a task preference when the caller explicitly requests composer persistence", async () => {
		const task = fakeTask("task-a")
		const { provider, contextProxy, state } = providerHarness([task], { kind: "effort", effort: "low" })

		await provider.setTaskReasoningPreference(
			"task-a",
			{ kind: "effort", effort: "high" },
			{ rememberForNewTasks: true },
		)

		expect(contextProxy.setValue).toHaveBeenCalledOnce()
		expect(contextProxy.setValue).toHaveBeenCalledWith("newTaskReasoningPreference", {
			kind: "effort",
			effort: "high",
		})
		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "high" })
	})

	it("routes approval changes to one task and leaves other task policy and saved defaults alone", () => {
		const first = fakeTask("task-a")
		const second = fakeTask("task-b")
		const { provider, contextProxy } = providerHarness([first, second])
		vi.spyOn(provider, "canAcceptTaskInput").mockReturnValue(true)

		const result = provider.updateTaskApprovalMode({
			requestId: "approval-a",
			taskId: "task-a",
			approvalMode: "ask",
		})

		expect(result).toEqual({
			requestId: "approval-a",
			taskId: "task-a",
			status: "applied",
			approvalMode: "ask",
		})
		expect(first.setTaskApprovalMode).toHaveBeenCalledWith("ask")
		expect(second.setTaskApprovalMode).not.toHaveBeenCalled()
		expect(first.getTaskApprovalMode()).toBe("ask")
		expect(second.getTaskApprovalMode()).toBe("auto")
		expect(contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("reports an unavailable target without applying the mode to another task", () => {
		const second = fakeTask("task-b")
		const { provider } = providerHarness([second])
		vi.spyOn(provider, "canAcceptTaskInput").mockReturnValue(true)

		const result = provider.updateTaskApprovalMode({
			requestId: "approval-missing",
			taskId: "missing-task",
			approvalMode: "bypass",
		})

		expect(result).toEqual({ requestId: "approval-missing", taskId: "missing-task", status: "targetUnavailable" })
		expect(second.setTaskApprovalMode).not.toHaveBeenCalled()
	})

	it("rejects a task that can no longer accept a mode change", () => {
		const task = fakeTask("task-a")
		const { provider } = providerHarness([task])
		vi.spyOn(provider, "canAcceptTaskInput").mockReturnValue(false)

		const result = provider.updateTaskApprovalMode({
			requestId: "approval-terminal",
			taskId: "task-a",
			approvalMode: "ask",
		})

		expect(result).toEqual({ requestId: "approval-terminal", taskId: "task-a", status: "targetUnavailable" })
		expect(task.setTaskApprovalMode).not.toHaveBeenCalled()
	})

	it("returns notMutable when the task rejects the update", () => {
		const task = fakeTask("task-a")
		task.setTaskApprovalMode.mockReturnValue(false)
		const { provider } = providerHarness([task])
		vi.spyOn(provider, "canAcceptTaskInput").mockReturnValue(true)

		const result = provider.updateTaskApprovalMode({
			requestId: "approval-rejected",
			taskId: "task-a",
			approvalMode: "ask",
		})

		expect(result).toEqual({
			requestId: "approval-rejected",
			taskId: "task-a",
			status: "rejected",
			error: "notMutable",
		})
	})

	it("retains the composer preference when a task update fails", async () => {
		const task = fakeTask("task-a", { kind: "effort", effort: "low" })
		const { provider, state, contextProxy } = providerHarness([task], { kind: "effort", effort: "medium" })
		task.updateReasoningPreference.mockRejectedValueOnce(new Error("save failed"))

		await expect(
			provider.setTaskReasoningPreference(
				"task-a",
				{ kind: "effort", effort: "high" },
				{ rememberForNewTasks: true },
			),
		).rejects.toThrow("save failed")
		expect(contextProxy.setValue.mock.calls).toEqual([
			["newTaskReasoningPreference", { kind: "effort", effort: "high" }],
			["newTaskReasoningPreference", { kind: "effort", effort: "medium" }],
		])
		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "medium" })
		expect(task.reasoningPreference).toEqual({ kind: "effort", effort: "low" })
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("does not change the task when remembering the composer choice fails", async () => {
		const task = fakeTask("task-a", { kind: "effort", effort: "low" })
		const { provider, contextProxy, state } = providerHarness([task], { kind: "effort", effort: "medium" })
		contextProxy.setValue.mockRejectedValueOnce(new Error("composer save failed"))

		await expect(
			provider.setTaskReasoningPreference("task-a", { kind: "default" }, { rememberForNewTasks: true }),
		).rejects.toThrow("composer save failed")

		expect(task.updateReasoningPreference).not.toHaveBeenCalled()
		expect(state.newTaskReasoningPreference).toEqual({ kind: "effort", effort: "medium" })
		expect(task.reasoningPreference).toEqual({ kind: "effort", effort: "low" })
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("keeps ten default root admissions live and preserves explicit replacement", async () => {
		const { provider } = providerHarness()
		const sessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
		sessions.setMaxLiveTasks(10)
		vi.spyOn(provider as any, "finalizeActiveCompletionCandidate").mockResolvedValue(undefined)
		const tasks = await Promise.all(Array.from({ length: 10 }, (_, index) => provider.createTask(`Work ${index}`)))

		expect(sessions.getLiveTaskCount()).toBe(10)
		expect(new Set(tasks.map((task) => task.taskId)).size).toBe(10)
		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
		for (const task of tasks) expect(task.start).toHaveBeenCalledOnce()
		await expect(provider.createTask("Over capacity")).rejects.toThrow("Maximum live task limit reached (10)")
		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()

		const replacement = providerHarness()
		await replacement.provider.createTask("Explicit replacement", undefined, undefined, { preserveExisting: false })
		expect(replacement.provider.removeTaskFromStack).toHaveBeenCalledOnce()
	})

	it("snapshots the composer preference for a new task and the parent preference for a child", async () => {
		const { provider } = providerHarness([], { kind: "effort", effort: "medium" })
		const parent = fakeTask("parent", { kind: "effort", effort: "high" })
		await provider.createTask("root", undefined, undefined, { startTask: false })
		await provider.createTask("child", undefined, parent as any, { startTask: false })

		expect(providerTestState.constructedTaskOptions[0]).toMatchObject({
			reasoningPreference: { kind: "effort", effort: "medium" },
		})
		expect(providerTestState.constructedTaskOptions[1]).toMatchObject({
			reasoningPreference: { kind: "effort", effort: "high" },
			parentTask: parent,
		})
	})

	it("captures approval defaults per task so a later settings change only affects new tasks", async () => {
		const { provider, state } = providerHarness()
		state.approvalMode = "ask"
		await provider.createTask("first", undefined, undefined, { startTask: false })

		state.approvalMode = "bypass"
		await provider.createTask("second", undefined, undefined, { startTask: false })

		expect(providerTestState.constructedTaskOptions[0]).toMatchObject({ taskApprovalMode: "ask" })
		expect(providerTestState.constructedTaskOptions[1]).toMatchObject({ taskApprovalMode: "bypass" })
	})

	it("restores the saved reasoning preference from a history snapshot", async () => {
		const { provider } = providerHarness()
		const historyItem: HistoryItem = {
			id: "restored-task",
			number: 1,
			ts: 1,
			task: "restore",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			reasoningPreference: { kind: "effort", effort: "high" },
		}

		await provider.createTaskWithHistoryItem(historyItem, { startTask: false })

		expect(providerTestState.constructedTaskOptions[0]).toMatchObject({
			historyItem,
		})
		expect((providerTestState.constructedTaskOptions[0].historyItem as HistoryItem).reasoningPreference).toEqual({
			kind: "effort",
			effort: "high",
		})
	})

	it("restores the task approval mode stored in history instead of using the newer default", async () => {
		const { provider, state } = providerHarness()
		state.approvalMode = "bypass"
		const historyItem: HistoryItem = {
			id: "restored-approval-task",
			number: 1,
			ts: 1,
			task: "restore approval policy",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			approvalMode: "ask",
		}

		await provider.createTaskWithHistoryItem(historyItem, { startTask: false })

		expect(providerTestState.constructedTaskOptions[0]).toMatchObject({ taskApprovalMode: "ask", historyItem })
	})
})
