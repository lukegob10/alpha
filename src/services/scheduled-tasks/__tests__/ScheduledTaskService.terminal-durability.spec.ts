import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { EventEmitter } from "events"
import type { MockInstance } from "vitest"
import { AlphaCodeEventName, type CreateScheduledTaskPayload, type ExtensionMessage } from "@alpha-code/types"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"
import { ScheduledCommandCleanupError } from "../runScheduledCommand"

const commandRunner = vi.hoisted(() =>
	vi.fn<(command: string, options: { signal: AbortSignal }) => Promise<{ stdout: string; stderr: string }>>(),
)

vi.mock("../runScheduledCommand", async (importOriginal) => ({
	...(await importOriginal<typeof import("../runScheduledCommand")>()),
	runScheduledCommand: commandRunner,
}))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: (base: string) => base }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const TICK_MS = 1_000
const profile = { id: "background-profile", name: "Background", apiProvider: "openai" as const }
const terminalCases = [
	[AlphaCodeEventName.TaskCompleted, "succeeded", AlphaCodeEventName.TaskAborted],
	[AlphaCodeEventName.TaskAborted, "failed", AlphaCodeEventName.TaskCompleted],
] as const

function makeAlphaTask(taskId: string, onStart: () => void) {
	return {
		taskId,
		prepareReasoningForAdmission: vi.fn(async () => undefined),
		start: vi.fn(onStart),
		abortTask: vi.fn(async () => undefined),
	}
}

type AlphaTask = ReturnType<typeof makeAlphaTask>

describe("scheduled terminal result durability", () => {
	let tmpDir: string
	let workspace: string
	let service: ScheduledTaskService
	let provider: ReturnType<typeof makeProvider>
	let originalFolders: typeof vscode.workspace.workspaceFolders
	let onStart: ((task: AlphaTask) => void) | undefined
	let onLog: ((line: string) => void) | undefined
	let output: ReturnType<typeof vi.fn<(line: string) => void>>
	let tick: MockInstance<() => Promise<void>>
	const leaseReleases = new Set<Promise<void>>()

	function makeProvider() {
		let taskCount = 0
		const tasks = new Map<string, AlphaTask>()
		return Object.assign(new EventEmitter(), {
			createTask: vi.fn(async () => {
				let task: AlphaTask
				task = makeAlphaTask(`background-task-${++taskCount}`, () => onStart?.(task))
				tasks.set(task.taskId, task)
				return task
			}),
			removeTaskFromStack: vi.fn(async ({ taskId }: { taskId: string }) => {
				await tasks.get(taskId)?.abortTask()
			}),
			providerSettingsManager: { getProfile: vi.fn(async () => profile) },
			postMessageToWebview: vi.fn(async (_message: ExtensionMessage) => undefined),
			getState: vi.fn(async () => ({ approvalMode: "bypass", allowedCommands: [], deniedCommands: [] })),
		})
	}

	const payload = (overrides: Partial<CreateScheduledTaskPayload> = {}): CreateScheduledTaskPayload => ({
		name: "Durable scheduled review",
		prompt: "Review the repository",
		apiConfig: { id: profile.id, name: profile.name },
		workspace,
		mode: "architect",
		schedule: { type: "daily", startAt: Date.now() + 60_000, timezone: "UTC", intervalDays: 1 },
		notificationPreference: "never",
		...overrides,
	})

	async function launch(taskId: string) {
		const started = deferred<AlphaTask>()
		onStart = started.resolve
		await service.runNow(taskId)
		const alphaTask = await started.promise
		onStart = undefined
		const run = service.getState().runs.find((candidate) => candidate.alphaTaskId === alphaTask.taskId)!
		expect(run.status).toBe("running")
		return { alphaTask, run }
	}

	function terminal(event: AlphaCodeEventName, alphaTaskId: string) {
		const listener = provider.listeners(event)[0] as (taskId: string) => Promise<void>
		return listener(alphaTaskId)
	}

	async function advanceTick() {
		const previousCount = tick.mock.calls.length
		await vi.advanceTimersByTimeAsync(TICK_MS)
		expect(tick).toHaveBeenCalledTimes(previousCount + 1)
		await tick.mock.results[previousCount].value
	}

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		commandRunner.mockReset().mockResolvedValue({ stdout: "command completed", stderr: "" })
		leaseReleases.clear()
		onStart = undefined
		onLog = undefined
		originalFolders = vscode.workspace.workspaceFolders
		const acquireOwnerLease = ScheduledTaskStore.prototype.acquireOwnerLease
		vi.spyOn(ScheduledTaskStore.prototype, "acquireOwnerLease").mockImplementation(async function (
			this: ScheduledTaskStore,
			...args: Parameters<ScheduledTaskStore["acquireOwnerLease"]>
		) {
			const release = await acquireOwnerLease.apply(this, args)
			return () => {
				const pending = release()
				leaseReleases.add(pending)
				return pending
			}
		})
		// File watching is independent of the timer retry contract under test.
		vi.spyOn(ScheduledTaskStore.prototype, "watchChanges").mockResolvedValue(() => {})
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-schedule-terminal-"))
		workspace = path.join(tmpDir, "workspace")
		await fs.mkdir(workspace)
		Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(workspace) }] })
		provider = makeProvider()
		output = vi.fn((line: string) => onLog?.(line))
		service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			provider as unknown as AlphaProvider,
			{ appendLine: output } as unknown as vscode.OutputChannel,
			TICK_MS,
		)
		tick = vi.spyOn(service as unknown as { tick: () => Promise<void> }, "tick")
		await service.initialize()
	})

	afterEach(async () => {
		await service.dispose().catch(() => undefined)
		// Failed tree cleanup intentionally retains the lease for the live host.
		await (Reflect.get(service, "releaseOwnerLease") as (() => Promise<void>) | undefined)?.()
		await Promise.all([...leaseReleases, Reflect.get(Reflect.get(service, "store"), "writeLock") as Promise<void>])
		Object.assign(vscode.workspace, { workspaceFolders: originalFolders })
		vi.restoreAllMocks()
		vi.useRealTimers()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it.each(terminalCases)(
		"retains the first %s result after a transient write failure, even if the next event conflicts",
		async (event, expectedStatus, conflictingEvent) => {
			const schedule = await service.createTask(payload())
			const { alphaTask, run } = await launch(schedule.id)
			const completeSpy = vi
				.spyOn(ScheduledTaskStore.prototype, "completeRun")
				.mockRejectedValueOnce(new Error("Transient terminal write failure"))

			await expect(terminal(event, alphaTask.taskId)).resolves.toBeUndefined()
			expect(service.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe("running")
			await terminal(conflictingEvent, alphaTask.taskId)
			const completed = service.getState().runs.find((candidate) => candidate.id === run.id)!

			expect(completed.status).toBe(expectedStatus)
			expect(completed.finishedAt).toBe(completeSpy.mock.calls[0][0].finishedAt)
			expect(completeSpy).toHaveBeenCalledTimes(2)
			expect(completeSpy.mock.calls[1][0]).toBe(completeSpy.mock.calls[0][0])
			expect(alphaTask.start).toHaveBeenCalledOnce()
		},
	)

	it.each(terminalCases)(
		"joins duplicate and conflicting events while the first %s write is in flight",
		async (event, expectedStatus, conflictingEvent) => {
			const schedule = await service.createTask(payload())
			const { alphaTask, run } = await launch(schedule.id)
			const writing = deferred()
			const releaseWrite = deferred()
			const completeRun = ScheduledTaskStore.prototype.completeRun
			const completeSpy = vi
				.spyOn(ScheduledTaskStore.prototype, "completeRun")
				.mockImplementationOnce(async function (this: ScheduledTaskStore, terminalRun) {
					writing.resolve()
					await releaseWrite.promise
					return completeRun.call(this, terminalRun)
				})
			const first = terminal(event, alphaTask.taskId)
			try {
				await writing.promise
				provider.emit(conflictingEvent, alphaTask.taskId)
				const duplicate = terminal(event, alphaTask.taskId)
				expect(completeSpy).toHaveBeenCalledOnce()
				releaseWrite.resolve()
				await Promise.all([first, duplicate])

				expect(service.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe(
					expectedStatus,
				)
				await terminal(conflictingEvent, alphaTask.taskId)
				expect(completeSpy).toHaveBeenCalledOnce()
			} finally {
				releaseWrite.resolve()
				await first
			}
		},
	)

	it.each(terminalCases)(
		"retries the once-delivered %s event on ticks without rerunning coding work",
		async (event, expectedStatus) => {
			const schedule = await service.createTask(payload())
			const { alphaTask, run } = await launch(schedule.id)
			const failedWriteLogged = deferred()
			onLog = (line) => {
				if (line.includes("Could not finalize run")) failedWriteLogged.resolve()
			}
			const completeSpy = vi
				.spyOn(ScheduledTaskStore.prototype, "completeRun")
				.mockRejectedValueOnce(new Error("First terminal write failure"))
				.mockRejectedValueOnce(new Error("Second terminal write failure"))

			provider.emit(event, alphaTask.taskId)
			await failedWriteLogged.promise
			await advanceTick()
			expect(completeSpy).toHaveBeenCalledTimes(2)
			expect(service.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe("running")
			await advanceTick()

			const reloaded = new ScheduledTaskStore(tmpDir)
			await reloaded.initialize()
			expect(reloaded.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe(expectedStatus)
			expect(completeSpy).toHaveBeenCalledTimes(3)
			expect(completeSpy.mock.calls.every(([terminalRun]) => terminalRun === completeSpy.mock.calls[0][0])).toBe(
				true,
			)
			expect(provider.createTask).toHaveBeenCalledOnce()
			expect(alphaTask.start).toHaveBeenCalledOnce()
		},
	)

	it("settles a pending completion before admitting the next scheduled occurrence", async () => {
		const schedule = await service.createTask(payload())
		const { alphaTask, run } = await launch(schedule.id)
		const completeSpy = vi
			.spyOn(ScheduledTaskStore.prototype, "completeRun")
			.mockRejectedValueOnce(new Error("Transient terminal write failure"))
		await terminal(AlphaCodeEventName.TaskCompleted, alphaTask.taskId)
		const editor = new ScheduledTaskStore(tmpDir)
		await editor.initialize()
		await editor.upsertTask({ ...schedule, nextRunAt: Date.now() - 1 })
		const nextStarted = deferred<AlphaTask>()
		onStart = nextStarted.resolve

		await advanceTick()
		const nextTask = await nextStarted.promise
		expect(completeSpy).toHaveBeenCalledTimes(2)
		expect(provider.createTask).toHaveBeenCalledTimes(2)
		expect(alphaTask.start).toHaveBeenCalledOnce()
		expect(nextTask.start).toHaveBeenCalledOnce()
		expect(service.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe("succeeded")
		expect(service.getState().runs.find((candidate) => candidate.alphaTaskId === nextTask.taskId)?.status).toBe(
			"running",
		)
		expect(service.getState().runs.some((candidate) => candidate.skipReason === "already_running")).toBe(false)
	})

	it("contains view and notification failures from a real terminal event after committing success", async () => {
		const schedule = await service.createTask(payload({ notificationPreference: "on_completion" }))
		const { alphaTask, run } = await launch(schedule.id)
		const notificationFailed = deferred()
		onLog = (line) => {
			if (line.includes("Could not notify completion")) notificationFailed.resolve()
		}
		const completeSpy = vi.spyOn(ScheduledTaskStore.prototype, "completeRun")
		provider.postMessageToWebview.mockRejectedValueOnce(new Error("View unavailable"))
		vi.spyOn(vscode.window, "showInformationMessage").mockRejectedValueOnce(new Error("Notification unavailable"))

		provider.emit(AlphaCodeEventName.TaskCompleted, alphaTask.taskId)
		await notificationFailed.promise
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe("succeeded")
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Could not update scheduled task view"))
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Could not notify completion"))
		provider.emit(AlphaCodeEventName.TaskAborted, alphaTask.taskId)
		await advanceTick()
		expect(completeSpy).toHaveBeenCalledOnce()
		expect(provider.createTask).toHaveBeenCalledOnce()
		expect(alphaTask.abortTask).not.toHaveBeenCalled()
	})

	it("admits the next due occurrence while a retried completion notification remains open", async () => {
		const schedule = await service.createTask(payload({ notificationPreference: "on_completion" }))
		const { alphaTask } = await launch(schedule.id)
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockRejectedValueOnce(new Error("Terminal write failure"))
		await terminal(AlphaCodeEventName.TaskCompleted, alphaTask.taskId)
		const editor = new ScheduledTaskStore(tmpDir)
		await editor.initialize()
		await editor.upsertTask({ ...schedule, nextRunAt: Date.now() - 1 })
		// Completion reloads the edited task under the real transaction lock.
		// A resolved refresh then isolates the tick's promise ordering from I/O.
		vi.spyOn(ScheduledTaskStore.prototype, "refresh").mockResolvedValue(false)
		const claim = vi.spyOn(ScheduledTaskStore.prototype, "claimRun")
		const notificationEntered = deferred()
		const releaseNotification = deferred<undefined>()
		vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(() => {
			notificationEntered.resolve()
			return releaseNotification.promise
		})
		const nextStarted = deferred<AlphaTask>()
		onStart = nextStarted.resolve
		const runningTick = advanceTick()
		try {
			await notificationEntered.promise
			await vi.advanceTimersByTimeAsync(0)
			expect(claim).toHaveBeenCalledOnce()
		} finally {
			releaseNotification.resolve(undefined)
			await runningTick
			await nextStarted.promise
		}
	})

	it("keeps command success when its completion notification rejects", async () => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
				notificationPreference: "on_completion",
			}),
		)
		const notificationFailed = deferred()
		onLog = (line) => {
			if (line.includes("Could not notify completion")) notificationFailed.resolve()
		}
		const completeSpy = vi.spyOn(ScheduledTaskStore.prototype, "completeRun")
		vi.spyOn(vscode.window, "showInformationMessage").mockRejectedValueOnce(new Error("Notification unavailable"))

		await service.runNow(schedule.id)
		await notificationFailed.promise
		expect(service.getState().runs).toEqual([
			expect.objectContaining({ status: "succeeded", exitCode: 0, output: "command completed" }),
		])
		expect(completeSpy).toHaveBeenCalledOnce()
		expect(commandRunner).toHaveBeenCalledOnce()
		expect(provider.createTask).not.toHaveBeenCalled()
		await advanceTick()
		expect(completeSpy).toHaveBeenCalledOnce()
	})

	it("retries a command terminal write without executing the command again", async () => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
			}),
		)
		const failedWriteLogged = deferred()
		onLog = (line) => {
			if (line.includes("Could not finalize run")) failedWriteLogged.resolve()
		}
		const completeSpy = vi
			.spyOn(ScheduledTaskStore.prototype, "completeRun")
			.mockRejectedValueOnce(new Error("Transient command terminal write failure"))

		await service.runNow(schedule.id)
		await failedWriteLogged.promise
		await advanceTick()

		expect(service.getState().runs).toEqual([
			expect.objectContaining({ status: "succeeded", exitCode: 0, output: "command completed" }),
		])
		expect(commandRunner).toHaveBeenCalledOnce()
		expect(completeSpy).toHaveBeenCalledTimes(2)
		expect(completeSpy.mock.calls[1][0]).toBe(completeSpy.mock.calls[0][0])
	})

	it("attempts a late command-abort write after disposal without retaining a failed retry", async () => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
			}),
		)
		const executing = deferred()
		commandRunner.mockImplementationOnce(
			async (_command, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("Command aborted during shutdown")), {
						once: true,
					})
					executing.resolve()
				}),
		)
		const processQueue = vi.spyOn(service as unknown as { processQueue: () => Promise<void> }, "processQueue")
		const completeSpy = vi
			.spyOn(ScheduledTaskStore.prototype, "completeRun")
			.mockRejectedValueOnce(new Error("Terminal write unavailable during shutdown"))

		await service.runNow(schedule.id)
		await executing.promise
		service.dispose()
		await processQueue.mock.results[0].value

		expect(completeSpy).toHaveBeenCalledOnce()
		expect(completeSpy.mock.calls[0][0]).toMatchObject({
			status: "failed",
			error: "Command aborted during shutdown",
		})
		expect((Reflect.get(service, "pendingRunCompletions") as Map<string, unknown>).size).toBe(0)
		expect((Reflect.get(service, "commandControllers") as Set<AbortController>).size).toBe(0)
		await vi.advanceTimersByTimeAsync(TICK_MS * 5)
		expect(completeSpy).toHaveBeenCalledOnce()
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Could not finalize run"))
		expect(output.mock.calls.at(-1)?.[0]).not.toContain("will retry")
	})

	it("retains unverified command cleanup across initial and repeated disposal", async () => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
			}),
		)
		const executing = deferred()
		const cleanupFailure = new ScheduledCommandCleanupError("Command process tree cleanup failed", {
			cause: new Error("Tree termination denied"),
		})
		commandRunner.mockImplementationOnce(
			async (_command, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(cleanupFailure), { once: true })
					executing.resolve()
				}),
		)
		await service.runNow(schedule.id)
		await executing.promise

		await expect(service.dispose()).rejects.toMatchObject({ errors: [cleanupFailure] })
		expect(leaseReleases.size).toBe(0)
		expect(service.getState().runs[0].status).toBe("failed")
		await expect(service.dispose()).rejects.toMatchObject({ errors: [cleanupFailure] })
		expect(leaseReleases.size).toBe(0)
		expect(commandRunner).toHaveBeenCalledOnce()
	})

	it.each([
		Object.assign(new Error("Command failed (exit code 17)"), { code: 17 }),
		new Error("Command aborted during shutdown; timed out waiting for the scheduled command process to close"),
	])("settles ordinary command failure ownership during disposal: %s", async (failure) => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
			}),
		)
		const executing = deferred()
		commandRunner.mockImplementationOnce(
			async (_command, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(failure), { once: true })
					executing.resolve()
				}),
		)
		await service.runNow(schedule.id)
		await executing.promise

		await service.dispose()
		expect(leaseReleases.size).toBe(1)
		expect(service.getState().runs[0].status).toBe("failed")
		expect((Reflect.get(service, "commandCompletions") as Map<AbortController, Promise<void>>).size).toBe(0)
	})

	it("retains the owner through command cleanup and its terminal write when disposal repeats", async () => {
		const schedule = await service.createTask(
			payload({
				execution: { type: "command", command: "node --version" },
				autoApproval: { approvalMode: "bypass" },
			}),
		)
		const executing = deferred()
		const aborted = deferred()
		const cleanup = deferred()
		const writing = deferred()
		const releaseWrite = deferred()
		commandRunner.mockImplementationOnce(async (_command, { signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true })
			executing.resolve()
			await cleanup.promise
			throw new Error("Command aborted during shutdown")
		})
		const completeRun = ScheduledTaskStore.prototype.completeRun
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementationOnce(async function (
			this: ScheduledTaskStore,
			run,
		) {
			writing.resolve()
			await releaseWrite.promise
			return completeRun.call(this, run)
		})
		const processQueue = vi.spyOn(service as unknown as { processQueue: () => Promise<void> }, "processQueue")
		await service.runNow(schedule.id)
		await executing.promise
		try {
			service.dispose()
			service.dispose()
			await aborted.promise
			expect(leaseReleases.size).toBe(0)
			expect((Reflect.get(service, "commandControllers") as Set<AbortController>).size).toBe(1)
			cleanup.resolve()
			await writing.promise
			expect(leaseReleases.size).toBe(0)
			expect(service.getState().runs[0].status).toBe("running")
			releaseWrite.resolve()
			await processQueue.mock.results[0].value
			await service.dispose()
			expect(leaseReleases.size).toBe(1)
			expect(service.getState().runs[0].status).toBe("failed")
			expect((Reflect.get(service, "commandControllers") as Set<AbortController>).size).toBe(0)
		} finally {
			cleanup.resolve()
			releaseWrite.resolve()
			await processQueue.mock.results[0].value
		}
	})

	it("retains the owner through Alpha tree cleanup and its terminal write when disposal repeats", async () => {
		const schedule = await service.createTask(payload())
		const { alphaTask } = await launch(schedule.id)
		const closing = deferred()
		const releaseClose = deferred()
		const writing = deferred()
		const releaseWrite = deferred()
		provider.removeTaskFromStack.mockImplementationOnce(async () => {
			closing.resolve()
			await releaseClose.promise
		})
		const completeRun = ScheduledTaskStore.prototype.completeRun
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementationOnce(async function (
			this: ScheduledTaskStore,
			run,
		) {
			writing.resolve()
			await releaseWrite.promise
			return completeRun.call(this, run)
		})
		try {
			const disposal = service.dispose()
			expect(service.dispose()).toBe(disposal)
			expect(provider.removeTaskFromStack).toHaveBeenCalledExactlyOnceWith({
				taskId: alphaTask.taskId,
				requireAbortSuccess: true,
			})
			await closing.promise
			expect(leaseReleases.size).toBe(0)
			expect(service.getState().runs[0].status).toBe("running")
			releaseClose.resolve()
			await writing.promise
			expect(leaseReleases.size).toBe(0)
			releaseWrite.resolve()
			await disposal
			expect(leaseReleases.size).toBe(1)
			expect(service.getState().runs[0].status).toBe("failed")
			expect(alphaTask.abortTask).not.toHaveBeenCalled()
		} finally {
			releaseClose.resolve()
			releaseWrite.resolve()
			await service.dispose()
		}
	})

	it("retains the owner and reports failed Alpha tree cleanup without an unhandled rejection", async () => {
		const schedule = await service.createTask(payload())
		const { alphaTask } = await launch(schedule.id)
		const failure = new Error("Managed child process cleanup failed")
		provider.removeTaskFromStack.mockRejectedValueOnce(failure)

		const disposal = service.dispose()
		expect(service.dispose()).toBe(disposal)
		expect(provider.removeTaskFromStack).toHaveBeenCalledExactlyOnceWith({
			taskId: alphaTask.taskId,
			requireAbortSuccess: true,
		})
		await expect(disposal).rejects.toThrow("cleanup failed")
		expect(leaseReleases.size).toBe(0)
		expect(service.getState().runs[0].status).toBe("running")
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Could not stop scheduled task service"))
	})

	it("retries failed Alpha tree cleanup only on a later explicit disposal", async () => {
		const schedule = await service.createTask(payload())
		await launch(schedule.id)
		provider.removeTaskFromStack.mockRejectedValueOnce(new Error("Transient process cleanup failure"))

		const failed = service.dispose()
		await expect(failed).rejects.toThrow("cleanup failed")
		expect(leaseReleases.size).toBe(0)
		expect(provider.removeTaskFromStack).toHaveBeenCalledOnce()
		const retried = service.dispose()
		expect(retried).not.toBe(failed)
		await retried
		expect(provider.removeTaskFromStack).toHaveBeenCalledTimes(2)
		expect(leaseReleases.size).toBe(1)
		expect(service.getState().runs[0].status).toBe("failed")
		expect(service.dispose()).toBe(retried)
	})

	it("keeps successful Alpha branches settled when retrying another branch's disposal", async () => {
		const firstSchedule = await service.createTask(payload({ name: "First scheduled task" }))
		const secondSchedule = await service.createTask(payload({ name: "Second scheduled task" }))
		const first = await launch(firstSchedule.id)
		const second = await launch(secondSchedule.id)
		provider.removeTaskFromStack
			.mockRejectedValueOnce(new Error("First branch cleanup failed"))
			.mockResolvedValueOnce(undefined)

		await expect(service.dispose()).rejects.toThrow("cleanup failed")
		expect(provider.removeTaskFromStack.mock.calls).toEqual([
			[{ taskId: first.alphaTask.taskId, requireAbortSuccess: true }],
			[{ taskId: second.alphaTask.taskId, requireAbortSuccess: true }],
		])
		await service.dispose()
		expect(provider.removeTaskFromStack.mock.calls).toEqual([
			[{ taskId: first.alphaTask.taskId, requireAbortSuccess: true }],
			[{ taskId: second.alphaTask.taskId, requireAbortSuccess: true }],
			[{ taskId: first.alphaTask.taskId, requireAbortSuccess: true }],
		])
		expect(leaseReleases.size).toBe(1)
		expect(service.getState().runs.every((run) => run.status === "failed")).toBe(true)
	})

	it("retries a failed disposal terminal write without stopping the Alpha tree again", async () => {
		const schedule = await service.createTask(payload())
		await launch(schedule.id)
		const completeSpy = vi
			.spyOn(ScheduledTaskStore.prototype, "completeRun")
			.mockRejectedValueOnce(new Error("Transient shutdown persistence failure"))

		await expect(service.dispose()).rejects.toThrow("cleanup failed")
		expect(leaseReleases.size).toBe(0)
		expect(provider.removeTaskFromStack).toHaveBeenCalledOnce()
		expect(completeSpy).toHaveBeenCalledOnce()
		await service.dispose()
		expect(provider.removeTaskFromStack).toHaveBeenCalledOnce()
		expect(completeSpy).toHaveBeenCalledTimes(2)
		expect(completeSpy.mock.calls[1][0]).toBe(completeSpy.mock.calls[0][0])
		expect(leaseReleases.size).toBe(1)
		expect(service.getState().runs[0].status).toBe("failed")
	})

	it("joins an Alpha task admitted during disposal before releasing the owner", async () => {
		const schedule = await service.createTask(payload())
		const creating = deferred()
		const releaseCreation = deferred<AlphaTask>()
		const closing = deferred()
		const releaseClose = deferred()
		const alphaTask = makeAlphaTask("admitting-during-disposal", () => {})
		provider.createTask.mockImplementationOnce(async () => {
			creating.resolve()
			return releaseCreation.promise
		})
		provider.removeTaskFromStack.mockImplementationOnce(async () => {
			closing.resolve()
			await releaseClose.promise
		})
		await service.runNow(schedule.id)
		await creating.promise
		const disposal = service.dispose()
		try {
			expect(leaseReleases.size).toBe(0)
			expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
			releaseCreation.resolve(alphaTask)
			await closing.promise
			expect(leaseReleases.size).toBe(0)
			expect(alphaTask.start).not.toHaveBeenCalled()
			releaseClose.resolve()
			await disposal
			expect(provider.removeTaskFromStack).toHaveBeenCalledExactlyOnceWith({
				taskId: alphaTask.taskId,
				requireAbortSuccess: true,
			})
			expect(leaseReleases.size).toBe(1)
			expect(service.getState().runs[0].status).toBe("failed")
		} finally {
			releaseCreation.resolve(alphaTask)
			releaseClose.resolve()
			await disposal
		}
	})

	it("stops an admission waiting for its profile before creating another Alpha task", async () => {
		const schedule = await service.createTask(payload())
		const loading = deferred()
		const releaseProfile = deferred<typeof profile>()
		provider.providerSettingsManager.getProfile.mockImplementationOnce(async () => {
			loading.resolve()
			return releaseProfile.promise
		})
		await service.runNow(schedule.id)
		await loading.promise
		const disposal = service.dispose()
		try {
			expect(leaseReleases.size).toBe(0)
			releaseProfile.resolve(profile)
			await disposal
			expect(provider.createTask).not.toHaveBeenCalled()
			expect(leaseReleases.size).toBe(1)
			expect(service.getState().runs[0].status).toBe("failed")
		} finally {
			releaseProfile.resolve(profile)
			await disposal
		}
	})

	it("stops retry timers and detaches listeners when disposed with a pending terminal intent", async () => {
		const schedule = await service.createTask(payload())
		const { alphaTask } = await launch(schedule.id)
		const completeSpy = vi
			.spyOn(ScheduledTaskStore.prototype, "completeRun")
			.mockRejectedValueOnce(new Error("Transient terminal write failure"))
		await terminal(AlphaCodeEventName.TaskCompleted, alphaTask.taskId)

		service.dispose()
		await vi.advanceTimersByTimeAsync(TICK_MS * 5)
		expect(tick).not.toHaveBeenCalled()
		expect(completeSpy).toHaveBeenCalledOnce()
		expect(alphaTask.abortTask).not.toHaveBeenCalled()
		expect(provider.listenerCount(AlphaCodeEventName.TaskCompleted)).toBe(0)
		expect(provider.listenerCount(AlphaCodeEventName.TaskAborted)).toBe(0)
	})

	it("joins an already-admitted terminal write after disposal without presenting notifications", async () => {
		const schedule = await service.createTask(payload({ notificationPreference: "on_completion" }))
		const { alphaTask, run } = await launch(schedule.id)
		const writing = deferred()
		const releaseWrite = deferred()
		const completeRun = ScheduledTaskStore.prototype.completeRun
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementationOnce(async function (
			this: ScheduledTaskStore,
			terminalRun,
		) {
			writing.resolve()
			await releaseWrite.promise
			return completeRun.call(this, terminalRun)
		})
		const showInformation = vi.spyOn(vscode.window, "showInformationMessage")
		const completion = terminal(AlphaCodeEventName.TaskCompleted, alphaTask.taskId)
		try {
			await writing.promise
			const messageCount = provider.postMessageToWebview.mock.calls.length
			service.dispose()
			expect(leaseReleases.size).toBe(0)
			releaseWrite.resolve()
			await completion
			await service.dispose()

			expect(service.getState().runs.find((candidate) => candidate.id === run.id)?.status).toBe("succeeded")
			expect(leaseReleases.size).toBe(1)
			expect(provider.postMessageToWebview).toHaveBeenCalledTimes(messageCount + 1)
			expect(showInformation).not.toHaveBeenCalled()
			expect(alphaTask.abortTask).not.toHaveBeenCalled()
		} finally {
			releaseWrite.resolve()
			await completion
		}
	})
})
