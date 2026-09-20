import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type * as vscode from "vscode"
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

	function makeProvider() {
		return Object.assign(new EventEmitter(), {
			cwd: path.join(tmpDir, "coding-workspace"),
			currentApiConfigName: "Coding",
			createTask: vi.fn(async (..._args: Parameters<AlphaProvider["createTask"]>) => ({
				taskId: "alpha-task",
				prepareReasoningForAdmission: vi.fn(async () => undefined),
				start: vi.fn(),
				abortTask: vi.fn(async () => undefined),
			})),
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-profiles-"))
		provider = makeProvider()
		service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: tmpDir } } as vscode.ExtensionContext,
			provider as unknown as AlphaProvider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		await service.initialize()
	})

	afterEach(async () => {
		service.dispose()
		onRun = undefined
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true })
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
				taskApiConfigName: apiConfig.name,
				apiConfiguration: { apiProvider: "openai", openAiModelId: "internal-model" },
			}),
			expect.not.objectContaining({ currentApiConfigName: expect.anything() }),
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
			expect.objectContaining({ reasoningPreference, startTask: false }),
			expect.anything(),
		)
		expect(run).toMatchObject({ reasoningPreference, reasoningState })
		const createdTask = (await provider.createTask.mock.results[0]?.value) as {
			prepareReasoningForAdmission: ReturnType<typeof vi.fn>
			start: ReturnType<typeof vi.fn>
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

	it.each(["missing", "renamed", "unloadable"])("fails closed for a %s profile", async (failure) => {
		if (failure === "renamed")
			provider.providerSettingsManager.getProfile.mockResolvedValue({ ...profile, name: "Renamed" })
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
			onRun = resolve
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
				workspacePath: second.workspace,
				reasoningPreference: queuedReasoningPreference,
			}),
			expect.anything(),
		)
		expect(run.reasoningPreference).toEqual(queuedReasoningPreference)
	})
})
