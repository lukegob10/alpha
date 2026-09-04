import * as childProcess from "child_process"
import * as fs from "fs"
import * as path from "path"

import { listFiles } from "../list-files"
import { getBinPath } from "../../ripgrep"

vi.mock("child_process", () => ({
	spawn: vi.fn(),
}))

vi.mock("fs", () => ({
	promises: {
		access: vi.fn(),
		readFile: vi.fn(),
		readdir: vi.fn(),
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
	emitClose(code?: number | null): void
	emitError(error: Error): void
}

function createMockRipgrepProcess(): MockRipgrepProcess {
	let onData: ((data: string) => void) | undefined
	let onClose: ((code: number | null) => void) | undefined
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
			if (event === "close") onClose = listener as (code: number | null) => void
			if (event === "error") onError = listener as (error: Error) => void
		}),
		kill: vi.fn(),
	}

	return {
		process,
		emitData: (data) => onData?.(data),
		emitClose: (code = 0) => onClose?.(code),
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
	for (let attempt = 0; attempt < 10 && mock.mock.calls.length === 0; attempt++) {
		await Promise.resolve()
	}
	expect(mock).toHaveBeenCalled()
}

async function waitForRipgrepSpawn(): Promise<void> {
	await waitForCall(vi.mocked(childProcess.spawn))
}

describe("listFiles cancellation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getBinPath).mockResolvedValue("/mock/path/to/rg")
		vi.mocked(fs.promises.access).mockRejectedValue(new Error("missing .gitignore"))
		vi.mocked(fs.promises.readFile).mockResolvedValue("")
		vi.mocked(fs.promises.readdir).mockResolvedValue([] as any)
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
