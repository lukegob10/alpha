import { EventEmitter } from "events"
import { setImmediate } from "timers/promises"
import * as vscode from "vscode"
import { scheduledTaskSchema, type ScheduledTask, type ScheduledTaskRun } from "@alpha-code/types"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"

const commandRunner = vi.hoisted(() => vi.fn(async () => ({ stdout: "done", stderr: "" })))

vi.mock("../runScheduledCommand", () => ({ runScheduledCommand: commandRunner }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { promise, resolve }
}

function notificationChoice(choice: Promise<boolean>) {
	return async <T extends string | vscode.MessageItem>(
		_message: string,
		...items: Array<T | vscode.MessageOptions>
	): Promise<T | undefined> =>
		(await choice)
			? items.find((item): item is T => typeof item === "string" || (typeof item === "object" && "title" in item))
			: undefined
}

describe("before-run notifications remain advisory", () => {
	afterEach(() => vi.restoreAllMocks())

	function fixture(kind: "prompt" | "command", approvalMode: "ask" | "bypass" = "bypass") {
		commandRunner.mockClear()
		const tasks: ScheduledTask[] = ["first", "second"].map((id, index) =>
			scheduledTaskSchema.parse({
				id,
				name: id,
				prompt: "Review the repository",
				apiConfig: { id: "background", name: "Background" },
				workspace: "F:/workspace",
				enabled: true,
				mode: "code",
				execution: kind === "command" ? { type: "command", command: "echo done" } : { type: "prompt" },
				autoApproval: { approvalMode },
				schedule: { type: "daily", startAt: Date.now() + 60_000, timezone: "UTC", intervalDays: 1 },
				permissions: {},
				notificationPreference: index === 0 ? "before_run" : "never",
				createdAt: 1,
				updatedAt: 1,
			}),
		)
		const runs: ScheduledTaskRun[] = []
		const save = (run: ScheduledTaskRun) => {
			const index = runs.findIndex((candidate) => candidate.id === run.id)
			if (index === -1) runs.push(run)
			else runs[index] = run
		}
		vi.spyOn(ScheduledTaskStore.prototype, "getTask").mockImplementation((id) =>
			tasks.find((task) => task.id === id),
		)
		vi.spyOn(ScheduledTaskStore.prototype, "getState").mockImplementation(() => ({ tasks, runs }))
		vi.spyOn(ScheduledTaskStore.prototype, "refresh").mockResolvedValue(false)
		vi.spyOn(ScheduledTaskStore.prototype, "claimRun").mockImplementation(async (id, _time, _trigger, build) => {
			const claimed = build(tasks.find((task) => task.id === id)!, false)
			save(claimed.run)
			return claimed
		})
		vi.spyOn(ScheduledTaskStore.prototype, "projectRunStatus").mockImplementation(async (run) => {
			save(run)
			return true
		})
		vi.spyOn(ScheduledTaskStore.prototype, "upsertRun").mockImplementation(async (run) => {
			save(run)
			return { tasks, runs }
		})
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementation(async (run) => {
			save(run)
			return { task: tasks.find((task) => task.id === run.taskId)!, run }
		})
		let count = 0
		const start = vi.fn()
		const abortTask = vi.fn(async () => undefined)
		const provider = Object.assign(new EventEmitter(), {
			createTask: vi.fn(async () => ({
				taskId: `alpha-${++count}`,
				prepareReasoningForAdmission: vi.fn(async () => undefined),
				start,
				abortTask,
			})),
			providerSettingsManager: {
				getProfile: vi.fn(async () => ({ id: "background", name: "Background", apiProvider: "openai" })),
			},
			postMessageToWebview: vi.fn(async () => undefined),
			getState: vi.fn(async () => ({ approvalMode: "bypass", deniedCommands: [] })),
		})
		const outputChannel = { appendLine: vi.fn() }
		const service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: "unused-audit-storage" } } as vscode.ExtensionContext,
			provider as unknown as AlphaProvider,
			outputChannel as unknown as vscode.OutputChannel,
		)
		const processQueue = vi.spyOn(service as unknown as { processQueue: () => Promise<void> }, "processQueue")
		return { service, runs, start, abortTask, processQueue, outputChannel }
	}

	it.each(["prompt", "command"] as const)(
		"starts %s work and later schedules while the before-run toast remains open",
		async (kind) => {
			const { service, runs, start, abortTask, processQueue } = fixture(kind)
			const entered = deferred<void>()
			const dismissed = deferred<undefined>()
			vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(() => {
				entered.resolve()
				return dismissed.promise
			})
			try {
				await service.runNow("first")
				await entered.promise
				await service.runNow("second")
				// Every downstream dependency resolves immediately. One event-loop turn
				// drains admission work without resolving the controlled user toast.
				await setImmediate()
				expect(kind === "prompt" ? start : commandRunner).toHaveBeenCalledTimes(2)
				expect(runs.some((run) => run.status === "queued")).toBe(false)
				service.dispose()
				if (kind === "prompt") expect(abortTask).toHaveBeenCalledTimes(2)
			} finally {
				dismissed.resolve(undefined)
				await Promise.all(processQueue.mock.results.map((result) => result.value))
				service.dispose()
			}
		},
	)

	it.each(["prompt", "command"] as const)(
		"still starts %s work if the before-run notification rejects",
		async (kind) => {
			const { service, runs, start, processQueue, outputChannel } = fixture(kind)
			vi.spyOn(vscode.window, "showInformationMessage").mockRejectedValueOnce(
				new Error("Notification unavailable"),
			)
			try {
				await service.runNow("first")
				await Promise.all(processQueue.mock.results.map((result) => result.value))
				expect(kind === "prompt" ? start : commandRunner).toHaveBeenCalledOnce()
				expect(runs[0].status).toBe(kind === "prompt" ? "running" : "succeeded")
				expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Could not notify start"))
			} finally {
				service.dispose()
			}
		},
	)

	it.each([false, true])("honors Review only while the service is active (disposed: %s)", async (dispose) => {
		const { service, runs, processQueue } = fixture("prompt")
		const dismissed = deferred<boolean>()
		vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(notificationChoice(dismissed.promise))
		const internal = service as unknown as {
			openScheduledTask(taskId: string, runId?: string): Promise<void>
			notifyBeforeRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<void>
		}
		const notify = vi.spyOn(internal, "notifyBeforeRun")
		const review = vi.spyOn(internal, "openScheduledTask").mockResolvedValue(undefined)
		try {
			await service.runNow("first")
			await Promise.all(processQueue.mock.results.map((result) => result.value))
			if (dispose) service.dispose()
			dismissed.resolve(true)
			await Promise.all(notify.mock.results.map((result) => result.value))
			if (dispose) expect(review).not.toHaveBeenCalled()
			else expect(review).toHaveBeenCalledExactlyOnceWith("first", runs[0].id)
		} finally {
			dismissed.resolve(true)
			service.dispose()
		}
	})

	it("finishes a prompt and releases its task while the before-run toast is still open", async () => {
		const { service, runs, abortTask, processQueue } = fixture("prompt")
		const dismissed = deferred<undefined>()
		vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(() => dismissed.promise)
		try {
			await service.runNow("first")
			await Promise.all(processQueue.mock.results.map((result) => result.value))
			await (service as unknown as { handleTaskCompleted(id: string): Promise<void> }).handleTaskCompleted(
				"alpha-1",
			)
			expect(runs[0].status).toBe("succeeded")
			service.dispose()
			expect(abortTask).not.toHaveBeenCalled()
		} finally {
			dismissed.resolve(undefined)
			service.dispose()
		}
	})

	it.each(["Run once", undefined] as const)(
		"keeps command approval separate while the before-run toast is open (decision: %s)",
		async (decision) => {
			const { service, runs, processQueue } = fixture("command", "ask")
			const dismissed = deferred<undefined>()
			const approved = deferred<boolean>()
			vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(() => dismissed.promise)
			const approval = vi
				.spyOn(vscode.window, "showWarningMessage")
				.mockImplementationOnce(notificationChoice(approved.promise))
			const admission = vi.spyOn(
				service as unknown as { awaitCommandApproval(...args: unknown[]): Promise<void> },
				"awaitCommandApproval",
			)
			try {
				await service.runNow("first")
				await Promise.all(processQueue.mock.results.map((result) => result.value))
				expect(approval).toHaveBeenCalledWith(expect.stringContaining("echo done"), { modal: true }, "Run once")
				expect(runs[0].status).toBe("waiting_for_approval")
				expect(commandRunner).not.toHaveBeenCalled()
				approved.resolve(Boolean(decision))
				await Promise.all(admission.mock.results.map((result) => result.value))
				expect(commandRunner).toHaveBeenCalledTimes(decision ? 1 : 0)
				expect(runs[0].status).toBe(decision ? "succeeded" : "canceled")
			} finally {
				approved.resolve(false)
				dismissed.resolve(undefined)
				service.dispose()
			}
		},
	)
})
