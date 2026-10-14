import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { RunTaskOptions } from "../types"

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	wait: vi.fn(),
	reap: vi.fn(),
	disconnect: vi.fn(),
	close: vi.fn(),
	send: vi.fn(),
	identity: undefined as import("@alpha-code/types").ExecutionIdentity | undefined,
	writeReceipt: vi.fn(),
	listeners: new Map<string, () => void>(),
}))
vi.mock("fs", () => ({
	existsSync: () => true,
	readFileSync: () => "fixture prompt",
	promises: { writeFile: mocks.writeReceipt },
}))
vi.mock("execa", () => ({ execa: mocks.spawn }))
vi.mock("p-wait-for", () => ({ default: mocks.wait }))
vi.mock("../../db/index", () => ({
	updateTask: vi.fn(),
	createTaskMetrics: vi.fn(),
	updateTaskMetrics: vi.fn(),
	createToolError: vi.fn(),
}))
vi.mock("../utils", () => ({
	isDockerContainer: () => true,
	copyConversationHistory: vi.fn(),
	mergeToolUsage: vi.fn(),
	waitForSubprocessWithTimeout: mocks.reap,
}))
vi.mock("@alpha-code/ipc", () => ({
	IpcClient: class {
		isReady = true
		executionIdentity = mocks.identity
		serverProcess = { pid: 100, ppid: 99 }
		disconnect = mocks.disconnect
		on(name: string, listener: () => void) {
			mocks.listeners.set(name, listener)
		}
		sendCommand = mocks.send
	},
}))
import { IpcMessageType } from "@alpha-code/types"
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
	mocks.writeReceipt.mockResolvedValue(undefined)
	mocks.spawn.mockReturnValue(new Promise(() => {}))
	mocks.reap.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

it("refuses a paid benchmark before dispatch when execution identity is missing", async () => {
	const options = input()
	options.run.campaignHardCapUsd = 2
	options.task.benchmarkTaskIdentity = "fixture@1"
	mocks.wait.mockResolvedValue(undefined)
	const pending = runTaskInVscode(options)
	const rejection = expect(pending).rejects.toThrow("Executed harness identity unavailable")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.send).not.toHaveBeenCalled()
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).toHaveBeenCalledOnce()
})

it("captures exact-host execution identity before dispatch, preserving process cleanup", async () => {
	mocks.identity = {
		schemaVersion: 1,
		hostVersion: "1.125.0",
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
	const rejection = expect(pending).rejects.toThrow("exact VS Code 1.125.0")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.send).not.toHaveBeenCalled()
})

it("aborts and reaps the subprocess and closes the logger after all IPC connections fail", async () => {
	mocks.wait.mockRejectedValue(new Error("IPC unavailable"))
	const pending = runTaskInVscode(input())
	const rejection = expect(pending).rejects.toThrow("Unable to connect")
	await vi.advanceTimersByTimeAsync(3000)
	await rejection
	expect(mocks.spawn.mock.calls[0]![2].cancelSignal.aborted).toBe(true)
	expect(mocks.reap).toHaveBeenCalledOnce()
	expect(mocks.close).toHaveBeenCalledOnce()
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
	expect(mocks.close).toHaveBeenCalledOnce()
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
	expect(mocks.close).toHaveBeenCalledOnce()
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
	expect(mocks.close).toHaveBeenCalledOnce()
})
