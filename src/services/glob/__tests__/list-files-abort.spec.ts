import * as childProcess from "child_process"
import * as fs from "fs"
import * as path from "path"

import { listFiles } from "../list-files"
import { getBinPath } from "../../ripgrep"

vi.mock("child_process", () => ({
	spawn: vi.fn(),
}))

vi.mock("fs", () => ({
	constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
	promises: {
		access: vi.fn(),
		readFile: vi.fn(),
		readdir: vi.fn(),
		realpath: vi.fn(),
		lstat: vi.fn(),
		open: vi.fn(),
	},
}))

vi.mock("../../ripgrep", () => ({
	getBinPath: vi.fn(),
}))

vi.mock("../../../utils/path", () => ({
	arePathsEqual: vi.fn().mockReturnValue(false),
}))

type EventListener = (...args: any[]) => void

interface MockRipgrepProcess {
	process: {
		stdout: { on: ReturnType<typeof vi.fn> }
		stderr: { on: ReturnType<typeof vi.fn> }
		on: ReturnType<typeof vi.fn>
		kill: ReturnType<typeof vi.fn>
	}
	emitData(data: string): void
	emitClose(code?: number | null, signal?: NodeJS.Signals | null): void
	emitError(error: Error): void
}

function createMockRipgrepProcess(): MockRipgrepProcess {
	let onData: ((data: string) => void) | undefined
	let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
	let onError: ((error: Error) => void) | undefined

	const process = {
		stdout: {
			on: vi.fn((event: string, listener: EventListener) => {
				if (event === "data") onData = listener as (data: string) => void
			}),
		},
		stderr: {
			on: vi.fn(),
		},
		on: vi.fn((event: string, listener: EventListener) => {
			if (event === "close") onClose = listener as typeof onClose
			if (event === "error") onError = listener as (error: Error) => void
		}),
		kill: vi.fn(),
	}

	return {
		process,
		emitData: (data) => onData?.(data),
		emitClose: (code = 0, signal = null) => onClose?.(code, signal),
		emitError: (error) => onError?.(error),
	}
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise!: (value: T) => void
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
	for (let attempt = 0; attempt < 40 && mock.mock.calls.length === 0; attempt++) {
		await Promise.resolve()
	}
	expect(mock).toHaveBeenCalled()
}

async function waitForRipgrepSpawn(): Promise<void> {
	await waitForCall(vi.mocked(childProcess.spawn))
}

async function drainPromiseContinuations(): Promise<void> {
	await new Promise<void>((resolve) => process.nextTick(resolve))
}

describe("listFiles cancellation and strict execution", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getBinPath).mockResolvedValue("/mock/path/to/rg")
		vi.mocked(fs.promises.access).mockRejectedValue(
			Object.assign(new Error("missing .gitignore"), { code: "ENOENT" }),
		)
		vi.mocked(fs.promises.readFile).mockResolvedValue("")
		vi.mocked(fs.promises.readdir).mockResolvedValue([] as any)
		vi.mocked(fs.promises.realpath).mockImplementation(async (value) => path.resolve(String(value)))
		vi.mocked(fs.promises.lstat).mockRejectedValue(
			Object.assign(new Error("missing .gitignore"), { code: "ENOENT" }),
		)
		vi.mocked(fs.promises.open).mockReset()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not spawn ripgrep when the signal is already aborted", async () => {
		const controller = new AbortController()
		const reason = new Error("listing cancelled before start")
		controller.abort(reason)

		await expect(listFiles("/test/project", true, 10, controller.signal)).rejects.toBe(reason)

		expect(childProcess.spawn).not.toHaveBeenCalled()
		expect(getBinPath).not.toHaveBeenCalled()
	})

	it("disables symlink traversal explicitly for strict listings", async () => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10, undefined, {
			followSymlinks: false,
			rejectOnError: true,
		})
		await waitForRipgrepSpawn()
		ripgrep.emitData("file.txt\n")
		ripgrep.emitClose(0)

		await expect(listing).resolves.toEqual([[path.resolve("/test/project", "file.txt")], false])
		const args = vi.mocked(childProcess.spawn).mock.calls[0][1]
		expect(args).toContain("--no-follow")
		expect(args).not.toContain("--follow")
	})

	it.each([false, true])("joins child close before settling cancellation (strict=%s)", async (rejectOnError) => {
		const controller = new AbortController()
		const reason = new Error("listing cancelled")
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10, controller.signal, { rejectOnError })
		const settled = vi.fn()
		void listing.then(settled, settled)
		const rejection = expect(listing).rejects.toBe(reason)
		await waitForRipgrepSpawn()

		controller.abort(reason)
		await drainPromiseContinuations()
		expect(ripgrep.process.kill).toHaveBeenCalledTimes(1)
		expect(settled).not.toHaveBeenCalled()
		expect(fs.promises.readdir).not.toHaveBeenCalled()

		ripgrep.emitClose(null, "SIGTERM")
		await rejection
	})

	it.each([false, true])(
		"joins timeout termination and preserves strict failure status (strict=%s)",
		async (rejectOnError) => {
			vi.useFakeTimers()
			const ripgrep = createMockRipgrepProcess()
			vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
			const listing = listFiles("/test/project", false, 10, undefined, { rejectOnError })
			const settled = vi.fn()
			void listing.then(settled, settled)
			await waitForRipgrepSpawn()
			ripgrep.emitData("partial.ts\n")

			await vi.advanceTimersByTimeAsync(10_000)
			expect(ripgrep.process.kill).toHaveBeenCalledTimes(1)
			expect(settled).not.toHaveBeenCalled()
			ripgrep.emitData("late.ts\n")
			ripgrep.emitClose(null, "SIGTERM")

			if (rejectOnError) {
				await expect(listing).rejects.toMatchObject({ name: "FileListingTimeoutError", timedOut: true })
			} else {
				await expect(listing).resolves.toEqual([[path.resolve("/test/project", "partial.ts")], false])
			}
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it("joins a strict process error before rejecting", async () => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10, undefined, { rejectOnError: true })
		const settled = vi.fn()
		void listing.then(settled, settled)
		const rejection = expect(listing).rejects.toThrow("ripgrep failed")
		await waitForRipgrepSpawn()

		ripgrep.emitError(new Error("ripgrep failed"))
		await drainPromiseContinuations()
		expect(settled).not.toHaveBeenCalled()
		ripgrep.emitClose(-1)
		await rejection
		expect(fs.promises.readdir).not.toHaveBeenCalled()
	})

	it.each([
		[2, null],
		[null, "SIGTERM"],
	] as const)("rejects unexpected strict process exit %s/%s", async (code, signal) => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10, undefined, { rejectOnError: true })
		const rejection = expect(listing).rejects.toThrow("ripgrep process exited")
		await waitForRipgrepSpawn()
		ripgrep.emitData("partial.ts\n")
		ripgrep.emitClose(code, signal)
		await rejection
		expect(fs.promises.readdir).not.toHaveBeenCalled()
	})

	it("accepts an empty strict listing when ripgrep reports no matches", async () => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10, undefined, { rejectOnError: true })
		await waitForRipgrepSpawn()
		ripgrep.emitClose(1)
		await expect(listing).resolves.toEqual([[], false])
	})

	it("keeps strict output-limit termination bounded until child close", async () => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 1, undefined, { rejectOnError: true })
		const settled = vi.fn()
		void listing.then(settled, settled)
		await waitForRipgrepSpawn()
		ripgrep.emitData("first.ts\n")
		ripgrep.emitData("late.ts\n")
		await drainPromiseContinuations()
		expect(ripgrep.process.kill).toHaveBeenCalledTimes(1)
		expect(settled).not.toHaveBeenCalled()
		ripgrep.emitClose(null, "SIGTERM")
		await expect(listing).resolves.toEqual([[path.resolve("/test/project", "first.ts")], true])
	})

	it.each(["lstat", "open", "readdir"] as const)(
		"rejects strict %s failures instead of partial success",
		async (operation) => {
			const error = Object.assign(new Error(`${operation} denied`), { code: "EACCES" })
			const ripgrep = createMockRipgrepProcess()
			vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
			if (operation === "open") {
				vi.mocked(fs.promises.lstat).mockResolvedValue({
					isSymbolicLink: () => false,
					isFile: () => true,
					nlink: 1,
					size: 0,
				} as any)
			}
			vi.mocked(fs.promises[operation]).mockRejectedValue(error)
			const listing = listFiles("/test/project", false, 10, undefined, { rejectOnError: true })
			const rejection = expect(listing).rejects.toBe(error)
			if (operation === "readdir") {
				await waitForRipgrepSpawn()
				ripgrep.emitClose(0)
			}
			await rejection
		},
	)

	it("preserves legacy partial results on a nonzero process exit", async () => {
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		const listing = listFiles("/test/project", false, 10)
		await waitForRipgrepSpawn()
		ripgrep.emitData("partial.ts\n")
		ripgrep.emitClose(2)
		await expect(listing).resolves.toEqual([[path.resolve("/test/project", "partial.ts")], false])
	})

	it("kills ripgrep once and preserves the abort across close and error races", async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const reason = new Error("listing cancelled")
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener")
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		ripgrep.process.kill.mockImplementation(() => {
			ripgrep.emitClose(0)
			ripgrep.emitError(new Error("late ripgrep error"))
		})

		const listing = listFiles("/test/project", false, 10, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitData("partial.ts\n")
		const rejection = expect(listing).rejects.toBe(reason)

		controller.abort(reason)
		ripgrep.emitData("late.ts\n")

		await rejection
		expect(ripgrep.process.kill).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	it("removes the cancellation listener and timeout after ripgrep completes", async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener")
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)

		const listing = listFiles("/test/project", false, 10, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitData("file.txt\n")
		ripgrep.emitClose(0)

		await expect(listing).resolves.toEqual([[path.resolve("/test/project", "file.txt")], false])
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
		expect(vi.getTimerCount()).toBe(0)
	})

	it("removes the cancellation listener and timeout after a ripgrep error", async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener")
		const ripgrep = createMockRipgrepProcess()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)

		const listing = listFiles("/test/project", false, 10, controller.signal)
		await waitForRipgrepSpawn()
		const rejection = expect(listing).rejects.toThrow("ripgrep process error")

		ripgrep.emitError(new Error("ripgrep failed"))

		await rejection
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
		expect(vi.getTimerCount()).toBe(0)
	})

	it("stops before directory scanning when cancelled during gitignore loading", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled while loading ignore rules")
		const ripgrep = createMockRipgrepProcess()
		const readFile = createDeferred<string>()
		let accessCalls = 0
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		vi.mocked(fs.promises.access).mockImplementation(async () => {
			accessCalls++
			if (accessCalls > 2) throw new Error("missing .gitignore")
		})
		vi.mocked(fs.promises.readFile).mockReturnValue(readFile.promise as any)

		const listing = listFiles("/test/project", false, 10, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitClose(0)
		await waitForCall(vi.mocked(fs.promises.readFile))

		const rejection = expect(listing).rejects.toBe(reason)
		controller.abort(reason)
		readFile.resolve("")

		await rejection
		expect(fs.promises.readFile).toHaveBeenCalledTimes(1)
		expect(fs.promises.readdir).not.toHaveBeenCalled()
	})

	it("stops before nested directory work when cancelled during a filesystem scan", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled while scanning directories")
		const ripgrep = createMockRipgrepProcess()
		const readdir = createDeferred<any[]>()
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		vi.mocked(fs.promises.readdir).mockReturnValue(readdir.promise as any)

		const listing = listFiles("/test/project", false, 10, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitClose(0)
		await waitForCall(vi.mocked(fs.promises.readdir))

		const rejection = expect(listing).rejects.toBe(reason)
		controller.abort(reason)
		readdir.resolve([
			{
				name: "nested",
				isDirectory: () => true,
				isSymbolicLink: () => false,
			},
		])

		await rejection
		expect(fs.promises.readdir).toHaveBeenCalledTimes(1)
	})

	it("stops first-level directory fallback after cancellation", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled while finding first-level directories")
		const ripgrep = createMockRipgrepProcess()
		const readdir = createDeferred<any[]>()
		const isDirectory = vi.fn(() => true)
		const isSymbolicLink = vi.fn(() => false)
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		vi.mocked(fs.promises.readdir).mockReturnValue(readdir.promise as any)

		const listing = listFiles("/test/project", true, 1, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitData("file.txt\n")
		ripgrep.emitClose(0)
		await waitForCall(vi.mocked(fs.promises.readdir))

		const rejection = expect(listing).rejects.toBe(reason)
		controller.abort(reason)
		readdir.resolve([
			{
				name: "nested",
				isDirectory,
				isSymbolicLink,
			},
		])

		await rejection
		expect(fs.promises.readdir).toHaveBeenCalledTimes(1)
		expect(isDirectory).not.toHaveBeenCalled()
		expect(isSymbolicLink).not.toHaveBeenCalled()
	})

	it("stops first-level directory fallback between entries when cancelled", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled between first-level directories")
		const ripgrep = createMockRipgrepProcess()
		const readdir = createDeferred<any[]>()
		const firstIsDirectory = vi.fn(() => {
			controller.abort(reason)
			return false
		})
		const secondIsDirectory = vi.fn(() => true)
		const secondIsSymbolicLink = vi.fn(() => false)
		vi.mocked(childProcess.spawn).mockReturnValue(ripgrep.process as any)
		vi.mocked(fs.promises.readdir).mockReturnValue(readdir.promise as any)

		const listing = listFiles("/test/project", true, 1, controller.signal)
		await waitForRipgrepSpawn()
		ripgrep.emitData("file.txt\n")
		ripgrep.emitClose(0)
		await waitForCall(vi.mocked(fs.promises.readdir))

		const rejection = expect(listing).rejects.toBe(reason)
		readdir.resolve([
			{
				name: "first",
				isDirectory: firstIsDirectory,
				isSymbolicLink: vi.fn(),
			},
			{
				name: "second",
				isDirectory: secondIsDirectory,
				isSymbolicLink: secondIsSymbolicLink,
			},
		])

		await rejection
		expect(firstIsDirectory).toHaveBeenCalledTimes(1)
		expect(secondIsDirectory).not.toHaveBeenCalled()
		expect(secondIsSymbolicLink).not.toHaveBeenCalled()
	})
})
