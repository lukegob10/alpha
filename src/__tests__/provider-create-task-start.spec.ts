import { afterEach, describe, expect, it, vi } from "vitest"

const taskMocks = vi.hoisted(() => {
	const start = vi.fn()
	const instances: any[] = []

	class MockTask {
		taskId = "created-task"
		instanceId = "instance-1"
		parentTask?: any
		taskApprovalMode?: string
		presentationModelCalls?: false

		constructor(options: any) {
			this.parentTask = options.parentTask
			this.taskApprovalMode = options.taskApprovalMode
			this.presentationModelCalls = options.presentationModelCalls
			instances.push(this)
		}

		start() {
			start()
		}
	}

	return { MockTask, instances, start }
})

vi.mock("../core/task/Task", () => ({
	Task: taskMocks.MockTask,
}))

import { retiredProviderNames, type ProviderSettings, type HistoryItem } from "@alpha-code/types"

import { AlphaProvider } from "../core/webview/AlphaProvider"
import { TaskSessionRegistry } from "../core/webview/TaskSessionRegistry"

describe("AlphaProvider.createTask start control", () => {
	afterEach(() => {
		taskMocks.instances.length = 0
		taskMocks.start.mockClear()
		vi.restoreAllMocks()
	})

	const createProvider = () =>
		Object.assign(Object.create(AlphaProvider.prototype), {
			context: { secrets: {} },
			taskStack: [],
			taskCreationQueue: Promise.resolve(),
			createTaskUnderCreationLock: (AlphaProvider.prototype as any).createTaskUnderCreationLock,
			getLiveTask: vi.fn(),
			taskSessions: new TaskSessionRegistry(),
			customModesManager: { updateCustomMode: vi.fn() },
			taskCreationCallback: undefined,
			setValues: vi.fn(),
			getState: vi.fn(async () => ({
				apiConfiguration: {
					apiProvider: "openai",
					apiModelId: "gpt-4.1",
					consecutiveMistakeLimit: 3,
				},
				currentApiConfigName: "default",
				organizationAllowList: { allowAll: true, providers: {} },
				enableCheckpoints: false,
				checkpointTimeout: 60,
				experiments: {},
			})),
			getProviderSettingsSnapshot: vi.fn(() => ({
				apiProvider: "openai",
				apiModelId: "gpt-4.1",
				consecutiveMistakeLimit: 3,
			})),
			providerSettingsManager: {
				listConfig: vi.fn(async () => [{ id: "default-profile", name: "default", apiProvider: "openai" }]),
				getProfile: vi.fn(async () => ({
					id: "default-profile",
					name: "default",
					apiProvider: "openai",
					apiModelId: "gpt-4.1",
					consecutiveMistakeLimit: 3,
				})),
			},
			contextProxy: {
				getValues: vi.fn(() => ({
					currentApiConfigName: "default",
					enableCheckpoints: false,
					checkpointTimeout: 60,
					experiments: {},
				})),
				getValue: vi.fn(),
			},
			removeTaskFromStack: vi.fn(),
			updateGlobalState: vi.fn(async () => undefined),
			addTaskToStack: vi.fn(async () => undefined),
			postTaskStateToWebview: vi.fn(async () => undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as unknown as AlphaProvider

	it.each(["allowedMaxCost", "allowedMaxRequests"] as const)(
		"disables presentation model calls at admission with finite positive %s",
		async (budget) => {
			const provider = createProvider()
			vi.mocked(provider.contextProxy.getValues).mockReturnValue({ [budget]: 0.1 })

			const task = await provider.createTask("Governed work", undefined, undefined, { startTask: false })

			expect(task).toHaveProperty("presentationModelCalls", false)
		},
	)

	it.each([0, null, undefined, Number.POSITIVE_INFINITY, Number.NaN])(
		"keeps the existing interactive default for a non-finite-positive budget %s",
		async (budget) => {
			const provider = createProvider()
			vi.mocked(provider.contextProxy.getValues).mockReturnValue({ allowedMaxCost: budget })

			const task = await provider.createTask("Interactive work", undefined, undefined, { startTask: false })

			expect(task).toHaveProperty("presentationModelCalls", undefined)
		},
	)

	it.each([...retiredProviderNames, "future-provider"])(
		"rejects %s before closing the current task",
		async (apiProvider) => {
			const provider = createProvider()
			await expect(
				AlphaProvider.prototype.createTask.call(provider, "New work", undefined, undefined, {
					apiConfiguration: { apiProvider: apiProvider as ProviderSettings["apiProvider"] },
				}),
			).rejects.toThrow(`Unsupported API provider: ${apiProvider}`)
			expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
			expect(taskMocks.instances).toHaveLength(0)
		},
	)

	it.each([...retiredProviderNames, "future-provider"])(
		"rejects restored %s before closing the current task",
		async (apiProvider) => {
			const provider = createProvider()
			await expect(
				AlphaProvider.prototype.createTaskWithHistoryItem.call(provider, { id: "saved-task" } as HistoryItem, {
					subagentRuntime: {
						apiConfiguration: { apiProvider: apiProvider as ProviderSettings["apiProvider"] },
					},
				}),
			).rejects.toThrow(`Unsupported API provider: ${apiProvider}`)
			expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
			expect(taskMocks.instances).toHaveLength(0)
		},
	)

	it("rejects an explicit public API provider override over a valid saved profile before closing the current task", async () => {
		const provider = createProvider()
		const configuration = { apiProvider: "future-provider" as ProviderSettings["apiProvider"] }

		await expect(provider.createTask("New work", undefined, undefined, {}, configuration)).rejects.toThrow(
			"Unsupported API provider: future-provider",
		)
		expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledWith({ name: "default" })
		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
		expect(taskMocks.instances).toHaveLength(0)
	})

	it("does not start a task when startTask is false", async () => {
		const provider = createProvider()

		await AlphaProvider.prototype.createTask.call(provider, "Child work", undefined, undefined, {
			startTask: false,
		})

		expect(taskMocks.instances).toHaveLength(1)
		expect(taskMocks.start).not.toHaveBeenCalled()
		expect((provider as any).updateGlobalState).toHaveBeenCalledWith("mode", "code")
	})

	it("freezes a draft approval override into the new task without changing the default", async () => {
		const provider = createProvider()

		await AlphaProvider.prototype.createTask.call(provider, "First prompt", undefined, undefined, {
			taskApprovalMode: "ask",
			startTask: false,
		})

		expect(taskMocks.instances).toHaveLength(1)
		expect(taskMocks.instances[0].taskApprovalMode).toBe("ask")
		expect(provider["setValues"]).not.toHaveBeenCalled()
	})

	it("starts a task by default", async () => {
		const provider = createProvider()

		await AlphaProvider.prototype.createTask.call(provider, "Normal work")

		expect(taskMocks.instances).toHaveLength(1)
		expect(taskMocks.start).toHaveBeenCalledTimes(1)
		expect((provider as any).updateGlobalState).toHaveBeenCalledWith("mode", "code")
	})

	it("serializes concurrent task creation in submission order", async () => {
		const provider = createProvider()
		let startFirst!: () => void
		let releaseFirst!: () => void
		const firstStarted = new Promise<void>((resolve) => {
			startFirst = resolve
		})
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const order: string[] = []
		;(provider as any).createTaskUnderCreationLock = vi.fn(async (text: string) => {
			order.push(`started:${text}`)
			if (text === "First") {
				startFirst()
				await firstGate
			}
			order.push(`finished:${text}`)
			return { taskId: text }
		})

		const first = AlphaProvider.prototype.createTask.call(provider, "First")
		const second = AlphaProvider.prototype.createTask.call(provider, "Second")

		await firstStarted
		expect(order).toEqual(["started:First"])

		releaseFirst()
		await expect(Promise.all([first, second])).resolves.toMatchObject([{ taskId: "First" }, { taskId: "Second" }])
		expect(order).toEqual(["started:First", "finished:First", "started:Second", "finished:Second"])
	})

	it("publishes and starts before slow mode persistence finishes", async () => {
		let finishPersistence!: () => void
		const provider = createProvider()
		;(provider as any).updateGlobalState = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishPersistence = resolve
				}),
		)

		let creationSettled = false
		const creation = AlphaProvider.prototype.createTask.call(provider, "Normal work").then((task) => {
			creationSettled = true
			return task
		})

		await vi.waitFor(() => {
			expect((provider as any).postTaskStateToWebview).toHaveBeenCalledTimes(1)
			expect(taskMocks.start).toHaveBeenCalledTimes(1)
		})
		expect(creationSettled).toBe(false)

		finishPersistence()
		await creation
	})
})
