import type { HistoryItem, ProviderSettings, TaskReasoningPreference, TaskReasoningProjection } from "@alpha-code/types"

import { buildApiHandler } from "../../../api"
import { AlphaProvider } from "../AlphaProvider"
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
	version: "1.122.1",
}))

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation((options: Record<string, any>) => {
		providerTestState.constructedTaskOptions.push(options)
		const task = {
			taskId: options.historyItem?.id ?? options.taskId ?? `created-${++providerTestState.nextTaskId}`,
			instanceId: `instance-${providerTestState.nextTaskId}`,
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
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(() => ({ getName: () => "test", applyDiff: vi.fn() })),
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(() => ({ initializeFilePaths: vi.fn(), dispose: vi.fn() })),
}))
vi.mock("../../../api/providers/fetchers/modelCache", () => ({ getModels: vi.fn(), flushModels: vi.fn() }))
vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../utils/safeWriteJson")
vi.mock("../../../utils/tts", () => ({ setTtsEnabled: vi.fn(), setTtsSpeed: vi.fn() }))
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
	updateReasoningPreference: ReturnType<typeof vi.fn>
	getReasoningState: ReturnType<typeof vi.fn>
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
	Object.assign(provider, {
		contextProxy,
		configurationQueue: Promise.resolve(),
		taskStack: tasks,
		newTaskDraftMode: "code",
		context: { workspaceState: { get: vi.fn(() => undefined) } },
		getLiveTask: vi.fn((taskId: string) => taskMap.get(taskId)),
		getCurrentTask: vi.fn(() => tasks[0]),
		getProviderSettingsSnapshot: vi.fn(() => ({ ...baseConfiguration })),
		getReasoningProjection: vi.fn(async (task?: FakeTask) =>
			task ? task.getReasoningState() : projection("composer", state.newTaskReasoningPreference),
		),
		postStateToWebview: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		removeTaskFromStack: vi.fn(async () => undefined),
		addTaskToStack: vi.fn(async () => undefined),
		updateGlobalState: vi.fn(async (key: string, value: unknown) => {
			state[key] = value
		}),
		setValues: vi.fn(async (values: Record<string, unknown>) => Object.assign(state, values)),
		log: vi.fn(),
		taskSessions: { canCreateTask: vi.fn(() => true), register: vi.fn() },
		taskCreationCallback: vi.fn(),
		agentControlStore: { retryPendingMailboxClaimSettlements: vi.fn(async () => undefined) },
		getState: vi.fn(async () => ({
			apiConfiguration: { ...baseConfiguration },
			enableCheckpoints: true,
			checkpointTimeout: 30,
			experiments: {},
		})),
		providerSettingsManager: {
			listConfig: vi.fn(async () => []),
			getModeConfigId: vi.fn(async () => undefined),
			getProfile: vi.fn(async () => ({ ...baseConfiguration })),
		},
	})
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

	it.each(["low", "high"] as const)(
		"recomputes pending against the captured request when live LM capabilities resolve to %s",
		async (effort) => {
			const task = fakeTask("task-a", { kind: "effort", effort: "high" })
			task.apiConfiguration = { apiProvider: "vscode-lm" }
			const { taskId: _taskId, ...current } = projection(task.taskId, task.reasoningPreference)
			task.getReasoningState.mockReturnValue({
				...current,
				taskId: task.taskId,
				current,
				pending: effort === "high",
			})
			const { provider } = providerHarness([task])
			const refreshed = {
				...current,
				effective: { kind: "effort" as const, effort },
			}
			vi.spyOn(provider, "resolveReasoningCapabilities").mockResolvedValue(refreshed)

			const result = await (AlphaProvider.prototype as any).getReasoningProjection.call(provider, task)

			expect(result.effective).toEqual(refreshed.effective)
			expect(result.current).toEqual(current)
			expect(result.pending).toBe(effort !== "high")
		},
	)

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
})
