import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { BenchmarkWorkerCleanupError, runBenchmarkWorkers } from "../benchmarks/AgentControlBenchmarkWorkers"

const worker = () => {
	const emitter = new EventEmitter()
	const send = vi.fn((_message: string, callback: (error: Error | null) => void) => {
		callback(null)
		return true
	})
	const kill = vi.fn(() => true)
	const child = Object.assign(emitter, { send, kill, stderr: new EventEmitter() }) as unknown as ChildProcess
	return {
		child,
		send,
		kill,
		message: (message: unknown) => emitter.emit("message", message),
		close: (code = 0) => emitter.emit("close", code, null),
	}
}

describe("agent control benchmark worker ownership", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("synchronizes each barrier and waits for both process close events before resolving", async () => {
		const children = [worker(), worker()]
		const run = runBenchmarkWorkers<number>({
			writers: 2,
			timeoutMs: 30_000,
			spawn: (index) => children[index].child,
		})
		let settled = false
		void run.then(() => {
			settled = true
		})
		children[0].message({ type: "ready" })
		expect(children[0].send).not.toHaveBeenCalled()
		children[1].message({ type: "ready" })
		for (const child of children) expect(child.send).toHaveBeenCalledWith("initialize", expect.any(Function))
		for (const child of children) child.message({ type: "warmed" })
		for (const child of children) expect(child.send).toHaveBeenCalledWith("measure", expect.any(Function))
		children[0].message({ type: "result", value: 10 })
		children[1].message({ type: "result", value: 20 })
		for (const child of children) expect(child.send).toHaveBeenCalledWith("finish", expect.any(Function))
		children[0].close()
		await Promise.resolve()
		expect(settled).toBe(false)
		children[1].close()
		await expect(run).resolves.toEqual([10, 20])
		for (const child of children) expect(child.kill).not.toHaveBeenCalled()
	})

	it("bounds a stuck startup and waits for termination before returning the deadline error", async () => {
		vi.useFakeTimers()
		const child = worker()
		const result = runBenchmarkWorkers({ writers: 1, timeoutMs: 1_000, spawn: () => child.child }).catch(
			(error: unknown) => error,
		)
		let settled = false
		void result.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(1_000)
		expect(child.kill).toHaveBeenCalledWith("SIGTERM")
		expect(settled).toBe(false)
		child.close(1)
		await expect(result).resolves.toMatchObject({ message: "Benchmark harness deadline exceeded (1000 ms)" })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects IPC loss and stops every sibling before fixture cleanup can proceed", async () => {
		const children = [worker(), worker()]
		const result = runBenchmarkWorkers({
			writers: 2,
			timeoutMs: 30_000,
			spawn: (index) => children[index].child,
		}).catch((error: unknown) => error)
		children[0].child.emit("disconnect")
		await Promise.resolve()
		for (const child of children) expect(child.kill).toHaveBeenCalledWith("SIGTERM")
		let settled = false
		void result.then(() => {
			settled = true
		})
		children[0].close(1)
		await Promise.resolve()
		expect(settled).toBe(false)
		children[1].close(1)
		await expect(result).resolves.toMatchObject({ message: "Benchmark worker 0 disconnected before its result" })
	})

	it("propagates interruption and escalates termination without replacing the original failure", async () => {
		vi.useFakeTimers()
		const child = worker()
		const signal = new AbortController()
		const reason = new Error("requested stop")
		const result = runBenchmarkWorkers({
			writers: 1,
			timeoutMs: 30_000,
			signal: signal.signal,
			spawn: () => child.child,
		}).catch((error: unknown) => error)
		signal.abort(reason)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]])
		child.close(1)
		await expect(result).resolves.toMatchObject({ message: "Benchmark harness interrupted", cause: reason })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("cleans up an already-started worker when the next spawn throws", async () => {
		const child = worker()
		const original = new Error("spawn failed")
		const result = runBenchmarkWorkers({
			writers: 2,
			timeoutMs: 30_000,
			spawn: (index) => {
				if (index === 1) throw original
				return child.child
			},
		}).catch((error: unknown) => error)
		expect(child.kill).toHaveBeenCalledWith("SIGTERM")
		child.close(1)
		await expect(result).resolves.toBe(original)
	})

	it("marks unsafe cleanup so an unclosed worker's fixture is retained, preserving the first error", async () => {
		vi.useFakeTimers()
		const child = worker()
		const result = runBenchmarkWorkers({ writers: 1, timeoutMs: 1_000, spawn: () => child.child }).catch(
			(error: unknown) => error,
		)
		await vi.advanceTimersByTimeAsync(11_000)
		const error = await result
		expect(error).toBeInstanceOf(BenchmarkWorkerCleanupError)
		expect(error).toMatchObject({ cause: { message: "Benchmark harness deadline exceeded (1000 ms)" } })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects a duplicate barrier instead of counting it as another worker", async () => {
		const children = [worker(), worker()]
		const result = runBenchmarkWorkers({
			writers: 2,
			timeoutMs: 30_000,
			spawn: (index) => children[index].child,
		}).catch((error: unknown) => error)
		children[0].message({ type: "ready" })
		children[0].message({ type: "ready" })
		for (const child of children) child.close(1)
		await expect(result).resolves.toMatchObject({ message: "Unexpected benchmark worker 0 phase: ready" })
	})

	it("routes stderr stream failures through sibling termination and preserves the stream error", async () => {
		const children = [worker(), worker()]
		const original = new Error("stderr stream failed")
		const result = runBenchmarkWorkers({
			writers: 2,
			timeoutMs: 30_000,
			spawn: (index) => children[index].child,
		}).catch((error: unknown) => error)
		children[0].child.stderr!.emit("error", original)
		await Promise.resolve()
		for (const child of children) {
			expect(child.kill).toHaveBeenCalledWith("SIGTERM")
			child.close(1)
		}
		await expect(result).resolves.toBe(original)
	})
})
