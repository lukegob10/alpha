import { afterEach, describe, expect, it, vi } from "vitest"

const taskMocks = vi.hoisted(() => {
	const start = vi.fn()
	const instances: any[] = []

	class MockTask {
		taskId = "created-task"
		instanceId = "instance-1"
		parentTask?: any

		constructor(options: any) {
			this.parentTask = options.parentTask
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

import { ClineProvider } from "../core/webview/ClineProvider"

describe("ClineProvider.createTask start control", () => {
	afterEach(() => {
		taskMocks.instances.length = 0
		taskMocks.start.mockClear()
		vi.restoreAllMocks()
	})

	const createProvider = () =>
		({
			clineStack: [],
			taskSessions: { canCreateTask: vi.fn(() => true) },
			customModesManager: { updateCustomMode: vi.fn() },
			taskCreationCallback: undefined,
			setValues: vi.fn(),
			getState: vi.fn(async () => ({
				apiConfiguration: {
					apiProvider: "openai-native",
					apiModelId: "gpt-4.1",
					consecutiveMistakeLimit: 3,
				},
				currentApiConfigName: "default",
				organizationAllowList: { allowAll: true, providers: {} },
				enableCheckpoints: false,
				checkpointTimeout: 60,
				experiments: {},
			})),
			removeClineFromStack: vi.fn(),
			addClineToStack: vi.fn(async () => undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as unknown as ClineProvider

	it("does not start a task when startTask is false", async () => {
		const provider = createProvider()

		await ClineProvider.prototype.createTask.call(provider, "Child work", undefined, undefined, {
			startTask: false,
		})

		expect(taskMocks.instances).toHaveLength(1)
		expect(taskMocks.start).not.toHaveBeenCalled()
	})

	it("starts a task by default", async () => {
		const provider = createProvider()

		await ClineProvider.prototype.createTask.call(provider, "Normal work")

		expect(taskMocks.instances).toHaveLength(1)
		expect(taskMocks.start).toHaveBeenCalledTimes(1)
	})
})
