import { afterEach, beforeEach, expect, it, vi } from "vitest"
import path from "node:path"
import type { RunTaskOptions } from "../types"
import { calculateApiCostOpenAI } from "../../../../../src/shared/cost"

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	wait: vi.fn(),
	reap: vi.fn(),
	disconnect: vi.fn(),
	close: vi.fn(),
	send: vi.fn(),
	identity: undefined as import("@alpha-code/types").ExecutionIdentity | undefined,
	writeReceipt: vi.fn(),
	copyHistory: vi.fn(),
	assertProfileOwnership: vi.fn(),
	lstat: vi.fn(),
	realpath: vi.fn(),
	createMetrics: vi.fn(),
	updateMetrics: vi.fn(),
	updateTask: vi.fn(),
	capabilities: { targetedTaskCancellation: true, presentationModelCallOptOut: true } as
		| import("@alpha-code/types").Ack["capabilities"]
		| undefined,
	containerized: true,
	prepareProfile: vi.fn(),
	assertAncestry: vi.fn(),
	readIdentity: vi.fn(),
	serverProcess: { pid: 100, ppid: 99 } as { pid: number; ppid: number } | undefined,
	listeners: new Map<string, () => void>(),
}))
vi.mock("fs", () => ({
	existsSync: () => true,
	readFileSync: () => "fixture prompt",
	promises: {
		writeFile: mocks.writeReceipt,
		realpath: mocks.realpath,
		lstat: mocks.lstat,
		mkdir: vi.fn(async () => undefined),
	},
}))
vi.mock("execa", () => ({ execa: mocks.spawn }))
vi.mock("p-wait-for", () => ({ default: mocks.wait }))
vi.mock("../../db/index", () => ({
	updateTask: mocks.updateTask,
	createTaskMetrics: mocks.createMetrics,
	updateTaskMetrics: mocks.updateMetrics,
	createToolError: vi.fn(),
}))
vi.mock("../utils", async (importOriginal) => ({
	mergeToolUsage: (await importOriginal<typeof import("../utils")>()).mergeToolUsage,
	isDockerContainer: () => mocks.containerized,
	copyConversationHistory: mocks.copyHistory,
	waitForSubprocessWithTimeout: mocks.reap,
}))
vi.mock("../../../../../apps/vscode-e2e/src/testProfile", () => ({
	prepareTestProfile: mocks.prepareProfile,
	assertOwnedTestRoot: mocks.assertProfileOwnership,
}))
vi.mock("../../../../../apps/vscode-e2e/src/hostOwnership", () => ({ assertRunnerAncestry: mocks.assertAncestry }))
vi.mock("../../../../../src/extension/executionIdentity", () => ({ readExecutionIdentity: mocks.readIdentity }))
vi.mock("@alpha-code/ipc", () => ({
	IpcClient: class {
		isReady = true
		executionIdentity = mocks.identity
		capabilities = mocks.capabilities
		serverProcess = mocks.serverProcess
		disconnect = mocks.disconnect
		on(name: string, listener: () => void) {
			mocks.listeners.set(name, listener)
		}
		sendCommand = mocks.send
	},
}))
import { AlphaCodeEventName, IpcMessageType, TaskCommandName, type TaskEvent } from "@alpha-code/types"
import { runTaskInVscode } from "../runTaskInVscode"

const input = () =>
	({
		run: { id: 1 },
		task: { id: 2, language: "js", exercise: "fixture" },
		workspaceRoot: "/fixture",
		jobToken: null,
		publish: vi.fn(),
		logger: { info: vi.fn(), error: vi.fn(), close: mocks.close },
	}) as unknown as RunTaskOptions
beforeEach(() => {
	vi.useFakeTimers()
	vi.resetAllMocks()
	mocks.listeners.clear()
	mocks.identity = undefined
	mocks.capabilities = { targetedTaskCancellation: true, presentationModelCallOptOut: true }
	mocks.createMetrics.mockResolvedValue({ id: 11 })
	mocks.updateMetrics.mockResolvedValue(undefined)
	mocks.updateTask.mockResolvedValue(undefined)
	mocks.copyHistory.mockResolvedValue(undefined)
	mocks.assertProfileOwnership.mockResolvedValue(undefined)
	mocks.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false })
	mocks.realpath.mockImplementation(async (value: string) => value)
	mocks.containerized = true
	mocks.serverProcess = { pid: 100, ppid: 99 }
	mocks.prepareProfile.mockResolvedValue({
		userDataDir: path.resolve("owned benchmark/user-data"),
		extensionsDir: path.resolve("owned benchmark/extensions"),
		temporaryRoot: path.resolve("owned benchmark"),
	})
	mocks.assertAncestry.mockResolvedValue(undefined)
	mocks.readIdentity.mockImplementation(async () => mocks.identity)
	mocks.writeReceipt.mockResolvedValue(undefined)
	mocks.spawn.mockReturnValue(new Promise(() => {}))
	mocks.reap.mockResolvedValue(undefined)
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

const benchmarkInput = () => {
	const options = input()
	options.task.benchmarkTaskIdentity = "fixture@1"
	options.run.campaignHardCapUsd = 0.5
	options.run.taskCostCapUsd = 0.06
	options.run.model = "gpt-5.6-luna"
	options.run.settings = { apiProvider: "openai", openAiModelId: "gpt-5.6-luna" }
	options.run.inputPrice = 1
	options.run.outputPrice = 6
	options.run.cacheReadsPrice = 0.1
	options.run.cacheWritesPrice = 1.25
	return options
}

const exactIdentity = (): import("@alpha-code/types").ExecutionIdentity => ({
	schemaVersion: 1,
	hostVersion: "1.138.0",
	extensionId: "Alpha.alpha",
	extensionVersion: "1.0.0",
	entrypointDigest: `sha256:${"a".repeat(64)}`,
	manifestDigest: `sha256:${"b".repeat(64)}`,
	identityScope: "observed-entrypoint-and-manifest",
})

it("rejects an already aborted controller before launching or dispatching and disposes its listener", async () => {
	const controller = new AbortController()
	controller.abort(new Error("controller lease lost"))
	const removed = vi.spyOn(controller.signal, "removeEventListener")
	await expect(runTaskInVscode({ ...input(), signal: controller.signal })).rejects.toThrow("controller lease lost")
	expect(mocks.spawn).not.toHaveBeenCalled()
	expect(mocks.send).not.toHaveBeenCalled()
	expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
})

it("propagates controller loss to the existing owned process cancellation before startup dispatch", async () => {
	const controller = new AbortController()
	const removed = vi.spyOn(controller.signal, "removeEventListener")
	const pending = runTaskInVscode({ ...input(), signal: controller.signal })
	const rejection = expect(pending).rejects.toThrow("controller lease lost")
	expect(mocks.spawn).toHaveBeenCalledOnce()
	controller.abort(new Error("controller lease lost"))
	expect(mocks.spawn.mock.calls[0]![2].cancelSignal.aborted).toBe(true)
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.send).not.toHaveBeenCalled()
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
})

it("rejects controller loss during an active task without persisting a successful finish", async () => {
	const controller = new AbortController()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async (predicate) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskCreated, payload: ["root"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		controller.abort(new Error("controller lease lost"))
		expect(predicate()).toBe(true)
	})
	const pending = runTaskInVscode({ ...input(), signal: controller.signal })
	const rejection = expect(pending).rejects.toThrow("controller lease lost")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.updateTask.mock.calls.some(([, value]) => "finishedAt" in value)).toBe(false)
	expect(mocks.reap).toHaveBeenCalledOnce()
})

const emitUsage = (
	taskId: string,
	cost: number,
	contextTokens = 100,
): Extract<TaskEvent, { eventName: AlphaCodeEventName.TaskTokenUsageUpdated }> => ({
	eventName: AlphaCodeEventName.TaskTokenUsageUpdated,
	payload: [
		taskId,
		{
			totalCost: cost,
			totalTokensIn: 100,
			totalTokensOut: 50,
			contextTokens,
			totalCacheReads: 25,
			totalCacheWrites: 5,
		},
		{ read_file: { attempts: 1, failures: 0 } },
	],
})

it("retains the root lifecycle and counts each child's cumulative usage once", async () => {
	mocks.identity = exactIdentity()
	let childCompletedPredicate: boolean | undefined
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async (predicate) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskCreated, payload: ["root"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener(emitUsage("root", 0.02, 300))
		await listener({ eventName: AlphaCodeEventName.TaskCreated, payload: ["child"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		await listener(emitUsage("child", 0.015, 900))
		await listener(emitUsage("child", 0.005, 900))
		await listener(emitUsage("child", 0.015, 900))
		await listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: [
				"child",
				emitUsage("child", 0.015, 900).payload[1],
				{ read_file: { attempts: 1, failures: 0 } },
				{ isSubtask: true },
			],
		})
		childCompletedPredicate = predicate()
		await listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: [
				"root",
				emitUsage("root", 0.03, 400).payload[1],
				{ read_file: { attempts: 2, failures: 1 } },
				{ isSubtask: false },
			],
		})
	})
	const pending = runTaskInVscode(benchmarkInput())
	await vi.advanceTimersByTimeAsync(5000)
	await expect(pending).resolves.toBe("completed")
	expect(childCompletedPredicate).toBe(false)
	expect(mocks.createMetrics).toHaveBeenCalledOnce()
	expect(mocks.updateMetrics).toHaveBeenLastCalledWith(
		11,
		expect.objectContaining({
			cost: 0.045,
			tokensIn: 200,
			tokensOut: 100,
			tokensContext: 400,
			cacheReads: 50,
			cacheWrites: 10,
			toolUsage: { read_file: { attempts: 3, failures: 1 } },
		}),
	)
})

it.each(["publish", "metrics"])(
	"owns a rejected %s effect instead of leaking the async callback",
	async (failurePoint) => {
		mocks.identity = exactIdentity()
		const error = new Error(`rejected ${failurePoint} effect`)
		const options = benchmarkInput()
		if (failurePoint === "publish") options.publish = vi.fn().mockRejectedValueOnce(error)
		else mocks.createMetrics.mockRejectedValueOnce(error)
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (
				event: TaskEvent,
			) => Promise<void>
			const effect = listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
			await Promise.resolve(effect).catch(() => undefined)
			mocks.listeners.get(IpcMessageType.Disconnect)!()
		})
		const pending = runTaskInVscode(options)
		const settled = pending.catch((failure) => failure)
		await vi.advanceTimersByTimeAsync(3000)
		expect(await settled).toBe(error)
		expect(mocks.reap).toHaveBeenCalledOnce()
	},
)

it("serializes accepted usage writes before terminal finalization under actual EventEmitter delivery", async () => {
	mocks.identity = exactIdentity()
	let releaseWrite!: () => void
	const writeHeld = new Promise<void>((resolve) => {
		releaseWrite = resolve
	})
	let enteredWrite!: () => void
	const writeEntered = new Promise<void>((resolve) => {
		enteredWrite = resolve
	})
	const committedCosts: number[] = []
	let sawOverlap = false
	let acceptedCompletion!: () => void
	const completionAccepted = new Promise<void>((resolve) => {
		acceptedCompletion = resolve
	})
	mocks.updateMetrics.mockImplementation(async (_id, metrics) => {
		if (metrics.cost === 0.01) {
			enteredWrite()
			await writeHeld
		}
		committedCosts.push(metrics.cost)
	})
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		const earlier = listener(emitUsage("root", 0.01))
		await writeEntered
		const terminal = listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: ["root", emitUsage("root", 0.02).payload[1], {}, { isSubtask: false }],
		})
		acceptedCompletion()
		await Promise.allSettled([earlier, terminal])
	})
	const pending = runTaskInVscode(benchmarkInput())
	await vi.advanceTimersByTimeAsync(3000)
	await completionAccepted
	await vi.advanceTimersByTimeAsync(0)
	sawOverlap = mocks.updateMetrics.mock.calls.length > 1
	releaseWrite()
	await vi.advanceTimersByTimeAsync(2000)
	await expect(pending).resolves.toBe("completed")
	expect(sawOverlap).toBe(false)
	expect(committedCosts).toEqual([0.01, 0.02])
})

it("captures the root before its initial metrics write yields to child events", async () => {
	mocks.identity = exactIdentity()
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	mocks.createMetrics.mockImplementationOnce(async () => {
		await held
		return { id: 11 }
	})
	let accepted!: () => void
	const eventsAccepted = new Promise<void>((resolve) => {
		accepted = resolve
	})
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		const effects = [
			listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] }),
			listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] }),
			listener({
				eventName: AlphaCodeEventName.TaskCompleted,
				payload: ["child", emitUsage("child", 0.005).payload[1], {}, { isSubtask: true }],
			}),
			listener({
				eventName: AlphaCodeEventName.TaskCompleted,
				payload: ["root", emitUsage("root", 0.01).payload[1], {}, { isSubtask: false }],
			}),
		]
		accepted()
		await Promise.all(effects)
	})
	const pending = runTaskInVscode(benchmarkInput())
	await vi.advanceTimersByTimeAsync(3000)
	await eventsAccepted
	expect(mocks.createMetrics).toHaveBeenCalledOnce()
	expect(mocks.updateTask).not.toHaveBeenCalled()
	release()
	await vi.advanceTimersByTimeAsync(2000)
	await expect(pending).resolves.toBe("completed")
	expect(mocks.createMetrics).toHaveBeenCalledOnce()
	expect(mocks.updateMetrics).toHaveBeenLastCalledWith(11, expect.objectContaining({ cost: 0.015 }))
	const receipt = mocks.writeReceipt.mock.calls.find(([file]) => file.endsWith(".cost.json"))!
	expect(JSON.parse(receipt[1])).toMatchObject({ rootTaskId: "root", observedRuntimeCount: 2 })
})

it.each([undefined, { targetedTaskCancellation: false }])(
	"rejects governed dispatch without the new targeted-cancel capability",
	async (capabilities) => {
		mocks.identity = exactIdentity()
		mocks.capabilities = capabilities
		mocks.wait.mockResolvedValue(undefined)
		const pending = runTaskInVscode(benchmarkInput())
		const settled = pending.catch((failure) => failure)
		await vi.advanceTimersByTimeAsync(3000)
		expect(await settled).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/targeted.*cancellation.*support/i) }),
		)
		expect(mocks.send).not.toHaveBeenCalled()
	},
)

it.each([
	{ containerized: false, support: undefined },
	{ containerized: false, support: false },
	{ containerized: true, support: undefined },
	{ containerized: true, support: false },
])(
	"rejects governed presentation calls without support $support in container=$containerized",
	async ({ containerized, support }) => {
		mocks.identity = exactIdentity()
		mocks.containerized = containerized
		if (!containerized) vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve("Code.exe"))
		mocks.capabilities = { targetedTaskCancellation: true, presentationModelCallOptOut: support }
		mocks.wait.mockResolvedValue(undefined)
		const pending = runTaskInVscode(benchmarkInput())
		const settled = pending.catch((error) => error)
		await vi.advanceTimersByTimeAsync(3000)
		expect(await settled).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/presentation.*opt.out.*support/i) }),
		)
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.disconnect).toHaveBeenCalledOnce()
		expect(mocks.reap).toHaveBeenCalledOnce()
	},
)

it.each([
	{ containerized: false, restarted: false },
	{ containerized: false, restarted: true },
	{ containerized: true, restarted: false },
	{ containerized: true, restarted: true },
])(
	"opts out of presentation model calls for container=$containerized restarted=$restarted",
	async ({ containerized, restarted }) => {
		mocks.identity = exactIdentity()
		mocks.containerized = containerized
		if (!containerized) vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve("Code.exe"))
		const options = benchmarkInput()
		if (restarted) options.task.startedAt = new Date(1)
		const onExecutionIdentity = vi.fn().mockResolvedValue(undefined)
		options.onExecutionIdentity = onExecutionIdentity
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			mocks.listeners.get(IpcMessageType.Disconnect)!()
		})
		const pending = runTaskInVscode(options)
		const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		const command = mocks.send.mock.calls.find(([value]) => value.commandName === TaskCommandName.StartNewTask)![0]
		expect(command.data).toMatchObject({ presentationModelCalls: false, text: "fixture prompt" })
		expect(command.data.configuration).not.toHaveProperty("presentationModelCalls")
		expect(onExecutionIdentity).toHaveBeenCalledExactlyOnceWith(exactIdentity(), {
			schemaVersion: 1,
			presentationModelCalls: false,
			presentationModelCallOptOut: true,
		})
		const receipt = mocks.writeReceipt.mock.calls.find(([file]) => file.endsWith(".execution.json"))!
		expect(JSON.parse(receipt[1]).governance).toMatchObject({
			targetedTaskCancellation: true,
			presentationModelCallOptOut: true,
			presentationModelCalls: false,
		})
	},
)

it("preserves non-governed presentation defaults without requiring a new host capability", async () => {
	mocks.capabilities = undefined
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	const command = mocks.send.mock.calls.find(([value]) => value.commandName === TaskCommandName.StartNewTask)![0]
	expect(command.data).not.toHaveProperty("presentationModelCalls")
})

it("refuses governed legacy dispatch without identity instead of skipping policy persistence", async () => {
	const options = benchmarkInput()
	options.task.benchmarkTaskIdentity = null
	options.onExecutionIdentity = vi.fn()
	mocks.identity = undefined
	mocks.wait.mockResolvedValue(undefined)
	const pending = runTaskInVscode(options)
	const settled = pending.catch((error) => error)
	await vi.advanceTimersByTimeAsync(3000)
	expect(await settled).toEqual(expect.objectContaining({ message: expect.stringMatching(/identity unavailable/i) }))
	expect(options.onExecutionIdentity).not.toHaveBeenCalled()
	expect(mocks.send).not.toHaveBeenCalled()
	expect(mocks.disconnect).toHaveBeenCalledOnce()
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it.each(["completed", "cancelled", "failure"] as const)(
	"retains owned local root history after %s and after host reaping",
	async (terminal) => {
		mocks.containerized = false
		mocks.identity = { ...exactIdentity(), extensionId: "AlphaInc.alpha" }
		vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve("Code.exe"))
		const options = benchmarkInput()
		const primary = new Error("root publication failed")
		if (terminal === "failure") options.publish = vi.fn().mockRejectedValueOnce(primary)
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (
				event: TaskEvent,
			) => Promise<void>
			await listener({ eventName: AlphaCodeEventName.TaskCreated, payload: ["root-history"] })
			if (terminal === "failure") return
			await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root-history"] })
			await listener(emitUsage("root-history", 0.01))
			await listener(
				terminal === "cancelled"
					? { eventName: AlphaCodeEventName.TaskAborted, payload: ["root-history"] }
					: {
							eventName: AlphaCodeEventName.TaskCompleted,
							payload: [
								"root-history",
								emitUsage("root-history", 0.01).payload[1],
								{},
								{ isSubtask: false },
							],
						},
			)
		})
		const pending = runTaskInVscode(options).then(
			(value) => value,
			(error) => error,
		)
		await vi.advanceTimersByTimeAsync(5000)
		expect(await pending).toBe(terminal === "failure" ? primary : terminal)
		expect(mocks.assertProfileOwnership).toHaveBeenCalledExactlyOnceWith(
			path.resolve("owned benchmark"),
			"temporary",
		)
		expect(mocks.copyHistory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				alphaTaskId: "root-history",
				storageRoot: path.resolve("owned benchmark/user-data/User/globalStorage/alphainc.alpha"),
			}),
		)
		expect(mocks.reap.mock.invocationCallOrder[0]).toBeLessThan(mocks.copyHistory.mock.invocationCallOrder[0]!)
	},
)

it.each(["ownership", "symlink", "escape"])(
	"rejects unsafe owned local history at the %s boundary",
	async (boundary) => {
		mocks.containerized = false
		mocks.identity = exactIdentity()
		vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve("Code.exe"))
		if (boundary === "ownership")
			mocks.assertProfileOwnership.mockRejectedValueOnce(new Error("foreign profile ownership"))
		if (boundary === "symlink")
			mocks.lstat.mockImplementation(async (file: string) => ({
				isFile: () => true,
				isSymbolicLink: () => file.includes(`${path.sep}tasks`),
			}))
		if (boundary === "escape")
			mocks.realpath.mockImplementation(async (file: string) =>
				file.includes(`${path.sep}tasks`) ? path.resolve("foreign-history") : file,
			)
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (
				event: TaskEvent,
			) => Promise<void>
			await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
			await listener({
				eventName: AlphaCodeEventName.TaskCompleted,
				payload: ["root", emitUsage("root", 0.01).payload[1], {}, { isSubtask: false }],
			})
		})
		const pending = runTaskInVscode(benchmarkInput()).catch((error) => error)
		await vi.advanceTimersByTimeAsync(5000)
		expect(await pending).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/ownership|symlinks|outside/i) }),
		)
		expect(mocks.copyHistory).not.toHaveBeenCalled()
		expect(mocks.reap).toHaveBeenCalledOnce()
	},
)

it("fails closed on bounded event overflow without dropping effects into a successful result", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		const effects = [listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })]
		for (let index = 0; index < 1024; index++) effects.push(listener(emitUsage("root", 0.01)))
		await Promise.all(effects)
	})
	const pending = runTaskInVscode(benchmarkInput()).catch((error) => error)
	await vi.advanceTimersByTimeAsync(3000)
	expect(await pending).toEqual(expect.objectContaining({ message: "Evaluator event effect queue bound exceeded" }))
	expect(mocks.send.mock.calls.filter(([command]) => command.commandName === TaskCommandName.CancelTask)).toEqual([
		[{ commandName: TaskCommandName.CancelTask, data: { taskId: "root" } }],
	])
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("bounds a stuck publication by the task deadline and prevents late writes after cleanup", async () => {
	mocks.identity = exactIdentity()
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let effect: Promise<void> | undefined
	const options = benchmarkInput()
	options.run.timeout = 0.0001
	options.publish = vi.fn(() => held)
	mocks.send.mockImplementation((command) => {
		if (command.commandName === TaskCommandName.StartNewTask) {
			const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (
				event: TaskEvent,
			) => Promise<void>
			effect = listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		}
	})
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async (_predicate, options) => {
		await new Promise((resolve) => setTimeout(resolve, options.timeout))
		throw new Error("timeout")
	})
	const pending = runTaskInVscode(options).catch((error) => error)
	await vi.advanceTimersByTimeAsync(8010)
	expect(await pending).toEqual(
		expect.objectContaining({ message: expect.stringMatching(/terminal event before timeout/) }),
	)
	expect(mocks.reap).toHaveBeenCalledOnce()
	const receipt = mocks.writeReceipt.mock.calls.find(([file]) => file.endsWith(".cost.json"))!
	expect(JSON.parse(receipt[1])).toMatchObject({ eventEffectsUncertain: true })
	release()
	await effect
	expect(mocks.createMetrics).not.toHaveBeenCalled()
	expect(mocks.updateTask).not.toHaveBeenCalled()
})

it.each(["known", "unknown"])("keeps child cancellation separate from the root with %s child usage", async (known) => {
	mocks.identity = exactIdentity()
	let childAbortedPredicate: boolean | undefined
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async (predicate) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener(emitUsage("root", 0.01))
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		if (known === "known") await listener(emitUsage("child", 0.005))
		await listener({ eventName: AlphaCodeEventName.TaskAborted, payload: ["child"] })
		childAbortedPredicate = predicate()
		await listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: ["root", emitUsage("root", 0.02).payload[1], {}, { isSubtask: false }],
		})
	})
	const pending = runTaskInVscode(benchmarkInput()).then(
		(value) => value,
		(error) => error,
	)
	await vi.advanceTimersByTimeAsync(5000)
	if (known === "known") {
		expect(await pending).toBe("completed")
		expect(childAbortedPredicate).toBe(false)
		expect(mocks.updateMetrics).toHaveBeenLastCalledWith(11, expect.objectContaining({ cost: 0.025 }))
	} else
		expect(await pending).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/without observed actual cost/) }),
		)
})

it("cancels the captured root once when aggregate child spend reaches the observed limit", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener(emitUsage("root", 0.04))
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		await listener(emitUsage("child", 0.025))
		await listener(emitUsage("child", 0.025))
		await listener({ eventName: AlphaCodeEventName.TaskAborted, payload: ["child"] })
		await listener({ eventName: AlphaCodeEventName.TaskAborted, payload: ["root"] })
	})
	const pending = runTaskInVscode(benchmarkInput())
	await vi.advanceTimersByTimeAsync(5000)
	await expect(pending).resolves.toBe("budget_exhausted")
	expect(mocks.send.mock.calls.filter(([command]) => command.commandName === TaskCommandName.CancelTask)).toEqual([
		[{ commandName: TaskCommandName.CancelTask, data: { taskId: "root" } }],
	])
	expect(mocks.updateMetrics).toHaveBeenLastCalledWith(11, expect.objectContaining({ cost: 0.065 }))
})

it("rejects root terminal evidence while an observed child has not settled", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		await listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: ["root", emitUsage("root", 0.01).payload[1], {}, { isSubtask: false }],
		})
	})
	const pending = runTaskInVscode(benchmarkInput()).catch((error) => error)
	await vi.advanceTimersByTimeAsync(3000)
	expect(await pending).toEqual(
		expect.objectContaining({ message: "Governed evaluation ended with unsettled child usage" }),
	)
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("does not treat a restarted child as terminal from its previous cancellation", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["root"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		await listener(emitUsage("child", 0.005))
		await listener({ eventName: AlphaCodeEventName.TaskAborted, payload: ["child"] })
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["child"] })
		await listener({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: ["root", emitUsage("root", 0.01).payload[1], {}, { isSubtask: false }],
		})
	})
	const pending = runTaskInVscode(benchmarkInput()).catch((error) => error)
	await vi.advanceTimersByTimeAsync(5000)
	expect(await pending).toEqual(
		expect.objectContaining({ message: "Governed evaluation ended with unsettled child usage" }),
	)
})

it.each([undefined, "code", "./Code.exe"])(
	"refuses local paid execution without an absolute host: %j",
	async (value) => {
		mocks.containerized = false
		vi.stubEnv("VSCODE_EXECUTABLE_PATH", value)
		await expect(runTaskInVscode(benchmarkInput())).rejects.toThrow(/absolute.*VSCODE_EXECUTABLE_PATH/)
		expect(mocks.spawn).not.toHaveBeenCalled()
		expect(mocks.prepareProfile).not.toHaveBeenCalled()
		expect(mocks.send).not.toHaveBeenCalled()
	},
)

it("binds local paid execution to a fresh owned profile and the current development extension", async () => {
	mocks.containerized = false
	mocks.identity = exactIdentity()
	const executable = path.resolve(process.platform === "win32" ? "test host/Code.exe" : "test host/code")
	vi.stubEnv("VSCODE_EXECUTABLE_PATH", executable)
	vi.stubEnv("ELECTRON_RUN_AS_NODE", "1")
	vi.stubEnv("VSCODE_IPC_HOOK_CLI", "foreign editor")
	vi.stubEnv("VSCODE_PORTABLE", "foreign portable profile")
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(benchmarkInput())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.spawn).toHaveBeenCalledOnce()
	const [command, args, spawnOptions] = mocks.spawn.mock.calls[0]!
	expect(command).toBe(executable)
	expect(args).toEqual(
		expect.arrayContaining([
			`--user-data-dir=${path.resolve("owned benchmark/user-data")}`,
			`--extensions-dir=${path.resolve("owned benchmark/extensions")}`,
			`--shared-data-dir=${path.resolve("owned benchmark/shared-data")}`,
			`--extensionDevelopmentPath=${path.resolve("../../src")}`,
		]),
	)
	expect(spawnOptions.shell).toBe(false)
	expect(spawnOptions.extendEnv).toBe(false)
	expect(spawnOptions.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
	expect(spawnOptions.env.VSCODE_IPC_HOOK_CLI).toBeUndefined()
	expect(spawnOptions.env.VSCODE_PORTABLE).toBeUndefined()
	expect(spawnOptions.env.ROO_CODE_IPC_SOCKET_PATH).toMatch(/evals-1-2-[a-f0-9]{16}\.sock$/)
	expect(mocks.prepareProfile).toHaveBeenCalledExactlyOnceWith({ vscodeVersion: "1.138.0" })
	expect(mocks.assertAncestry).toHaveBeenCalledExactlyOnceWith(process.pid, 100)
	expect(mocks.assertAncestry.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!)
	expect(mocks.readIdentity).toHaveBeenCalledWith(path.resolve("../../src"), "1.138.0")
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("isolates IPC even when separate owned databases reuse the same run and task IDs", async () => {
	mocks.containerized = false
	mocks.identity = exactIdentity()
	vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve(process.platform === "win32" ? "Code.exe" : "code"))
	const launchOnce = async () => {
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			mocks.listeners.get(IpcMessageType.Disconnect)!()
		})
		const pending = runTaskInVscode(benchmarkInput())
		const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		return mocks.spawn.mock.calls.at(-1)![2].env.ROO_CODE_IPC_SOCKET_PATH
	}
	const first = await launchOnce()
	const second = await launchOnce()
	expect(first).toMatch(/evals-1-2-[a-f0-9]{16}\.sock$/)
	expect(second).toMatch(/evals-1-2-[a-f0-9]{16}\.sock$/)
	expect(first).not.toBe(second)
})

it.each(["foreign host", "entrypoint changed", "manifest changed", "extension changed"])(
	"rejects local paid execution before dispatch when %s",
	async (reason) => {
		mocks.containerized = false
		mocks.identity = exactIdentity()
		vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve(process.platform === "win32" ? "Code.exe" : "code"))
		if (reason === "foreign host") mocks.assertAncestry.mockRejectedValue(new Error("Foreign evaluator host"))
		else if (reason === "extension changed")
			mocks.readIdentity.mockResolvedValue({ ...exactIdentity(), extensionVersion: "2.0.0" })
		else
			mocks.readIdentity.mockResolvedValue({
				...exactIdentity(),
				[reason === "entrypoint changed" ? "entrypointDigest" : "manifestDigest"]: `sha256:${"c".repeat(64)}`,
			})
		mocks.wait.mockResolvedValue(undefined)
		const pending = runTaskInVscode(benchmarkInput())
		const rejection = expect(pending).rejects.toThrow(reason === "foreign host" ? /Foreign/ : /current extension/)
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.reap).toHaveBeenCalledOnce()
	},
)

it("keeps the existing container contract independent of local-only source helpers", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(benchmarkInput())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.spawn.mock.calls[0]![0]).toBe("xvfb-run")
	expect(mocks.prepareProfile).not.toHaveBeenCalled()
	expect(mocks.assertAncestry).not.toHaveBeenCalled()
	expect(mocks.readIdentity).not.toHaveBeenCalled()
})

it("preserves installed-editor launch for a legacy local task", async () => {
	mocks.containerized = false
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(13_000)
	await rejection
	expect(mocks.spawn.mock.calls[0]![0]).toBe(process.platform === "win32" ? "code.cmd" : "code")
	expect(mocks.prepareProfile).not.toHaveBeenCalled()
	expect(mocks.assertAncestry).not.toHaveBeenCalled()
	expect(mocks.readIdentity).not.toHaveBeenCalled()
})

it.each(["wrong version", "missing server process"])(
	"rejects an isolated host with %s before dispatch",
	async (reason) => {
		mocks.containerized = false
		mocks.identity = exactIdentity()
		if (reason === "wrong version") mocks.identity.hostVersion = "1.139.1"
		else mocks.serverProcess = undefined
		vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve(process.platform === "win32" ? "Code.exe" : "code"))
		mocks.wait.mockResolvedValue(undefined)
		const pending = runTaskInVscode(benchmarkInput())
		const rejection = expect(pending).rejects.toThrow(
			reason === "wrong version" ? /exact VS Code 1.138.0/ : /process identity/,
		)
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.assertAncestry).not.toHaveBeenCalled()
		expect(mocks.reap).toHaveBeenCalledOnce()
	},
)

it.each(["completed", "cancelled"] as const)("observes owned host cleanup after %s", async (outcome) => {
	mocks.containerized = false
	mocks.identity = exactIdentity()
	vi.stubEnv("VSCODE_EXECUTABLE_PATH", path.resolve(process.platform === "win32" ? "Code.exe" : "code"))
	const emit = async (event: TaskEvent) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener(event)
	}
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		await emit({ eventName: AlphaCodeEventName.TaskStarted, payload: ["alpha-task"] })
		if (outcome === "completed")
			await emit({
				eventName: AlphaCodeEventName.TaskCompleted,
				payload: [
					"alpha-task",
					{ totalCost: 0, totalTokensIn: 0, totalTokensOut: 0, contextTokens: 0 },
					{},
					{ isSubtask: false },
				],
			})
		else {
			await emit({
				eventName: AlphaCodeEventName.TaskTokenUsageUpdated,
				payload: ["alpha-task", { totalCost: 0, totalTokensIn: 0, totalTokensOut: 0, contextTokens: 0 }, {}],
			})
			await emit({ eventName: AlphaCodeEventName.TaskAborted, payload: ["alpha-task"] })
		}
	})
	mocks.reap.mockImplementation(async () => {
		expect(mocks.spawn.mock.calls[0]![2].cancelSignal.aborted).toBe(outcome === "cancelled")
	})
	const pending = runTaskInVscode(benchmarkInput())
	await vi.advanceTimersByTimeAsync(5_000)
	await expect(pending).resolves.toBe(outcome)
	expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ commandName: "CloseTask" }))
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.spawn.mock.calls[0]![2].cancelSignal.aborted).toBe(true)
})

it.each([0.02, 0.2])(
	"narrows the governed cost pause while preserving a stricter configured limit %s",
	async (configured) => {
		mocks.identity = exactIdentity()
		const options = benchmarkInput()
		options.run.settings = { ...options.run.settings, allowedMaxCost: configured }
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			mocks.listeners.get(IpcMessageType.Disconnect)!()
		})
		const pending = runTaskInVscode(options)
		const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				commandName: TaskCommandName.StartNewTask,
				data: expect.objectContaining({
					configuration: expect.objectContaining({ allowedMaxCost: Math.min(configured, 0.06) }),
				}),
			}),
		)
	},
)

it("passes authoritative run pricing into existing cached and uncached cost calculation without losing model metadata", async () => {
	mocks.identity = exactIdentity()
	const options = benchmarkInput()
	options.run.settings = {
		...options.run.settings,
		openAiCustomModelInfo: {
			contextWindow: 200_000,
			maxTokens: 8192,
			supportsImages: false,
			supportsPromptCache: true,
			inputPrice: 0,
			outputPrice: 0,
			cacheReadsPrice: 0,
			cacheWritesPrice: 0,
		},
	}
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(options)
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	const start = mocks.send.mock.calls.find(([command]) => command.commandName === TaskCommandName.StartNewTask)![0]
	const info = start.data.configuration.openAiCustomModelInfo
	expect(info).toMatchObject({
		contextWindow: 200_000,
		maxTokens: 8192,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1,
		outputPrice: 6,
		cacheReadsPrice: 0.1,
		cacheWritesPrice: 1.25,
	})
	expect(calculateApiCostOpenAI(info, 1000, 500).totalCost).toBeCloseTo(0.004)
	expect(calculateApiCostOpenAI(info, 1000, 500, 0, 400).totalCost).toBeCloseTo(0.00364)
})

it.each([
	["inputPrice", null],
	["outputPrice", Number.NaN],
	["cacheReadsPrice", -1],
	["cacheWritesPrice", Number.POSITIVE_INFINITY],
] as const)("refuses unavailable governed %s before spawning or dispatching", async (field, value) => {
	const options = benchmarkInput()
	options.run[field] = value
	await expect(runTaskInVscode(options)).rejects.toThrow(/known finite nonnegative/)
	expect(mocks.spawn).not.toHaveBeenCalled()
	expect(mocks.send).not.toHaveBeenCalled()
})

it("refuses a governed model or provider that differs from the recorded run before spawning", async () => {
	const options = benchmarkInput()
	options.run.settings = { apiProvider: "openai", openAiModelId: "different-model" }
	await expect(runTaskInVscode(options)).rejects.toThrow(/model to match the run identity/)
	options.run.settings = { apiProvider: "anthropic" }
	await expect(runTaskInVscode(options)).rejects.toThrow(/model to match the run identity/)
	expect(mocks.spawn).not.toHaveBeenCalled()
	expect(mocks.send).not.toHaveBeenCalled()
})

it("cancels governed usage at the observed cost threshold once and retains the budget terminal result", async () => {
	mocks.identity = exactIdentity()
	const options = benchmarkInput()
	options.run.settings = { ...options.run.settings, allowedMaxCost: 0.02 }
	const emit = async (event: TaskEvent) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener(event)
	}
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		await emit({ eventName: AlphaCodeEventName.TaskStarted, payload: ["alpha-task"] })
		for (let duplicate = 0; duplicate < 2; duplicate++)
			await emit({
				eventName: AlphaCodeEventName.TaskTokenUsageUpdated,
				payload: [
					"alpha-task",
					{ totalCost: 0.02, totalTokensIn: 100, totalTokensOut: 50, contextTokens: 100 },
					{},
				],
			})
		await emit({ eventName: AlphaCodeEventName.TaskAborted, payload: ["alpha-task"] })
	})
	const pending = runTaskInVscode(options)
	await vi.advanceTimersByTimeAsync(5000)
	await expect(pending).resolves.toBe("budget_exhausted")
	expect(
		mocks.send.mock.calls.filter(([command]) => command.commandName === TaskCommandName.CancelTask),
	).toHaveLength(1)
	const receipt = mocks.writeReceipt.mock.calls.find(([file]) => file.endsWith(".cost.json"))!
	expect(JSON.parse(receipt[1])).toMatchObject({
		observedCostLimitUsd: 0.02,
		latestObservedCostUsd: 0.02,
		costBudgetExceeded: true,
		costCancellationSent: true,
		inFlightResponseMayOvershoot: true,
	})
})

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
	"rejects invalid governed usage instead of treating it as zero: %s",
	async (cost) => {
		mocks.identity = exactIdentity()
		const emit = async (event: TaskEvent) => {
			const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (
				event: TaskEvent,
			) => Promise<void>
			await listener(event)
		}
		mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
			await emit({ eventName: AlphaCodeEventName.TaskStarted, payload: ["alpha-task"] })
			await emit({
				eventName: AlphaCodeEventName.TaskTokenUsageUpdated,
				payload: [
					"alpha-task",
					{ totalCost: cost, totalTokensIn: 100, totalTokensOut: 50, contextTokens: 100 },
					{},
				],
			})
			await emit({ eventName: AlphaCodeEventName.TaskAborted, payload: ["alpha-task"] })
		})
		const pending = runTaskInVscode(benchmarkInput())
		const rejection = expect(pending).rejects.toThrow(/unavailable or invalid actual cost/)
		await vi.advanceTimersByTimeAsync(3000)
		await rejection
		expect(
			mocks.send.mock.calls.filter(([command]) => command.commandName === TaskCommandName.CancelTask),
		).toHaveLength(1)
		const receipt = mocks.writeReceipt.mock.calls.find(([file]) => file.endsWith(".cost.json"))!
		expect(JSON.parse(receipt[1])).toMatchObject({ latestObservedCostUsd: null, costAccountingFailed: true })
	},
)

it("refuses terminal cancellation without any observed usage rather than settling artificial zero", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener({ eventName: AlphaCodeEventName.TaskStarted, payload: ["alpha-task"] })
		await listener({ eventName: AlphaCodeEventName.TaskAborted, payload: ["alpha-task"] })
	})
	const pending = runTaskInVscode(benchmarkInput())
	const rejection = expect(pending).rejects.toThrow(/without observed actual cost/)
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("fails a governed lifecycle timeout instead of allowing another paid task", async () => {
	mocks.identity = exactIdentity()
	mocks.wait.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("timeout"))
	const pending = runTaskInVscode(benchmarkInput())
	const rejection = expect(pending).rejects.toThrow(/terminal event before timeout/)
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("refuses a paid benchmark before dispatch when execution identity is missing", async () => {
	const options = benchmarkInput()
	options.run.campaignHardCapUsd = 2
	options.run.taskCostCapUsd = 0.06
	options.task.benchmarkTaskIdentity = "fixture@1"
	mocks.wait.mockResolvedValue(undefined)
	const pending = runTaskInVscode(options)
	const rejection = expect(pending).rejects.toThrow("Executed harness identity unavailable")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.send).not.toHaveBeenCalled()
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
})

it("preserves the caller's logger after successful execution", async () => {
	const emit = async (event: TaskEvent) => {
		const listener = mocks.listeners.get(IpcMessageType.TaskEvent) as unknown as (event: TaskEvent) => Promise<void>
		await listener(event)
	}
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		await emit({ eventName: AlphaCodeEventName.TaskStarted, payload: ["alpha-task"] })
		await emit({
			eventName: AlphaCodeEventName.TaskCompleted,
			payload: [
				"alpha-task",
				{ totalCost: 0, totalTokensIn: 0, totalTokensOut: 0, contextTokens: 0 },
				{},
				{ isSubtask: false },
			],
		})
	})
	const pending = runTaskInVscode(input())
	await vi.advanceTimersByTimeAsync(5_000)
	await expect(pending).resolves.toBe("completed")
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
})

it("captures exact-host execution identity before dispatch, preserving process cleanup", async () => {
	mocks.identity = {
		schemaVersion: 1,
		hostVersion: "1.138.0",
		extensionId: "Alpha.alpha",
		extensionVersion: "1.0.0",
		entrypointDigest: `sha256:${"a".repeat(64)}`,
		manifestDigest: `sha256:${"b".repeat(64)}`,
		identityScope: "observed-entrypoint-and-manifest",
	}
	const options = input()
	options.onExecutionIdentity = vi.fn().mockResolvedValue(undefined)
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	const pending = runTaskInVscode(options)
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(options.onExecutionIdentity).toHaveBeenCalledWith(mocks.identity)
	expect(mocks.writeReceipt).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"pid":100'), {
		mode: 0o600,
	})
	expect(mocks.writeReceipt.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!)
	expect(mocks.reap).toHaveBeenCalledOnce()
})

it("rejects another host version before dispatch", async () => {
	mocks.identity = {
		schemaVersion: 1,
		hostVersion: "1.136.1",
		extensionId: "Alpha.alpha",
		extensionVersion: "1.0.0",
		entrypointDigest: `sha256:${"a".repeat(64)}`,
		manifestDigest: `sha256:${"b".repeat(64)}`,
		identityScope: "observed-entrypoint-and-manifest",
	}
	mocks.wait.mockResolvedValue(undefined)
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("exact VS Code 1.138.0")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.send).not.toHaveBeenCalled()
})

it("aborts and reaps the subprocess without closing the caller's logger after all IPC connections fail", async () => {
	mocks.wait.mockRejectedValue(new Error("IPC unavailable"))
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Unable to connect")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.spawn.mock.calls[0]![2].cancelSignal.aborted).toBe(true)
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
	expect(mocks.disconnect).toHaveBeenCalled()
})

it("preserves premature disconnect failure when cleanup also fails", async () => {
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	mocks.reap.mockRejectedValue(new Error("cleanup failure"))
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
})

it("observes early process rejection during startup and retains the spawn failure", async () => {
	const spawnFailure = new Error("spawn failed")
	mocks.spawn.mockReturnValueOnce(Promise.reject(spawnFailure))
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toBe(spawnFailure)
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.wait).not.toHaveBeenCalled()
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
})

it("still reaps the process when disconnect cleanup throws", async () => {
	mocks.wait.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
		mocks.listeners.get(IpcMessageType.Disconnect)!()
	})
	mocks.disconnect.mockImplementation(() => {
		throw new Error("disconnect cleanup failed")
	})
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Client disconnected before task completion")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).not.toHaveBeenCalled()
})
