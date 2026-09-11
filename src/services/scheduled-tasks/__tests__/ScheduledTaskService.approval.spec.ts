import type * as vscode from "vscode"
import { scheduledTaskAutoApprovalSchema, scheduledTaskSchema } from "@alpha-code/types"

import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"

afterEach(() => vi.restoreAllMocks())

describe("scheduled task approval grants", () => {
	it.each([false, true])(
		"keeps ticket mutations subject to approval when file writes are %s",
		async (alwaysAllowWrite) => {
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
				autoApproval: scheduledTaskAutoApprovalSchema.parse({ alwaysAllowWrite }),
			})
			vi.spyOn(ScheduledTaskStore.prototype, "getTask").mockReturnValue(task)
			vi.spyOn(ScheduledTaskStore.prototype, "getRunsForTask").mockReturnValue([])
			vi.spyOn(ScheduledTaskStore.prototype, "getState").mockReturnValue({ tasks: [task], runs: [] })
			vi.spyOn(ScheduledTaskStore.prototype, "updateTaskAndRun").mockResolvedValue({ tasks: [task], runs: [] })
			let finishRun!: () => void
			const launched = new Promise<void>((resolve) => (finishRun = resolve))
			vi.spyOn(ScheduledTaskStore.prototype, "upsertRun").mockImplementation(async (run) => {
				if (run.alphaTaskId) finishRun()
				return { tasks: [task], runs: [run] }
			})
			const createTask = vi.fn().mockResolvedValue({ taskId: "alpha-task-1" })
			const provider = {
				createTask,
				providerSettingsManager: {
					getProfile: vi
						.fn()
						.mockResolvedValue({ id: "background", name: "Background", apiProvider: "openai" }),
				},
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
				off: vi.fn(),
			} as unknown as ClineProvider
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
					expect.objectContaining({ background: true }),
					expect.objectContaining({ autoApprovalEnabled: true, alwaysAllowWrite, alwaysAllowTickets: false }),
				)
			} finally {
				service.dispose()
			}
		},
	)
})
