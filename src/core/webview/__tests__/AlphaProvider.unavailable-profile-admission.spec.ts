import { afterEach, describe, expect, it, vi } from "vitest"
import type { HistoryItem, ProviderSettingsEntry } from "@alpha-code/types"
import type { ExtensionContext } from "vscode"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"
import { ProviderSettingsManager, ProviderProfileUnavailableError } from "../../config/ProviderSettingsManager"

const { constructTask } = vi.hoisted(() => ({ constructTask: vi.fn() }))

vi.mock("../../task/Task", () => ({
	Task: class {
		constructor(options: unknown) {
			constructTask(options)
			throw new Error("Task constructor admitted")
		}
	},
}))

afterEach(() => constructTask.mockClear())

const admitted = new Error("Reached task replacement after provider admission")

const createProvider = (entries: ProviderSettingsEntry[]) => {
	const removeTaskFromStack = vi.fn(async (): Promise<void> => {
		throw admitted
	})
	const state = { currentApiConfigName: "Broken", apiProvider: "openai", openAiModelId: "previous-provider-settings" }
	const updateGlobalState = vi.fn(async () => undefined)
	const listConfig = vi.fn(async () => entries)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		taskHistoryStoreReady: Promise.resolve(),
		taskCreationQueue: Promise.resolve(),
		taskStack: [],
		taskSessions: new TaskSessionRegistry(),
		taskNavigationGeneration: 0,
		newTaskDraftMode: "code",
		context: { secrets: {}, workspaceState: { get: () => false } },
		contextProxy: {
			getValues: () => ({ ...state }),
			getValue: vi.fn(),
			setValues: vi.fn(async (values: object) => Object.assign(state, values)),
		},
		providerSettingsManager: {
			listConfig,
			getAvailableProfile: vi.fn(async (name: string) => {
				const entry = entries.find((candidate) => candidate.name === name)
				if (entry?.availability)
					throw new ProviderProfileUnavailableError(entry.availability, entry, entry.invalidFields)
				return entry ? { apiProvider: "openai" } : undefined
			}),
			getModeConfigId: vi.fn(async () => "broken-id"),
			getProfile: vi.fn(async () => ({ id: "broken-id", name: "Broken", apiProvider: "openai" })),
		},
		getLiveTask: vi.fn(),
		getTaskOwner: vi.fn(),
		getProviderSettingsSnapshot: () => {
			const { currentApiConfigName: _name, ...settings } = state
			return settings
		},
		removeTaskFromStack,
		updateGlobalState,
		log: vi.fn(),
	})
	return { provider, removeTaskFromStack, updateGlobalState, listConfig }
}

const history = (extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id: "saved-chat",
	ts: 1,
	task: "Retain the saved chat",
	number: 1,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

describe("unavailable provider profile admission", () => {
	it("admits a fresh prompt with one saved-profile read when secret storage is slow", async () => {
		vi.useFakeTimers()
		try {
			const { provider } = createProvider([])
			const content = JSON.stringify({
				currentApiConfigName: "Broken",
				apiConfigs: { Broken: { id: "profile-id", apiProvider: "openai", openAiModelId: "saved-model" } },
				modeApiConfigs: {},
			})
			const secrets = { get: vi.fn(async () => content), store: vi.fn(async () => undefined) }
			const manager = new ProviderSettingsManager({ secrets } as unknown as ExtensionContext)
			await manager.initialize()
			secrets.get.mockClear()
			secrets.get.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(content), 50)))
			Object.assign(provider, { providerSettingsManager: manager })
			const began = Date.now()
			let admissionMs: number | undefined
			const submission = provider.createTask("Inspect the startup path").then(
				() => {
					throw new Error("Expected the task replacement boundary")
				},
				(error: unknown) => {
					expect(error).toBe(admitted)
					admissionMs = Date.now() - began
				},
			)
			await vi.advanceTimersByTimeAsync(100)
			await submission
			expect({ secretReads: secrets.get.mock.calls.length, admissionMs }).toEqual({
				secretReads: 1,
				admissionMs: 50,
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it.each(["invalid", "unsupported"] as const)(
		"rejects a new task using an %s selected profile before replacing existing work",
		async (availability) => {
			const { provider, removeTaskFromStack } = createProvider([
				{ id: "broken-id", name: "Broken", availability, invalidFields: ["modelTemperature"] },
			])

			await expect(provider.createTask("Use the selected profile")).rejects.toMatchObject({
				name: "ProviderProfileUnavailableError",
				code: availability,
			})
			expect(removeTaskFromStack).not.toHaveBeenCalled()
		},
	)

	it.each(["invalid", "unsupported"] as const)(
		"rejects a saved %s profile instead of borrowing current settings",
		async (availability) => {
			const { provider, removeTaskFromStack, updateGlobalState } = createProvider([
				{ id: "broken-id", name: "Broken", availability },
			])

			await expect(
				provider.createTaskWithHistoryItem(history({ apiConfigName: "Broken", mode: "architect" })),
			).rejects.toMatchObject({ name: "ProviderProfileUnavailableError", code: availability })
			expect(removeTaskFromStack).not.toHaveBeenCalled()
			expect(updateGlobalState).not.toHaveBeenCalled()
		},
	)

	it("does not swallow an unavailable mode binding during history restoration", async () => {
		const { provider, removeTaskFromStack } = createProvider([
			{ id: "broken-id", name: "Broken", availability: "invalid" },
		])

		await expect(provider.createTaskWithHistoryItem(history({ mode: "code" }))).rejects.toMatchObject({
			name: "ProviderProfileUnavailableError",
			code: "invalid",
		})
		expect(removeTaskFromStack).not.toHaveBeenCalled()
	})

	it("checks the global profile when history actually falls back to global settings", async () => {
		const { provider, removeTaskFromStack } = createProvider([
			{ id: "broken-id", name: "Broken", availability: "invalid" },
		])

		await expect(provider.createTaskWithHistoryItem(history())).rejects.toMatchObject({
			name: "ProviderProfileUnavailableError",
			code: "invalid",
		})
		expect(removeTaskFromStack).not.toHaveBeenCalled()
	})

	it("does not turn an unavailable mode profile into an absent route", async () => {
		const { provider } = createProvider([{ id: "broken-id", name: "Broken", availability: "invalid" }])
		const modeResolver = provider as unknown as { getModeProviderProfile(mode: string): Promise<unknown> }

		await expect(modeResolver.getModeProviderProfile("code")).rejects.toMatchObject({
			name: "ProviderProfileUnavailableError",
			code: "invalid",
		})
	})

	it("does not replace an unavailable retained child profile with its parent's provider", async () => {
		const { provider } = createProvider([{ id: "broken-id", name: "Broken", availability: "invalid" }])
		const restorer = provider as unknown as {
			restoreCapturedSubagentModelRoute(parent: Task, role: "worker", item: HistoryItem): Promise<unknown>
		}
		const parent = { apiConfiguration: { apiProvider: "openai", openAiModelId: "parent-model" } } as unknown as Task

		await expect(
			restorer.restoreCapturedSubagentModelRoute(
				parent,
				"worker",
				history({
					apiConfigName: "Broken",
					subagentModelRoute: {
						source: "parent",
						resolution: "selected",
						profileName: "Broken",
						provider: "openai",
						modelId: "parent-model",
					},
				}),
			),
		).rejects.toMatchObject({ name: "ProviderProfileUnavailableError", code: "invalid" })
	})

	it("retains explicitly captured valid provider settings independently of a later global profile change", async () => {
		const { provider, removeTaskFromStack } = createProvider([
			{ id: "broken-id", name: "Broken", availability: "invalid" },
		])

		await expect(
			provider.createTask("Captured configuration", undefined, undefined, {
				apiConfiguration: { apiProvider: "openai", openAiModelId: "captured-model" },
				taskApiConfigName: "Captured",
			}),
		).rejects.toBe(admitted)
		expect(removeTaskFromStack).toHaveBeenCalledOnce()
	})

	it("retains legacy context-only settings when no unavailable saved entry exists", async () => {
		const { provider } = createProvider([])
		await expect(provider.createTask("Legacy context-only setup")).rejects.toBe(admitted)
	})

	it("propagates profile-storage failure without replacing the current task", async () => {
		const { provider, removeTaskFromStack } = createProvider([])
		const storageFailure = new Error("Profile storage is unavailable")
		vi.mocked(provider.providerSettingsManager.getAvailableProfile).mockRejectedValueOnce(storageFailure)

		await expect(provider.createTask("Keep the current task safe")).rejects.toBe(storageFailure)
		expect(removeTaskFromStack).not.toHaveBeenCalled()
	})

	it("uses the selected profile instead of stale cached settings left by a failed projection", async () => {
		const { provider, removeTaskFromStack } = createProvider([{ id: "broken-id", name: "Broken" }])
		vi.mocked(provider.providerSettingsManager.getAvailableProfile).mockResolvedValueOnce({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { id: "selected-model" },
		})
		removeTaskFromStack.mockResolvedValueOnce(undefined)

		await expect(provider.createTask("Use the committed selection")).rejects.toThrow("Task constructor admitted")
		expect(constructTask).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: { apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "selected-model" } },
			}),
		)
	})

	it("keeps explicit API provider overrides on top of the selected saved profile", async () => {
		const { provider, removeTaskFromStack } = createProvider([{ id: "broken-id", name: "Broken" }])
		vi.mocked(provider.providerSettingsManager.getAvailableProfile).mockResolvedValueOnce({
			apiProvider: "openai",
			openAiModelId: "saved-model",
			openAiBaseUrl: "https://example.invalid/provider",
		})
		removeTaskFromStack.mockResolvedValueOnce(undefined)

		await expect(
			provider.createTask(
				"Use the requested model",
				undefined,
				undefined,
				{},
				{ openAiModelId: "explicit-model" },
			),
		).rejects.toThrow("Task constructor admitted")
		expect(constructTask).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({
					apiProvider: "openai",
					openAiModelId: "explicit-model",
					openAiBaseUrl: "https://example.invalid/provider",
				}),
			}),
		)
	})
})
