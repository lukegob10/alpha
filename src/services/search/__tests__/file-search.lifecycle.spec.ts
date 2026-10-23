import { EventEmitter } from "node:events"
import path from "node:path"
import { PassThrough } from "node:stream"

import { executeRipgrep } from "../file-search"

const { spawn, getBinPath, executeWithRipgrepFallback } = vi.hoisted(() => ({
	spawn: vi.fn(),
	getBinPath: vi.fn(),
	executeWithRipgrepFallback: vi.fn(),
}))

vi.mock("child_process", () => ({ spawn }))
vi.mock("../../ripgrep", () => ({
	getBinPath,
	executeWithRipgrepFallback,
	createRipgrepProcessError: (error: Error) => new Error(`ripgrep process error: ${error.message}`, { cause: error }),
}))

describe("file-search ripgrep process lifecycle", () => {
	const workspacePath = path.resolve("/owned/workspace")
	let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
	let started: Promise<void>

	beforeEach(() => {
		child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn().mockReturnValue(true),
		})
		getBinPath.mockReset().mockResolvedValue("/owned/rg")
		executeWithRipgrepFallback.mockReset().mockImplementation((binaryPath, execute) => execute(binaryPath))
		started = new Promise<void>((resolve) => {
			spawn.mockReset().mockImplementation(() => {
				resolve()
				return child
			})
		})
	})

	afterEach(() => {
		child.stdout.destroy()
		child.stderr.destroy()
	})

	function search(options: { limit?: number; signal?: AbortSignal } = {}) {
		return executeRipgrep({ args: ["--files", workspacePath], workspacePath, ...options })
	}

	async function endStdout(content = "") {
		child.stdout.end(content)
		// Drain stream EOF/readline events and their promise continuations without timing assumptions.
		await new Promise<void>((resolve) => setImmediate(resolve))
	}

	it("waits for child close after stdout has ended", async () => {
		const running = search()
		const settled = vi.fn()
		void running.then(settled, settled)
		await started
		await endStdout()
		const settledBeforeClose = settled.mock.calls.length
		child.emit("close", 0, null)

		await expect(running).resolves.toEqual([])
		expect(settledBeforeClose).toBe(0)
		expect(child.listenerCount("error")).toBe(0)
		expect(child.stderr.listenerCount("data")).toBe(0)
		expect(child.stderr.listenerCount("error")).toBe(0)
	})

	it("preserves a late spawn error and its fallback cause after stdout EOF", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		await endStdout()
		const cause = Object.assign(new Error("spawn /owned/rg ENOENT"), {
			code: "ENOENT",
			path: "/owned/rg",
			syscall: "spawn /owned/rg",
		})
		child.emit("error", cause)
		child.emit("close", -2, null)

		expect(await running).toMatchObject({ message: expect.stringContaining("ENOENT"), cause })
	})

	it("joins process-error settlement and preserves the first failure after partial output", async () => {
		const running = search().catch((error: unknown) => error)
		const settled = vi.fn()
		void running.then(settled)
		await started
		child.stdout.write(path.join(workspacePath, "partial.ts") + "\n")
		const cause = new Error("owned process failure")
		child.emit("error", cause)
		child.emit("error", new Error("secondary process failure"))
		await endStdout()
		const settledBeforeClose = settled.mock.calls.length
		child.emit("close", 2, null)

		expect(await running).toMatchObject({ cause })
		expect(settledBeforeClose).toBe(0)
	})

	it("rejects a failed no-result exit even when stderr is empty", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		await endStdout()
		child.emit("close", 2, null)

		expect(await running).toMatchObject({ message: expect.stringContaining("code 2") })
	})

	it("includes stderr that arrives after stdout EOF in a failed search", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		await endStdout()
		child.stderr.write("late filesystem error")
		child.emit("close", 2, null)

		expect(await running).toMatchObject({ message: expect.stringContaining("late filesystem error") })
	})

	it("treats exit 1 without stderr as an ordinary empty result", async () => {
		const running = search()
		await started
		await endStdout()
		child.emit("close", 1, null)

		await expect(running).resolves.toEqual([])
	})

	it("preserves partial files and parent directories for filesystem-error exits", async () => {
		const running = search()
		await started
		child.stderr.write("some directories could not be read")
		await endStdout(path.join(workspacePath, "src", "found.ts"))
		child.emit("close", 2, null)

		await expect(running).resolves.toEqual([
			{ path: path.join("src", "found.ts"), type: "file", label: "found.ts" },
			{ path: "src", type: "folder", label: "src" },
		])
	})

	it("rejects unexpected signal termination even when partial files were collected", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		await endStdout(path.join(workspacePath, "partial.ts"))
		child.emit("close", null, "SIGKILL")

		expect(await running).toMatchObject({ message: expect.stringContaining("signal SIGKILL") })
	})

	it("joins limit termination before returning bounded partial results", async () => {
		const running = search({ limit: 1 })
		const settled = vi.fn()
		void running.then(settled, settled)
		await started
		await endStdout(["first.ts", "second.ts", "third.ts"].map((file) => path.join(workspacePath, file)).join("\n"))
		const settledBeforeClose = settled.mock.calls.length
		child.emit("close", null, "SIGTERM")

		await expect(running).resolves.toEqual([{ path: "first.ts", type: "file", label: "first.ts" }])
		expect(settledBeforeClose).toBe(0)
		expect(child.kill).toHaveBeenCalledOnce()
	})

	it("does not turn cancellation after stdout EOF into a successful result", async () => {
		const controller = new AbortController()
		const reason = new Error("file search cancelled")
		const running = search({ signal: controller.signal }).catch((error: unknown) => error)
		await started
		await endStdout(path.join(workspacePath, "partial.ts"))
		controller.abort(reason)
		child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
		child.emit("close", null, "SIGTERM")

		expect(await running).toBe(reason)
	})

	it("keeps an aborted process owned until its close event", async () => {
		const controller = new AbortController()
		const reason = new Error("file search cancelled")
		const running = search({ signal: controller.signal }).catch((error: unknown) => error)
		const settled = vi.fn()
		void running.then(settled)
		await started
		controller.abort(reason)
		child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
		await endStdout()
		const settledBeforeClose = settled.mock.calls.length
		child.emit("close", null, "SIGTERM")

		expect(await running).toBe(reason)
		expect(settledBeforeClose).toBe(0)
		expect(executeWithRipgrepFallback).toHaveBeenCalledWith(
			"/owned/rg",
			expect.any(Function),
			undefined,
			controller.signal,
		)
	})

	it.each(["stdout", "stderr"] as const)("stops and joins the child when %s fails", async (stream) => {
		const running = search().catch((error: unknown) => error)
		const settled = vi.fn()
		void running.then(settled)
		await started
		const cause = new Error(`${stream} read failed`)
		child[stream].emit("error", cause)
		await endStdout()
		const settledBeforeClose = settled.mock.calls.length
		child.emit("close", null, "SIGTERM")

		expect(await running).toMatchObject({ cause })
		expect(settledBeforeClose).toBe(0)
		expect(child.kill).toHaveBeenCalledOnce()
	})

	it("preserves UTF-8 diagnostic characters split across stderr chunks", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		const diagnostic = Buffer.from("file ☃ could not be read")
		const boundary = Buffer.byteLength("file ") + 1
		child.stderr.write(diagnostic.subarray(0, boundary))
		child.stderr.write(diagnostic.subarray(boundary))
		await endStdout()
		child.emit("close", 2, null)

		expect(await running).toMatchObject({ message: expect.stringContaining("file ☃ could not be read") })
	})

	it("bounds retained stderr while continuing to drain later chunks", async () => {
		const running = search().catch((error: unknown) => error)
		await started
		child.stderr.write(Buffer.from("diagnostic prefix\n"))
		child.stderr.write(Buffer.alloc(1024 * 1024, "x"))
		child.stderr.write(Buffer.from("unretained diagnostic tail"))
		await endStdout()
		child.emit("close", 2, null)
		const error = await running

		expect(error).toBeInstanceOf(Error)
		if (!(error instanceof Error)) throw new Error("Expected ripgrep failure")
		expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(64 * 1024 + 128)
		expect(error.message.startsWith("ripgrep process error:")).toBe(true)
		expect(error.message.includes("diagnostic prefix")).toBe(true)
		expect(error.message.includes("[stderr truncated]")).toBe(true)
		expect(error.message.includes("unretained diagnostic tail")).toBe(false)
	})
})
