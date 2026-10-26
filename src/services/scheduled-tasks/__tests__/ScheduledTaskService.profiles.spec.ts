import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { EventEmitter } from "events"
import {
	AlphaCodeEventName,
	type CreateScheduledTaskPayload,
	type ExtensionMessage,
	type ScheduledTaskRun,
} from "@alpha-code/types"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { ScheduledTaskService } from "../ScheduledTaskService"
import { ScheduledTaskStore } from "../ScheduledTaskStore"
import { SkillsManager } from "../../skills/SkillsManager"
import { buildSkillResult } from "../../skills/skillInvocation"
import labels from "../../../i18n/locales/en/scheduledTasks.json"

vi.mock("../../../utils/storage", () => ({ getStorageBasePath: (base: string) => base }))
vi.mock("../../../i18n", () => ({
	t: (key: string, options?: { name: string }) => {
		const label = labels[key.replace("scheduledTasks:", "") as keyof typeof labels]
		return label?.replace("{{name}}", options?.name ?? "") ?? key
	},
}))

const apiConfig = { id: "background-profile", name: "Internal models" }
const profile = { ...apiConfig, apiProvider: "openai" as const, openAiModelId: "internal-model" }

describe("scheduled profiles and skills", () => {
	let tmpDir: string
	let service: ScheduledTaskService
	let provider: ReturnType<typeof makeProvider>
	let onRun: ((run: ScheduledTaskRun) => void) | undefined
	const ownedStores = new Set<ScheduledTaskStore>()
	const leaseReleases = new Set<Promise<void>>()

	function makeProvider() {
		const createTask = vi.fn(async (..._args: Parameters<AlphaProvider["createTask"]>) => ({
			taskId: "alpha-task",
			prepareReasoningForAdmission: vi.fn(async () => undefined),
			start: vi.fn(),
			abortTask: vi.fn(async () => undefined),
		}))
		return Object.assign(new EventEmitter(), {
			cwd: path.join(tmpDir, "coding-workspace"),
			currentApiConfigName: "Coding",
			createTask,
			removeTaskFromStack: vi.fn(async ({ taskId }: { taskId: string }) => {
				for (const result of createTask.mock.results) {
					const task = await result.value
					if (task.taskId === taskId) {
						await task.abortTask()
						return
					}
				}
			}),
			setProviderProfile: vi.fn(),
			providerSettingsManager: { getProfile: vi.fn().mockResolvedValue(profile) },
			postMessageToWebview: vi.fn(async (message: ExtensionMessage) => {
				for (const run of message.scheduledTaskRuns ?? []) {
					if (run.alphaTaskId || run.status === "failed") onRun?.(run)
				}
			}),
		})
	}

	const payload = (overrides: Partial<CreateScheduledTaskPayload> = {}): CreateScheduledTaskPayload => ({
		name: "Scheduled review",
		prompt: "Review repository health",
		apiConfig,
		mode: "architect",
		workspace: path.join(tmpDir, "scheduled-workspace"),
		schedule: { type: "daily", startAt: Date.now() + 60_000, timezone: "UTC", intervalDays: 1 },
		notificationPreference: "never",
		...overrides,
	})

	async function runNow(taskId: string) {
		const previousIds = new Set(service.getState().runs.map((run) => run.id))
		const finished = new Promise<ScheduledTaskRun>((resolve) => {
			onRun = (run) => {
				if (!previousIds.has(run.id)) resolve(run)
			}
		})
		await service.runNow(taskId)
		return finished
	}

	beforeEach(async () => {
		ownedStores.clear()
		leaseReleases.clear()
		const acquireLease = ScheduledTaskStore.prototype.acquireOwnerLease
		vi.spyOn(ScheduledTaskStore.prototype, "acquireOwnerLease").mockImplementation(async function (
			this: ScheduledTaskStore,
			...args: Parameters<ScheduledTaskStore["acquireOwnerLease"]>
		) {
			ownedStores.add(this)
			const release = await acquireLease.apply(this, args)
			return () => {
				const pending = release()
				leaseReleases.add(pending)
				return pending
			}
		})
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-profiles-"))
		provider = makeProvider()
		Object.assign(vscode.workspace, {
			workspaceFolders: [
				{ uri: vscode.Uri.file(path.join(tmpDir, "scheduled-workspace")) },
				{ uri: vscode.Uri.file(provider.cwd) },
			],
		})
		service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			provider as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		await service.initialize()
	})

	afterEach(async () => {
		await service.dispose()
		Object.assign(vscode.workspace, { workspaceFolders: [] })
		onRun = undefined
		// Join independently owned store transactions before deleting their storage.
		await Promise.all([
			...leaseReleases,
			...Array.from(ownedStores, (store) => Reflect.get(store, "writeLock") as Promise<void>),
		])
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("rejects a schedule for a repository that is not open in this window", async () => {
		await expect(service.createTask(payload({ workspace: path.join(tmpDir, "other-repo") }))).rejects.toThrow(
			"workspace must be an open workspace root",
		)
		await expect(service.getSkills(path.join(tmpDir, "other-repo"), "architect")).rejects.toThrow(
			labels.workspaceInvalid,
		)
		expect(service.getState().tasks).toEqual([])
	})

	it("starts valid schedules after reloading an invalid due record and preserves that record", async () => {
		const task = await service.createTask(payload())
		await service.dispose()
		const invalid = {
			...task,
			id: "invalid-schedule",
			name: "A malformed schedule",
			schedule: { type: "unsupported" },
			nextRunAt: Date.now() - 120_000,
		}
		const file = path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json")
		await fs.writeFile(file, JSON.stringify([invalid, task]), "utf8")
		service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			provider as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		await service.initialize()
		const running = await runNow(task.id)
		expect(running.status).toBe("running")
		expect(service.getState().tasks.map((schedule) => schedule.id)).toEqual([task.id])
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toContainEqual(invalid)
	})

	it("does not fail a running schedule when another window opens the same repository", async () => {
		const task = await service.createTask(payload())
		const running = await runNow(task.id)
		expect(running.status).toBe("running")

		const otherProvider = makeProvider()
		const otherWindow = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			otherProvider as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		try {
			await otherWindow.initialize()
			expect(otherWindow.getState().runs.find((run) => run.id === running.id)?.status).toBe("running")
			expect(otherProvider.createTask).not.toHaveBeenCalled()
		} finally {
			otherWindow.dispose()
		}
	})

	it("completes a captured run after its schedule moves to a repository closed in this window", async () => {
		const task = await service.createTask(payload())
		const running = await runNow(task.id)
		const nextWorkspace = path.join(tmpDir, "next-workspace")
		const originalFolders = vscode.workspace.workspaceFolders
		Object.assign(vscode.workspace, {
			workspaceFolders: [...(originalFolders ?? []), { uri: vscode.Uri.file(nextWorkspace) }],
		})
		await service.updateTask(task.id, { workspace: nextWorkspace })
		Object.assign(vscode.workspace, { workspaceFolders: originalFolders })
		expect(service.getState().tasks).toEqual([])

		provider.emit(AlphaCodeEventName.TaskCompleted, "alpha-task")
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		await vi.waitFor(async () => {
			await reloaded.refresh()
			expect(reloaded.getState().runs.find((run) => run.id === running.id)?.status).toBe("succeeded")
		})
	})

	it("does not mark an occurrence missed while it is within the normal tick interval", async () => {
		const task = await service.createTask(payload())
		const editor = new ScheduledTaskStore(tmpDir)
		await editor.initialize()
		await editor.upsertTask({ ...task, nextRunAt: Date.now() - 1_000 })

		const otherWindow = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			makeProvider() as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		try {
			await otherWindow.initialize()
			expect(otherWindow.getState().tasks[0]?.enabled).toBe(true)
			expect(otherWindow.getState().runs).toEqual([])
		} finally {
			otherWindow.dispose()
		}
	})

	it("recovers a queued run whose owning window is gone", async () => {
		const task = await service.createTask(payload())
		const editor = new ScheduledTaskStore(tmpDir)
		await editor.initialize()
		await editor.upsertRun({
			id: "orphaned-run",
			taskId: task.id,
			ownerId: "299ad2b6-c3a8-477a-8d9d-a0cd57fbd884",
			status: "queued",
			trigger: "schedule",
			scheduledFor: task.nextRunAt!,
			workspace: task.workspace,
			prompt: task.prompt,
		})

		const otherWindow = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			makeProvider() as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		try {
			await otherWindow.initialize()
			expect(otherWindow.getState().runs.find((run) => run.id === "orphaned-run")?.status).toBe("failed")
		} finally {
			otherWindow.dispose()
		}
	})

	it("persists create, update and duplicate profiles and skill arguments across reload", async () => {
		const task = await service.createTask(payload())
		const selected = { id: "second-profile", name: "Second" }
		const execution = {
			type: "skill" as const,
			skillName: "review",
			skillPath: path.join(tmpDir, "SKILL.md"),
			arguments: "inbox",
		}
		await service.updateTask(task.id, { apiConfig: selected, execution, prompt: "" })
		await service.duplicateTask(task.id)
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().tasks).toHaveLength(2)
		for (const saved of reloaded.getState().tasks) {
			expect(saved).toMatchObject({ apiConfig: selected, execution, prompt: "" })
		}
	})

	it("persists an independent reasoning preference through update, duplication, and reload", async () => {
		const reasoningPreference = { kind: "effort" as const, effort: "high" as const }
		const task = await service.createTask(payload({ reasoningPreference }))
		await service.updateTask(task.id, { reasoningPreference: { kind: "off" } })
		await service.duplicateTask(task.id)

		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().tasks).toHaveLength(2)
		expect(reloaded.getState().tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reasoningPreference: { kind: "off" } }),
				expect.objectContaining({ reasoningPreference: { kind: "off" } }),
			]),
		)
	})

	it("launches a prompt on the selected profile and records its resolved identity", async () => {
		const task = await service.createTask(payload())
		const run = await runNow(task.id)
		expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledWith({ id: apiConfig.id })
		expect(provider.createTask).toHaveBeenCalledWith(
			expect.stringContaining(task.prompt),
			undefined,
			undefined,
			expect.objectContaining({
				background: true,
				preserveExisting: true,
				workspacePath: task.workspace,
				taskMode: "architect",
				taskApprovalMode: "auto",
				taskApiConfigName: apiConfig.name,
				apiConfiguration: { apiProvider: "openai", openAiModelId: "internal-model" },
			}),
		)
		expect(provider.setProviderProfile).not.toHaveBeenCalled()
		expect(provider.currentApiConfigName).toBe("Coding")
		expect(run).toMatchObject({ apiConfig, resolvedApiConfig: apiConfig, execution: { type: "prompt" } })
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().runs[0].resolvedApiConfig).toEqual(apiConfig)
		expect(reloaded.getState().runs[0].reasoningPreference).toEqual({ kind: "default" })
	})

	it("passes the queued preference to the task and records its admitted reasoning state", async () => {
		const reasoningPreference = { kind: "effort" as const, effort: "high" as const }
		const reasoningState = {
			requested: reasoningPreference,
			effective: reasoningPreference,
			capabilities: { kind: "effort" as const, efforts: ["low", "medium", "high"] as const, canDisable: true },
		}
		provider.createTask.mockImplementationOnce(
			async () =>
				({
					taskId: "alpha-task",
					prepareReasoningForAdmission: vi.fn(async () => undefined),
					getReasoningState: () => reasoningState,
					start: vi.fn(),
					abortTask: vi.fn(async () => undefined),
				}) as never,
		)
		const task = await service.createTask(payload({ reasoningPreference }))
		const run = await runNow(task.id)

		expect(provider.createTask).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			undefined,
			expect.objectContaining({ reasoningPreference, startTask: false, taskApprovalMode: "auto" }),
		)
		expect(run).toMatchObject({ reasoningPreference, reasoningState })
		const createdTask = (await provider.createTask.mock.results[0]?.value) as {
			prepareReasoningForAdmission: import("vitest").Mock
			start: import("vitest").Mock
		}
		expect(createdTask.prepareReasoningForAdmission).toHaveBeenCalledOnce()
		expect(createdTask.start).toHaveBeenCalledOnce()
	})

	it("cleans up a task when reasoning admission fails before launch", async () => {
		const abortTask = vi.fn(async () => undefined)
		const prepareReasoningForAdmission = vi.fn(async () => {
			throw new Error("live model unavailable")
		})
		const start = vi.fn()
		provider.createTask.mockImplementationOnce(
			async () =>
				({
					taskId: "alpha-task",
					prepareReasoningForAdmission,
					start,
					abortTask,
				}) as never,
		)

		const task = await service.createTask(payload())
		const run = await runNow(task.id)

		expect(run).toMatchObject({ status: "failed", error: "live model unavailable" })
		expect(prepareReasoningForAdmission).toHaveBeenCalledOnce()
		expect(start).not.toHaveBeenCalled()
		expect(abortTask).toHaveBeenCalledOnce()
	})

	it("finalizes a claimed run when admission persistence fails", async () => {
		const task = await service.createTask(payload())
		vi.spyOn(ScheduledTaskStore.prototype, "projectRunStatus").mockRejectedValueOnce(
			new Error("status write failed"),
		)

		const run = await runNow(task.id)
		expect(run).toMatchObject({ status: "failed", error: "status write failed" })
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("does not launch a task after the owning window closes during admission", async () => {
		let releaseAdmission!: () => void
		let admissionEntered!: () => void
		const entered = new Promise<void>((resolve) => (admissionEntered = resolve))
		const admission = new Promise<void>((resolve) => (releaseAdmission = resolve))
		const start = vi.fn()
		const abortTask = vi.fn(async () => undefined)
		provider.createTask.mockImplementationOnce(
			async () =>
				({
					taskId: "closing-task",
					prepareReasoningForAdmission: vi.fn(async () => {
						admissionEntered()
						await admission
					}),
					start,
					abortTask,
				}) as never,
		)
		const task = await service.createTask(payload())
		const finished = new Promise<ScheduledTaskRun>((resolve) => {
			onRun = (run) => {
				if (run.taskId === task.id && run.status === "failed") resolve(run)
			}
		})
		await service.runNow(task.id)
		await entered
		const disposal = service.dispose()
		releaseAdmission()

		await disposal
		expect(abortTask).toHaveBeenCalledOnce()
		await expect(finished).resolves.toMatchObject({
			status: "failed",
			error: "Scheduled task service stopped before admission",
		})
		expect(start).not.toHaveBeenCalled()
	})

	it.each(["hello world", "Review the code.\n\nKeep this paragraph separate."])(
		"sends only the saved prompt text: %s",
		async (prompt) => {
			const task = await service.createTask(payload({ prompt }))
			const run = await runNow(task.id)
			expect(provider.createTask.mock.calls[0][0]).toBe(prompt)
			expect(run).toMatchObject({ prompt, workspace: task.workspace, mode: task.mode, apiConfig })
		},
	)

	it.each([undefined, "weekly"])(
		"keeps only plugin invocation details and the prompt (arguments: %s)",
		async (args) => {
			const task = await service.createTask(
				payload({
					execution: { type: "plugin", pluginName: "review", arguments: args },
					prompt: "Review the repository.",
				}),
			)
			await runNow(task.id)
			expect(provider.createTask.mock.calls[0][0]).toBe(
				`Plugin: review${args ? `\nArguments: ${args}` : ""}\n\nReview the repository.`,
			)
		},
	)

	it.each(["Renamed profile", "INTERNAL MODELS"])(
		"admits a renamed profile %s by stable ID and records its current name",
		async (name) => {
			const reasoningPreference = { kind: "effort", effort: "high" } as const
			const task = await service.createTask(payload({ reasoningPreference }))
			provider.providerSettingsManager.getProfile.mockResolvedValue({ ...profile, name })
			const run = await runNow(task.id)
			expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledWith({ id: apiConfig.id })
			expect(run).toMatchObject({
				status: "running",
				apiConfig,
				resolvedApiConfig: { id: apiConfig.id, name },
				prompt: task.prompt,
				workspace: task.workspace,
				mode: task.mode,
				reasoningPreference,
			})
			expect(provider.createTask).toHaveBeenCalledWith(
				task.prompt,
				undefined,
				undefined,
				expect.objectContaining({
					taskApiConfigName: name,
					apiConfiguration: { apiProvider: profile.apiProvider, openAiModelId: profile.openAiModelId },
					taskMode: task.mode,
					taskApprovalMode: "auto",
					workspacePath: task.workspace,
					reasoningPreference,
				}),
			)
			expect(service.getState().tasks.find((entry) => entry.id === task.id)?.apiConfig).toEqual(apiConfig)
			expect(provider.setProviderProfile).not.toHaveBeenCalled()
		},
	)

	it.each(["missing", "unconfigured", "unloadable"])("fails closed for a %s profile", async (failure) => {
		if (failure === "unconfigured")
			provider.providerSettingsManager.getProfile.mockResolvedValue({ ...profile, apiProvider: undefined })
		else provider.providerSettingsManager.getProfile.mockRejectedValue(new Error("profile unavailable"))
		const task = await service.createTask(payload())
		const run = await runNow(task.id)
		expect(run).toMatchObject({
			status: "failed",
			error: labels.profileUnavailable.replace("{{name}}", apiConfig.name),
		})
		expect(run.resolvedApiConfig).toBeUndefined()
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("loads legacy prompt schedules, fails until a profile is selected, then runs them", async () => {
		const saved = await service.createTask(payload())
		const legacy = { ...saved, apiConfig: undefined, execution: undefined, reasoningPreference: undefined }
		const lookup = vi
			.spyOn(ScheduledTaskStore.prototype, "getTask")
			.mockImplementation((id) => (id === legacy.id ? legacy : undefined))
		const run = await runNow(saved.id)
		expect(run.error).toBe(labels.profileRequired)
		expect(provider.createTask).not.toHaveBeenCalled()
		lookup.mockRestore()
		await service.updateTask(saved.id, { apiConfig })
		const resumed = await runNow(saved.id)
		expect(resumed.resolvedApiConfig).toEqual(apiConfig)
		expect(resumed.reasoningPreference).toEqual({ kind: "default" })
	})

	it("requires an explicit profile on save but leaves command setup independent", async () => {
		await expect(service.createTask(payload({ apiConfig: undefined }))).rejects.toThrow(labels.profileRequired)
		await expect(
			service.createTask(payload({ apiConfig: undefined, execution: { type: "command", command: "echo ok" } })),
		).resolves.toMatchObject({ apiConfig: undefined })
	})

	it.each(["", "Focus on changes since Monday."])(
		"injects only the skill invocation and optional extra text: %s",
		async (extraPrompt) => {
			const content = {
				name: "review",
				source: "project" as const,
				description: "Review a repository",
				path: path.join(tmpDir, "scheduled-workspace", ".agents", "skills", "review", "SKILL.md"),
				instructions: "Read the review checklist and produce a report.",
			}
			vi.spyOn(SkillsManager.prototype, "discoverSkills").mockResolvedValue()
			vi.spyOn(SkillsManager.prototype, "getSkillContent").mockResolvedValue(content)
			const task = await service.createTask(
				payload({
					execution: { type: "skill", skillName: "review", skillPath: content.path, arguments: "weekly" },
					prompt: extraPrompt,
				}),
			)
			await runNow(task.id)
			const prompt = provider.createTask.mock.calls[0][0]
			expect(prompt).toBe(
				[buildSkillResult("review", "weekly", content), extraPrompt].filter(Boolean).join("\n\n"),
			)
			expect(SkillsManager.prototype.getSkillContent).toHaveBeenCalledWith("review", "architect")
		},
	)

	it.each(["missing", "unreadable", "replaced"])(
		"fails without launching a model when a skill is %s",
		async (failure) => {
			vi.spyOn(SkillsManager.prototype, "discoverSkills").mockResolvedValue()
			const lookup = vi.spyOn(SkillsManager.prototype, "getSkillContent")
			if (failure === "unreadable") lookup.mockRejectedValue(new Error("ENOENT"))
			else if (failure === "replaced")
				lookup.mockResolvedValue({
					name: "review",
					source: "global",
					description: "Other skill",
					path: "other/SKILL.md",
					instructions: "Other instructions",
				})
			else lookup.mockResolvedValue(null)
			const task = await service.createTask(
				payload({
					execution: { type: "skill", skillName: "review", skillPath: "selected/SKILL.md" },
					prompt: "",
				}),
			)
			expect((await runNow(task.id)).error).toBe(labels.skillUnavailable.replace("{{name}}", "review"))
			expect(provider.createTask).not.toHaveBeenCalled()
		},
	)

	it("keeps edits made during a run when recording its completion", async () => {
		const task = await service.createTask(payload())
		await runNow(task.id)
		await service.updateTask(task.id, { prompt: "New prompt", apiConfig: { id: "new", name: "New" } })
		const completed = new Promise<ScheduledTaskRun>((resolve) => {
			onRun = (run) => {
				if (run.status === "succeeded") resolve(run)
			}
		})
		provider.emit(AlphaCodeEventName.TaskCompleted, "alpha-task")
		await completed
		expect(service.getState().tasks[0]).toMatchObject({
			prompt: "New prompt",
			apiConfig: { id: "new", name: "New" },
			lastRunStatus: "succeeded",
		})
	})

	it("retains queued profile, mode, workspace and prompt selections when the schedule changes", async () => {
		let releaseProfile!: (value: typeof profile) => void
		let profileRequested!: () => void
		const requested = new Promise<void>((resolve) => {
			profileRequested = resolve
		})
		const blockedProfile = new Promise<typeof profile>((resolve) => {
			releaseProfile = resolve
		})
		provider.providerSettingsManager.getProfile.mockImplementationOnce(() => {
			profileRequested()
			return blockedProfile
		})
		const queuedReasoningPreference = { kind: "effort" as const, effort: "high" as const }
		const first = await service.createTask(payload())
		const second = await service.createTask(
			payload({
				name: "Queued review",
				prompt: "Original prompt",
				reasoningPreference: queuedReasoningPreference,
			}),
		)
		await service.runNow(first.id)
		await requested
		const admitted = new Promise<ScheduledTaskRun>((resolve) => {
			onRun = (run) => {
				if (run.taskId === second.id) resolve(run)
			}
		})
		await service.runNow(second.id)
		await service.updateTask(second.id, {
			apiConfig: { id: "new", name: "New profile" },
			prompt: "Changed prompt",
			mode: "code",
			workspace: provider.cwd,
			reasoningPreference: { kind: "off" },
		})
		releaseProfile(profile)
		const run = await admitted
		expect(run).toMatchObject({
			apiConfig,
			resolvedApiConfig: apiConfig,
			prompt: "Original prompt",
			mode: "architect",
			workspace: second.workspace,
		})
		expect(provider.createTask).toHaveBeenLastCalledWith(
			expect.stringContaining("Original prompt"),
			undefined,
			undefined,
			expect.objectContaining({
				taskApiConfigName: apiConfig.name,
				taskMode: "architect",
				taskApprovalMode: "auto",
				workspacePath: second.workspace,
				reasoningPreference: queuedReasoningPreference,
			}),
		)
		expect(run.reasoningPreference).toEqual(queuedReasoningPreference)
	})
})
