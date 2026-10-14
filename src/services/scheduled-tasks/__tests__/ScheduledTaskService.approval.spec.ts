import * as vscode from "vscode"
import { scheduledTaskAutoApprovalSchema, scheduledTaskSchema, type ScheduledTaskRun } from "@alpha-code/types"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"

afterEach(() => vi.restoreAllMocks())

describe("scheduled task approval grants", () => {
	it.each([
		{ approvalMode: "ask" as const, canMutate: false },
		{ approvalMode: "auto" as const, canMutate: true },
		{ approvalMode: "bypass" as const, canMutate: true },
	])("stores $approvalMode for a direct command without forcing execute", async ({ approvalMode, canMutate }) => {
		vi.spyOn(ScheduledTaskStore.prototype, "upsertTask").mockResolvedValue({ tasks: [], runs: [] })
		vi.spyOn(ScheduledTaskStore.prototype, "getState").mockReturnValue({ tasks: [], runs: [] })
		const provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			off: vi.fn(),
		} as unknown as AlphaProvider
		const service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext,
			provider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		try {
			const task = await service.createTask({
				name: "Check repository",
				prompt: "Check repository",
				execution: { type: "command", command: "pnpm test" },
				autoApproval: { approvalMode },
				workspace: "/workspace",
				schedule: { type: "once", startAt: Date.now() + 60_000, timezone: "UTC" },
			})
			expect(task.autoApproval).toEqual({ approvalMode })
			expect(task.permissions).toMatchObject({ readFiles: true, runCommands: canMutate, editFiles: canMutate })
		} finally {
			service.dispose()
		}
	})

	it.each([
		{ saved: { approvalMode: "ask" as const }, expected: "ask" },
		{ saved: { approvalMode: "auto" as const }, expected: "auto" },
		{ saved: { approvalMode: "bypass" as const }, expected: "bypass" },
		{ saved: { autoApprovalEnabled: true, alwaysAllowReadOnly: true }, expected: "ask" },
		{ saved: undefined, expected: "ask" },
	])(
		"starts a background prompt with task-scoped $expected approval and no global settings override",
		async ({ saved, expected }) => {
			const task = scheduledTaskSchema.parse({
				id: "scheduled-1",
				name: "Review repository",
				prompt: "Review repository work",
				apiConfig: { id: "background", name: "Background" },
				workspace: "/workspace",
				enabled: true,
				schedule: { type: "daily", startAt: 1_000, timezone: "UTC", intervalDays: 1 },
				permissions: {},
				notificationPreference: "on_failure",
				createdAt: 1,
				updatedAt: 1,
				autoApproval: saved ? scheduledTaskAutoApprovalSchema.parse(saved) : undefined,
			})
			vi.spyOn(ScheduledTaskStore.prototype, "getTask").mockReturnValue(task)
			vi.spyOn(ScheduledTaskStore.prototype, "getRunsForTask").mockReturnValue([])
			vi.spyOn(ScheduledTaskStore.prototype, "getState").mockReturnValue({ tasks: [task], runs: [] })
			vi.spyOn(ScheduledTaskStore.prototype, "refresh").mockResolvedValue(false)
			vi.spyOn(ScheduledTaskStore.prototype, "claimRun").mockImplementation(async (_id, _time, _trigger, build) =>
				build(task, false),
			)
			vi.spyOn(ScheduledTaskStore.prototype, "projectRunStatus").mockResolvedValue(true)
			let finishRun!: () => void
			const launched = new Promise<void>((resolve) => (finishRun = resolve))
			vi.spyOn(ScheduledTaskStore.prototype, "upsertRun").mockImplementation(async (run) => {
				if (run.alphaTaskId) finishRun()
				return { tasks: [task], runs: [run] }
			})
			const createTask = vi.fn().mockResolvedValue({
				taskId: "alpha-task-1",
				prepareReasoningForAdmission: vi.fn().mockResolvedValue(undefined),
				start: vi.fn(),
				abortTask: vi.fn().mockResolvedValue(undefined),
			})
			const provider = {
				createTask,
				providerSettingsManager: {
					getProfile: vi
						.fn()
						.mockResolvedValue({ id: "background", name: "Background", apiProvider: "openai" }),
				},
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
				off: vi.fn(),
			} as unknown as AlphaProvider
			const service = new ScheduledTaskService(
				{ globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext,
				provider,
				{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			)

			try {
				await service.runNow(task.id)
				await launched
				expect(createTask).toHaveBeenCalledWith(
					expect.any(String),
					undefined,
					undefined,
					expect.objectContaining({ background: true, taskApprovalMode: expected }),
				)
			} finally {
				service.dispose()
			}
		},
	)
})

describe("scheduled direct command approval", () => {
	it.each(["ask", "auto", "bypass"] as const)("applies %s command rules at run time", async (approvalMode) => {
		const command = approvalMode === "auto" ? "node --version" : "pnpm test"
		const task = scheduledTaskSchema.parse({
			id: "command-schedule",
			name: "Check repository",
			prompt: "Check repository",
			execution: { type: "command", command },
			autoApproval: { approvalMode },
			workspace: process.cwd(),
			enabled: true,
			schedule: { type: "daily", startAt: 1_000, timezone: "UTC", intervalDays: 1 },
			permissions: {},
			notificationPreference: "never",
			createdAt: 1,
			updatedAt: 1,
		})
		let currentRun: ScheduledTaskRun | undefined
		vi.spyOn(ScheduledTaskStore.prototype, "getTask").mockReturnValue(task)
		vi.spyOn(ScheduledTaskStore.prototype, "getRunsForTask").mockImplementation(() =>
			currentRun ? [currentRun] : [],
		)
		vi.spyOn(ScheduledTaskStore.prototype, "getState").mockImplementation(() => ({
			tasks: [task],
			runs: currentRun ? [currentRun] : [],
		}))
		vi.spyOn(ScheduledTaskStore.prototype, "refresh").mockResolvedValue(false)
		vi.spyOn(ScheduledTaskStore.prototype, "claimRun").mockImplementation(async (_id, _time, _trigger, build) => {
			const claimed = build(task, false)
			currentRun = claimed.run
			return claimed
		})
		vi.spyOn(ScheduledTaskStore.prototype, "projectRunStatus").mockImplementation(async (run) => {
			currentRun = run
			return true
		})
		vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementation(async (run) => {
			currentRun = run
			return { task, run }
		})
		let resolveApproval!: (decision: vscode.MessageItem | undefined) => void
		const approvalResponse = new Promise<vscode.MessageItem | undefined>((resolve) => {
			resolveApproval = resolve
		})
		const warning = vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(() => approvalResponse)
		const provider = {
			getState: vi.fn().mockResolvedValue({
				allowedCommands: [],
				deniedCommands: approvalMode === "bypass" ? ["pnpm"] : [],
			}),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			off: vi.fn(),
		} as unknown as AlphaProvider
		const service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext,
			provider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		try {
			await service.runNow(task.id)
			if (approvalMode === "bypass") {
				await vi.waitFor(() => expect(currentRun?.status).toBe("failed"))
				expect(currentRun?.error).toContain("deny rule")
				expect(warning).not.toHaveBeenCalled()
				return
			}
			if (approvalMode === "auto") {
				await vi.waitFor(() => expect(currentRun?.status).toBe("succeeded"))
				expect(currentRun?.exitCode).toBe(0)
				expect(warning).not.toHaveBeenCalled()
				return
			}
			await vi.waitFor(() => expect(currentRun?.status).toBe("waiting_for_approval"))
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("pnpm test"), { modal: true }, "Run once")
			resolveApproval(undefined)
			await vi.waitFor(() => expect(currentRun?.status).toBe("canceled"))
		} finally {
			service.dispose()
		}
	})
})

it("fails a legacy prompt with private deny rules before starting an agent", async () => {
	const task = scheduledTaskSchema.parse({
		id: "legacy-denied",
		name: "Legacy review",
		prompt: "Review the repository",
		apiConfig: { id: "background", name: "Background" },
		autoApproval: { autoApprovalEnabled: true, alwaysAllowReadOnly: true, deniedCommands: ["rm"] },
		workspace: "/workspace",
		enabled: true,
		schedule: { type: "daily", startAt: 1_000, timezone: "UTC", intervalDays: 1 },
		permissions: {},
		notificationPreference: "never",
		createdAt: 1,
		updatedAt: 1,
	})
	let currentRun: ScheduledTaskRun | undefined
	vi.spyOn(ScheduledTaskStore.prototype, "getTask").mockReturnValue(task)
	vi.spyOn(ScheduledTaskStore.prototype, "getRunsForTask").mockReturnValue([])
	vi.spyOn(ScheduledTaskStore.prototype, "getState").mockImplementation(() => ({
		tasks: [task],
		runs: currentRun ? [currentRun] : [],
	}))
	vi.spyOn(ScheduledTaskStore.prototype, "refresh").mockResolvedValue(false)
	vi.spyOn(ScheduledTaskStore.prototype, "claimRun").mockImplementation(async (_id, _time, _trigger, build) => {
		const claimed = build(task, false)
		currentRun = claimed.run
		return claimed
	})
	vi.spyOn(ScheduledTaskStore.prototype, "projectRunStatus").mockImplementation(async (run) => {
		currentRun = run
		return true
	})
	vi.spyOn(ScheduledTaskStore.prototype, "completeRun").mockImplementation(async (run) => {
		currentRun = run
		return { task, run }
	})
	const createTask = vi.fn()
	const provider = {
		createTask,
		providerSettingsManager: {
			getProfile: vi.fn().mockResolvedValue({ id: "background", name: "Background", apiProvider: "openai" }),
		},
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		off: vi.fn(),
	} as unknown as AlphaProvider
	const service = new ScheduledTaskService(
		{ globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext,
		provider,
		{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
	)
	try {
		await service.runNow(task.id)
		await vi.waitFor(() => expect(currentRun?.status).toBe("failed"))
		expect(currentRun?.error).toContain("legacy schedule")
		expect(createTask).not.toHaveBeenCalled()
	} finally {
		service.dispose()
	}
})
