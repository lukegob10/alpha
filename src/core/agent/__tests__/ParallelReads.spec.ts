import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import * as vscode from "vscode"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { listFiles } from "../../../services/glob/list-files"
import { ToolScheduler, type ToolExecutionMode } from "../ToolScheduler"

vi.mock("../../../services/glob/list-files", () => ({ listFiles: vi.fn() }))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

describe("audited production directory reads", () => {
	let root: string
	let originalFolders: typeof vscode.workspace.workspaceFolders
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "nor26-")))
		for (let i = 0; i < 6; i++) await fs.mkdir(path.join(root, `dir-${i}`))
		originalFolders = vscode.workspace.workspaceFolders
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: { fsPath: root } }],
		})
		vi.mocked(listFiles).mockReset()
	})
	afterEach(async () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: originalFolders })
		await fs.rm(root, { recursive: true, force: true })
	})

	function fixture(
		mode: ToolExecutionMode = "selective-parallel",
		enabled = true,
		signal?: AbortSignal,
		outputLimit?: number,
	) {
		const state = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			showRooIgnoredFiles: false,
			disabledTools: [] as string[],
		}
		const ignore = { rooIgnoreContent: undefined as string | undefined, validateAccess: () => true }
		const provider = { getState: vi.fn(async () => ({ ...state })), getValues: vi.fn(() => ({ ...state })) }
		const content: any[] = []
		const task = {
			taskId: "parallel-listing",
			taskKind: "primary",
			cwd: root,
			abort: false,
			providerRef: { deref: () => provider },
			rooIgnoreController: ignore,
			rooProtectedController: { isWriteProtected: () => false },
			consecutiveMistakeCount: 3,
			userMessageContent: content,
			ask: vi.fn(async () => ({ response: "noButtonClicked" })),
			say: vi.fn(async () => {}),
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent: (result: any) => {
				if (content.some((item) => item.tool_use_id === result.tool_use_id)) return false
				content.push(result)
				return true
			},
		} as unknown as Task
		const surface = createTaskToolSurface({
			registry: new ToolRegistry(),
			mode: "code",
			cwd: root,
			autoApprovalEnabled: true,
			readGrant: { enabled, workspaceRoot: root, showIgnoredFiles: false },
			outputLimits: outputLimit ? { list_files: outputLimit } : undefined,
		})
		const fence = vi.fn(async () => {})
		const scheduler = new ToolScheduler({
			task,
			registry: surface.registry,
			policy: surface.policy,
			readGrant: surface.readGrant,
			mode: "code",
			executionMode: mode,
			maxConcurrency: 3,
			beforeEffect: fence,
			preserveAbortedResults: true,
			signal,
		})
		return { task, surface, state, ignore, provider, content, scheduler, fence }
	}

	const calls = (count: number) =>
		Array.from({ length: count }, (_, i) => ({
			type: "tool_call" as const,
			id: `call-${i}`,
			name: "list_files",
			arguments: { path: `dir-${i}`, recursive: false },
		}))
	const listing = (dir: string): [string[], boolean] => [[path.join(dir, "file.ts")], false]

	it("overlaps real handlers, drains out-of-order completion, and publishes once in call order", async () => {
		const { scheduler, task, content, surface, provider } = fixture()
		const gates = Array.from({ length: 3 }, () => deferred<[string[], boolean]>())
		const started = deferred<void>()
		let active = 0
		let peak = 0
		vi.mocked(listFiles).mockImplementation(async (dir, recursive, limit, signal, options) => {
			expect([recursive, limit, options]).toEqual([
				false,
				200,
				{ followSymlinks: false, rejectOnError: true, workspaceRoot: root },
			])
			expect(signal).toBeInstanceOf(AbortSignal)
			active++
			peak = Math.max(peak, active)
			if (active === 3) started.resolve()
			const result = await gates[Number(path.basename(dir).slice(4))].promise
			active--
			return result
		})
		const run = scheduler.run(calls(3))
		await started.promise
		expect(surface.registry.resolve("list_files")?.capabilities.requiresApproval).toBe(true)
		gates[2].resolve(listing(path.join(root, "dir-2")))
		gates[1].resolve(listing(path.join(root, "dir-1")))
		await Promise.resolve()
		expect(task.say).not.toHaveBeenCalled()
		gates[0].resolve(listing(path.join(root, "dir-0")))
		const outcome = await run
		expect(peak).toBe(3)
		expect(active).toBe(0)
		expect(task.ask).not.toHaveBeenCalled()
		expect(provider.getState).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => [result.callId, result.status, result.content])).toEqual(
			calls(3).map((call) => [call.id, "success", "file.ts"]),
		)
		expect(content.map((item) => item.tool_use_id)).toEqual(calls(3).map((call) => call.id))
		expect(vi.mocked(task.say).mock.calls.map((call) => JSON.parse(call[1]!).path)).toEqual([
			"dir-0",
			"dir-1",
			"dir-2",
		])
	})

	it.each(["approval", "ignore", "disabled tool"] as const)(
		"denies output when %s policy changes during the read",
		async (kind) => {
			const { scheduler, task, state, ignore } = fixture()
			const started = deferred<void>()
			const gate = deferred<[string[], boolean]>()
			vi.mocked(listFiles).mockImplementation(async () => {
				started.resolve()
				return gate.promise
			})
			const run = scheduler.run(calls(1))
			await started.promise
			if (kind === "approval") state.alwaysAllowReadOnly = false
			else if (kind === "ignore") ignore.rooIgnoreContent = "now-ignored"
			else state.disabledTools = ["list_files"]
			gate.resolve(listing(path.join(root, "dir-0")))
			expect((await run).results[0].status).toBe("denied")
			expect(task.say).not.toHaveBeenCalled()
			expect(task.ask).not.toHaveBeenCalled()
		},
	)

	it("rechecks a live revocation after the awaited effect fence before scan I/O", async () => {
		const { scheduler, state, task, fence } = fixture()
		let checks = 0
		fence.mockImplementation(async () => {
			if (++checks === 2) state.alwaysAllowReadOnly = false
		})
		expect((await scheduler.run(calls(1))).results[0].status).toBe("denied")
		expect(listFiles).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("denies a captured grant revoked before preflight without falling into legacy scan-before-ask", async () => {
		const { scheduler, state, task } = fixture()
		state.alwaysAllowReadOnly = false
		const outcome = await scheduler.run(calls(2))
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "denied"])
		expect(listFiles).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("applies captured output limits and records truncation after ordered finalization", async () => {
		const { scheduler } = fixture("selective-parallel", true, undefined, 100)
		vi.mocked(listFiles).mockImplementation(async (dir) => [[path.join(dir, "a".repeat(200) + ".ts")], false])
		const outcome = await scheduler.run(calls(2))
		expect(outcome.results.every((result) => result.truncated && String(result.content).length <= 100)).toBe(true)
		expect(outcome.outputTruncatedCount).toBe(2)
	})

	it("measures cancellation only after ignored-signal reads drain and never starts the next window", async () => {
		const controller = new AbortController()
		const { scheduler, task } = fixture("selective-parallel", true, controller.signal)
		const started = deferred<void>()
		const gate = deferred<void>()
		let active = 0
		vi.mocked(listFiles).mockImplementation(async (dir) => {
			if (++active === 3) started.resolve()
			await gate.promise
			active--
			return listing(dir)
		})
		let finished = false
		const run = scheduler.run(calls(6)).then((outcome) => {
			finished = true
			return outcome
		})
		await started.promise
		const start = performance.now()
		controller.abort()
		await Promise.resolve()
		expect(finished).toBe(false)
		expect(active).toBe(3)
		gate.resolve()
		const outcome = await run
		const cancellationDrainMs = Math.round((performance.now() - start) * 100) / 100
		expect(active).toBe(0)
		expect(listFiles).toHaveBeenCalledTimes(3)
		expect(task.say).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => result.status)).toEqual(Array(6).fill("cancelled"))
		console.log(
			"NOR-26 controlled cancellation",
			JSON.stringify({ activeAtAbort: 3, activeAtReturn: active, cancellationDrainMs }),
		)
	})

	it("retains serial approval for a step captured without a read grant", async () => {
		const { scheduler, task } = fixture("selective-parallel", false)
		vi.mocked(listFiles).mockImplementation(async (dir) => listing(dir))
		const outcome = await scheduler.run(calls(2))
		expect(outcome.parallelToolCount).toBe(0)
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "denied"])
		expect(task.ask).toHaveBeenCalledTimes(2)
	})

	it("keeps root, recursive, aliased, linked and oversized directories on the serial path", async () => {
		await fs.symlink(path.join(root, "dir-1"), path.join(root, "alias"), "junction")
		await fs.symlink(path.join(root, "dir-2"), path.join(root, "dir-0", "linked"), "junction")
		for (let i = 0; i <= 200; i++) await fs.writeFile(path.join(root, "dir-3", `entry-${i}`), "")
		const { scheduler, task } = fixture()
		vi.mocked(listFiles).mockImplementation(async (dir) => listing(dir))
		const input = [
			{ path: "." },
			{ path: "dir-1", recursive: true },
			{ path: "alias" },
			{ path: "dir-0" },
			{ path: "dir-3" },
		].map((argumentsValue, i) => ({
			type: "tool_call" as const,
			id: `excluded-${i}`,
			name: "list_files",
			arguments: argumentsValue,
		}))
		const outcome = await scheduler.run(input)
		expect(
			vi
				.mocked(listFiles)
				.mock.calls.filter((call) => call[4] !== undefined)
				.map((call) => call[0]),
		).toEqual([])
		expect(outcome.parallelToolCount).toBe(0)
		expect(task.ask).toHaveBeenCalledTimes(5)
	})

	it("falls back when an external ancestor ignore file would change strict listing contents", async () => {
		const enclosingRoot = root
		root = path.join(enclosingRoot, "nested-workspace")
		try {
			await fs.mkdir(path.join(root, "dir-0"), { recursive: true })
			await fs.writeFile(path.join(enclosingRoot, ".gitignore"), "hidden-directory/\n")
			vi.mocked(listFiles).mockImplementation(async (dir) => listing(dir))
			const excluded = fixture()
			expect((await excluded.scheduler.run(calls(1))).parallelToolCount).toBe(0)
			expect(excluded.task.ask).toHaveBeenCalledOnce()
			await fs.unlink(path.join(enclosingRoot, ".gitignore"))
			const admitted = fixture()
			expect((await admitted.scheduler.run(calls(1))).parallelToolCount).toBe(1)
			expect(admitted.task.ask).not.toHaveBeenCalled()
		} finally {
			root = enclosingRoot
		}
	})

	it("reports strict scan failures and timeout as terminal errors", async () => {
		const { scheduler } = fixture()
		vi.mocked(listFiles).mockImplementation(async (dir) => {
			if (path.basename(dir) === "dir-0") throw Object.assign(new Error("listing timed out"), { timedOut: true })
			throw new Error("scan failed")
		})
		const outcome = await scheduler.run(calls(2))
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(outcome.results[0].timedOut).toBe(true)
	})

	it("benchmarks equal six-directory batches with injected 30 ms scan latency", async () => {
		const samples: Record<string, Array<{ elapsedMs: number; peak: number }>> = {
			serial: [],
			"selective-parallel": [],
		}
		let serialContent: unknown
		for (let sample = 0; sample < 3; sample++) {
			for (const mode of ["serial", "selective-parallel"] as const) {
				const { scheduler } = fixture(mode)
				let active = 0
				let peak = 0
				vi.mocked(listFiles).mockImplementation(async (dir) => {
					active++
					peak = Math.max(peak, active)
					// Explicit workload service latency, identical in both execution modes.
					await new Promise<void>((resolve) => setTimeout(resolve, 30))
					active--
					return listing(dir)
				})
				const start = performance.now()
				const outcome = await scheduler.run(calls(6))
				samples[mode].push({ elapsedMs: Math.round((performance.now() - start) * 100) / 100, peak })
				const results = outcome.results.map(({ callId, content, status }) => ({ callId, content, status }))
				if (mode === "serial") serialContent = results
				else expect(results).toEqual(serialContent)
				expect(active).toBe(0)
			}
		}
		const median = (mode: string) => samples[mode].map((sample) => sample.elapsedMs).sort((a, b) => a - b)[1]
		expect(samples.serial.every((sample) => sample.peak === 1)).toBe(true)
		expect(samples["selective-parallel"].every((sample) => sample.peak === 3)).toBe(true)
		expect(median("selective-parallel")).toBeLessThan(median("serial"))
		console.log("NOR-26 controlled handler benchmark", JSON.stringify(samples))
	})
})
