import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { EventEmitter } from "events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService } from "../managed-subagent-worktree.js"

const gitProcess = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn() }))
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	const { promisify } = await import("util")
	const execute = vi.fn(actual.execFile)
	Object.defineProperty(execute, promisify.custom, {
		value: (...args: unknown[]) => gitProcess.run(...args),
	})
	return { ...actual, execFile: execute, spawn: (...args: unknown[]) => gitProcess.spawn(...args) }
})

const TIMEOUT = 30_000

describe("managed Worker startup cancellation", () => {
	let root: string
	let repo: string
	let storage: string
	let service: ManagedSubagentWorktreeService
	const git = async (args: string[]) =>
		String((await promisify(execFile)("git", args, { cwd: repo, windowsHide: true })).stdout).trim()

	beforeEach(async () => {
		const actual = await vi.importActual<typeof import("child_process")>("child_process")
		gitProcess.run.mockImplementation(promisify(actual.execFile))
		gitProcess.spawn.mockImplementation(actual.spawn)
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-startup-cancel-"))
		repo = path.join(root, "repository")
		storage = path.join(root, "storage")
		await fs.mkdir(repo)
		await git(["init"])
		await git(["config", "user.name", "Alpha Test"])
		await git(["config", "user.email", "test@local.invalid"])
		await fs.writeFile(path.join(repo, "value.txt"), "source content\n")
		await git(["add", "-A"])
		await git(["commit", "-m", "baseline"])
		service = new ManagedSubagentWorktreeService()
	}, TIMEOUT)

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	}, TIMEOUT)

	it(
		"cancels and joins a native include copy before removing its checkout",
		async () => {
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "node_modules\n")
			await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\n")
			await fs.mkdir(path.join(repo, "node_modules"))
			await fs.writeFile(path.join(repo, "node_modules", "dependency.txt"), "retained source dependency")
			const scope = await service.validateScope(repo, ["value.txt"])
			let enterCopy!: () => void
			const copyEntered = new Promise<void>((resolve) => (enterCopy = resolve))
			const process = Object.assign(new EventEmitter(), { pid: 23456 })
			gitProcess.spawn.mockImplementation(() => {
				enterCopy()
				return process
			})
			let releaseCleanup!: () => void
			const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
			const terminateProcessTree = vi.fn(async () => {
				process.emit("close", 130)
				await cleanup
			})
			const cancellation = new AbortController()
			const run = service.create(storage, "copying-worker", scope, {
				signal: cancellation.signal,
				terminateProcessTree,
			})
			let settled = false
			void run.then(
				() => (settled = true),
				() => (settled = true),
			)
			try {
				await copyEntered
				cancellation.abort(new Error("Stopped during include copy"))
				await Promise.resolve()
				expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith([23456], {
					allowMissingWindowsRoots: true,
				})
				expect(settled).toBe(false)
				releaseCleanup()
				await expect(run).rejects.toThrow("Stopped during include copy")
				expect(await fs.readdir(path.join(storage, "subagent-change-sets"))).toEqual([])
				expect(await fs.readFile(path.join(repo, "node_modules", "dependency.txt"), "utf8")).toBe(
					"retained source dependency",
				)
			} finally {
				releaseCleanup()
				process.emit("close", 130)
				await run.catch(() => undefined)
			}
		},
		TIMEOUT,
	)

	it("does not allocate startup resources for an already cancelled request", async () => {
		const scope = await service.validateScope(repo, ["value.txt"])
		const cancellation = new AbortController()
		cancellation.abort(new Error("Cancelled before startup"))
		const terminateProcessTree = vi.fn()
		await expect(
			service.create(storage, "never-started", scope, {
				signal: cancellation.signal,
				terminateProcessTree,
			}),
		).rejects.toThrow("Cancelled before startup")
		expect(terminateProcessTree).not.toHaveBeenCalled()
		await expect(fs.access(storage)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["Git", "include copy"] as const)(
		"retains the active artifact and checkout when %s process cleanup cannot be confirmed",
		async (kind) => {
			if (kind === "include copy") {
				await fs.writeFile(path.join(repo, ".worktreeinclude"), "node_modules\n")
				await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\n")
				await fs.mkdir(path.join(repo, "node_modules"))
				await fs.writeFile(path.join(repo, "node_modules", "dependency.txt"), "retained dependency")
			}
			const scope = await service.validateScope(repo, ["value.txt"])
			const cancellation = new AbortController()
			let enterProcess!: () => void
			const processEntered = new Promise<void>((resolve) => (enterProcess = resolve))
			let rejectProcess!: (error: Error) => void
			const execution = Object.assign(new Promise<never>((_resolve, reject) => (rejectProcess = reject)), {
				child: Object.assign(new EventEmitter(), { pid: 12345 }),
			})
			void execution.catch(() => undefined)
			const copyProcess = Object.assign(new EventEmitter(), { pid: 23456 })
			if (kind === "include copy")
				gitProcess.spawn.mockImplementation(() => {
					enterProcess()
					return copyProcess
				})
			const actual = gitProcess.run.getMockImplementation()!
			gitProcess.run.mockImplementation((file: string, args: string[], options: unknown) => {
				if (kind === "Git" && args.includes("worktree") && args.includes("lock")) {
					enterProcess()
					return execution
				}
				return actual(file, args, options)
			})
			const run = service.create(storage, "retained-worker", scope, {
				signal: cancellation.signal,
				terminateProcessTree: async () => {
					if (kind === "Git") rejectProcess(new Error("Git process stopped; descendant cleanup failed"))
					else copyProcess.emit("close", 130)
					throw new Error("Tree cleanup could not be verified")
				},
			})
			void run.catch(() => undefined)
			try {
				await processEntered
				cancellation.abort()
				await expect(run).rejects.toThrow("Worktree process-tree cleanup failed")
				const ids = await fs.readdir(path.join(storage, "subagent-change-sets"))
				expect(ids).toHaveLength(1)
				const artifact = await service.load(storage, ids[0]!)
				expect(artifact.status).toBe("active")
				expect(artifact.error).toContain("startup process cleanup is unconfirmed")
				expect(await fs.readFile(path.join(artifact.worktreePath!, "value.txt"), "utf8")).toContain(
					"source content",
				)
				gitProcess.run.mockImplementation(actual)
				await expect(service.recoverOrphans(storage)).resolves.toEqual([])
				expect(await fs.readFile(path.join(artifact.worktreePath!, "value.txt"), "utf8")).toContain(
					"source content",
				)
				await service.deleteArtifact(storage, artifact.id)
			} finally {
				rejectProcess(new Error("Release controlled Git process"))
				await run.catch(() => undefined)
			}
		},
		TIMEOUT,
	)

	it(
		"joins the cancelled Git process and its tree cleanup before rolling back startup",
		async () => {
			const scope = await service.validateScope(repo, ["value.txt"])
			const cancellation = new AbortController()
			let enterProcess!: () => void
			const processEntered = new Promise<void>((resolve) => (enterProcess = resolve))
			let rejectProcess!: (error: Error) => void
			const execution = Object.assign(new Promise<never>((_resolve, reject) => (rejectProcess = reject)), {
				child: Object.assign(new EventEmitter(), { pid: 12345 }),
			})
			const actual = gitProcess.run.getMockImplementation()!
			gitProcess.run.mockImplementation((file: string, args: string[], options: unknown) => {
				if (args.includes("add") && args.includes("-A")) {
					enterProcess()
					return execution
				}
				return actual(file, args, options)
			})
			let enterCleanup!: () => void
			const cleanupEntered = new Promise<void>((resolve) => (enterCleanup = resolve))
			let releaseCleanup!: () => void
			const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
			const terminateProcessTree = vi.fn(async () => {
				enterCleanup()
				rejectProcess(new Error("Git process terminated"))
				await cleanup
			})
			let settled = false
			const run = service.create(storage, "cancelled-worker", scope, {
				signal: cancellation.signal,
				terminateProcessTree,
			})
			void run.then(
				() => (settled = true),
				() => (settled = true),
			)
			try {
				await processEntered
				cancellation.abort(new Error("Parent task stopped"))
				await Promise.resolve()
				expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith([12345], {
					allowMissingWindowsRoots: true,
				})
				await cleanupEntered
				expect(settled).toBe(false)
				expect(await fs.readdir(path.join(storage, "subagent-change-sets"))).toHaveLength(1)
				releaseCleanup()
				await expect(run).rejects.toThrow("Parent task stopped")
				expect(await fs.readdir(path.join(storage, "subagent-change-sets"))).toEqual([])
				expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("source content\n")
			} finally {
				releaseCleanup()
				rejectProcess(new Error("Release controlled Git process"))
				await run.catch(() => undefined)
			}
		},
		TIMEOUT,
	)
})
