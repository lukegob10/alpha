import * as childProcess from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { EventEmitter } from "events"

import { listFiles } from "../list-files"
import { getBinPath } from "../../ripgrep"

vi.mock("child_process", () => ({ spawn: vi.fn() }))
vi.mock("../../ripgrep", () => ({ getBinPath: vi.fn().mockResolvedValue("/mock/rg") }))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("strict listing ignore-file boundary", () => {
	let tempBase: string
	let fixtureRoot: string
	let workspaceRoot: string
	let target: string
	const options = () => ({ rejectOnError: true, followSymlinks: false, workspaceRoot })

	beforeEach(async () => {
		vi.mocked(getBinPath).mockResolvedValue("/mock/rg")
		tempBase = await fs.promises.realpath(os.tmpdir())
		fixtureRoot = await fs.promises.mkdtemp(path.join(tempBase, "alpha-strict-ignore-"))
		workspaceRoot = path.join(fixtureRoot, "workspace")
		target = path.join(workspaceRoot, "listed")
		await fs.promises.mkdir(target, { recursive: true })
		vi.mocked(childProcess.spawn)
			.mockReset()
			.mockImplementation(() => {
				const process = Object.assign(new EventEmitter(), {
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
					kill: vi.fn(),
				})
				queueMicrotask(() => process.emit("close", 0, null))
				return process as any
			})
	})

	afterEach(async () => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		expect(path.dirname(path.resolve(fixtureRoot))).toBe(tempBase)
		expect(path.basename(fixtureRoot)).toMatch(/^alpha-strict-ignore-/)
		await fs.promises.rm(fixtureRoot, { recursive: true, force: true })
	})

	it("loads only captured workspace ancestors and disables ripgrep's independent ignore discovery", async () => {
		await fs.promises.mkdir(path.join(target, "visible"))
		await fs.promises.mkdir(path.join(target, "hidden-by-workspace"))
		await fs.promises.writeFile(path.join(fixtureRoot, ".gitignore"), "visible/\n")
		await fs.promises.writeFile(path.join(workspaceRoot, ".gitignore"), "hidden-by-workspace/\n")
		const open = vi.spyOn(fs.promises, "open")

		const [files] = await listFiles(target, false, 200, undefined, options())

		expect(files).toContain(`${path.join(target, "visible")}/`)
		expect(files).not.toContain(`${path.join(target, "hidden-by-workspace")}/`)
		expect(open.mock.calls.map(([file]) => String(file))).toEqual([path.join(workspaceRoot, ".gitignore")])
		expect(vi.mocked(childProcess.spawn).mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--no-config", "--no-ignore", "--no-follow"]),
		)
	})

	it("rejects an outward .gitignore junction before opening its target or starting ripgrep", async () => {
		const outside = path.join(fixtureRoot, "outside")
		await fs.promises.mkdir(outside)
		await fs.promises.symlink(
			outside,
			path.join(workspaceRoot, ".gitignore"),
			process.platform === "win32" ? "junction" : "dir",
		)
		const open = vi.spyOn(fs.promises, "open")

		await expect(listFiles(target, false, 200, undefined, options())).rejects.toThrow(
			"linked or nonregular .gitignore",
		)
		expect(open).not.toHaveBeenCalled()
		expect(childProcess.spawn).not.toHaveBeenCalled()
	})

	it("rejects a hard-linked ignore file without reading outside content", async () => {
		const outside = path.join(fixtureRoot, "outside-ignore")
		await fs.promises.writeFile(outside, "outside-secret-pattern/\n")
		await fs.promises.link(outside, path.join(workspaceRoot, ".gitignore"))
		const open = vi.spyOn(fs.promises, "open")

		await expect(listFiles(target, false, 200, undefined, options())).rejects.toThrow(
			"linked or nonregular .gitignore",
		)
		expect(open).not.toHaveBeenCalled()
		expect(childProcess.spawn).not.toHaveBeenCalled()
	})

	it("rejects a real junction even when directory-entry metadata labels it as an ordinary directory", async () => {
		const outside = path.join(fixtureRoot, "outside-directory")
		await fs.promises.mkdir(outside)
		await fs.promises.symlink(
			outside,
			path.join(target, "linked-directory"),
			process.platform === "win32" ? "junction" : "dir",
		)
		const originalReaddir = fs.promises.readdir.bind(fs.promises)
		vi.spyOn(fs.promises, "readdir").mockImplementation(async (...args: any[]) => {
			if (String(args[0]) === target) {
				// Reproduce the observed Node 20 Windows Dirent classification.
				return [{ name: "linked-directory", isDirectory: () => true, isSymbolicLink: () => false }] as any
			}
			return (originalReaddir as any)(...args)
		})

		await expect(listFiles(target, false, 200, undefined, options())).rejects.toThrow("linked or changed directory")
	})

	it.each(["individual", "aggregate"] as const)(
		"rejects the %s ignore-file byte budget before scanning",
		async (kind) => {
			await fs.promises.writeFile(
				path.join(workspaceRoot, ".gitignore"),
				"#".repeat(kind === "individual" ? 65_537 : 40_000),
			)
			if (kind === "aggregate") await fs.promises.writeFile(path.join(target, ".gitignore"), "#".repeat(40_000))
			const open = vi.spyOn(fs.promises, "open")

			await expect(listFiles(target, false, 200, undefined, options())).rejects.toThrow(
				"64 KiB ignore-file budget",
			)
			expect(open).toHaveBeenCalledTimes(kind === "individual" ? 0 : 1)
			expect(childProcess.spawn).not.toHaveBeenCalled()
		},
	)

	it("accepts exactly 64 KiB and closes every bounded-read handle", async () => {
		await fs.promises.writeFile(path.join(workspaceRoot, ".gitignore"), "#".repeat(65_536))
		const originalOpen = fs.promises.open.bind(fs.promises)
		const closed = vi.fn()
		let largestRead = 0
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args)
			const read = handle.read.bind(handle)
			const close = handle.close.bind(handle)
			vi.spyOn(handle, "read").mockImplementation(async (...readArgs: any[]) => {
				largestRead = Math.max(largestRead, readArgs[2])
				return (read as any)(...readArgs)
			})
			vi.spyOn(handle, "close").mockImplementation(async () => {
				await close()
				closed()
			})
			return handle
		})

		await expect(listFiles(target, false, 200, undefined, options())).resolves.toEqual([[], false])
		expect(largestRead).toBe(8 * 1024)
		expect(closed).toHaveBeenCalledOnce()
	})

	it.each(["cancellation", "deadline"] as const)(
		"joins an in-flight bounded read and close after %s",
		async (kind) => {
			await fs.promises.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\n")
			const entered = deferred()
			const release = deferred()
			const controller = new AbortController()
			const reason = new Error("ignore loading cancelled")
			const originalOpen = fs.promises.open.bind(fs.promises)
			const closed = vi.fn()
			vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
				const handle = await originalOpen(...args)
				const read = handle.read.bind(handle)
				const close = handle.close.bind(handle)
				vi.spyOn(handle, "read").mockImplementation(async (...readArgs: any[]) => {
					entered.resolve()
					await release.promise
					return (read as any)(...readArgs)
				})
				vi.spyOn(handle, "close").mockImplementation(async () => {
					await close()
					closed()
				})
				return handle
			})
			if (kind === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const listing = listFiles(target, false, 200, controller.signal, options())
			const settled = vi.fn()
			void listing.then(settled, settled)
			const rejected =
				kind === "deadline"
					? expect(listing).rejects.toMatchObject({ name: "FileListingTimeoutError", timedOut: true })
					: expect(listing).rejects.toBe(reason)
			await entered.promise
			if (kind === "deadline") await vi.advanceTimersByTimeAsync(10_000)
			else controller.abort(reason)
			await Promise.resolve()
			expect(settled).not.toHaveBeenCalled()
			expect(closed).not.toHaveBeenCalled()
			release.resolve()
			await rejected
			expect(closed).toHaveBeenCalledOnce()
			expect(childProcess.spawn).not.toHaveBeenCalled()
			if (kind === "deadline") expect(vi.getTimerCount()).toBe(0)
		},
	)

	it("rejects a requested directory outside the captured root", async () => {
		await expect(listFiles(fixtureRoot, false, 200, undefined, options())).rejects.toThrow("captured workspace")
		expect(childProcess.spawn).not.toHaveBeenCalled()
	})
})
