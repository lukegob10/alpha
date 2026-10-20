import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import type { ProviderSettings, ProviderSettingsEntry } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import type { Task } from "../../task/Task"
import i18next from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"

const valid: ProviderSettingsEntry = { id: "active", name: "Active", apiProvider: "openai" }
const invalid: ProviderSettingsEntry = {
	id: "invalid",
	name: "Invalid",
	availability: "invalid",
	invalidFields: ["modelTemperature"],
}
const replacement: ProviderSettingsEntry = { id: "replacement", name: "Replacement", apiProvider: "vertex" }

const createProvider = (entries: ProviderSettingsEntry[], selected = valid.name) => {
	const state = {
		currentApiConfigName: selected,
		listApiConfigMeta: [...entries],
		apiProvider: "openai",
		apiModelId: "model-a",
	}
	const task = { taskId: "task", instanceId: "instance" } as Task
	const activate = vi.fn(async () => undefined)
	const updateTask = vi.fn()
	const sticky = vi.fn(async () => undefined)
	const setProviderSettings = vi.fn(async (settings: ProviderSettings, projection?: Partial<typeof state>) => {
		Object.assign(state, settings, projection)
	})
	const clearReferences = vi.fn(async () => undefined)
	const post = vi.fn(async () => undefined)
	const listConfig = vi.fn(async () => entries)
	const deleteConfig = vi.fn(async (name: string) => {
		const remaining = entries.filter((entry) => entry.name !== name)
		const selectedEntry =
			name === selected
				? (remaining.find((entry) => !entry.availability) ?? remaining[0])
				: remaining.find((entry) => entry.name === selected)!
		return {
			currentApiConfigName: selectedEntry.name,
			entries: remaining,
			selectedProfile: selectedEntry.availability
				? undefined
				: {
						id: selectedEntry.id,
						name: selectedEntry.name,
						apiProvider: selectedEntry.id === replacement.id ? ("vertex" as const) : ("openai" as const),
						apiModelId: selectedEntry.id === replacement.id ? "model-b" : "model-a",
					},
		}
	})
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		context: { secrets: {} },
		contextProxy: {
			getValues: () => state,
			getValue: (key: keyof typeof state) => state[key],
			setValues: vi.fn(async (values: Partial<typeof state>) => Object.assign(state, values)),
			setProviderSettings,
		},
		providerSettingsManager: { listConfig, deleteConfig },
		activateProviderProfileWithinQueue: activate,
		updateTaskApiHandlerIfNeeded: updateTask,
		persistStickyProviderProfileToCurrentTask: sticky,
		clearSubagentProfileReferences: clearReferences,
		getCurrentTask: () => task,
		getLiveTask: () => task,
		getHostProviders: () => [provider],
		postStateToWebview: post,
		log: vi.fn(),
	})
	return {
		provider,
		task,
		state,
		activate,
		updateTask,
		sticky,
		setProviderSettings,
		clearReferences,
		post,
		listConfig,
		deleteConfig,
	}
}

describe("durable saved profile deletion", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		i18next.addResourceBundle("en", "common", common, true, true)
		vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
		vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
	})

	it("durably deletes an inactive retained profile without changing the active provider", async () => {
		const { provider, state, deleteConfig, activate, clearReferences } = createProvider([valid, invalid])
		await provider.deleteProviderProfile(invalid)

		expect(deleteConfig).toHaveBeenCalledExactlyOnceWith("Invalid", { expectedId: "invalid" })
		expect(activate).not.toHaveBeenCalled()
		expect(clearReferences).toHaveBeenCalledExactlyOnceWith("invalid")
		expect(state.currentApiConfigName).toBe("Active")
		expect(state.listApiConfigMeta).toEqual([valid])
	})

	it("projects the executable replacement captured by the delete transaction without another storage activation", async () => {
		const { provider, task, state, deleteConfig, activate, updateTask, sticky } = createProvider([
			valid,
			invalid,
			replacement,
		])
		await provider.deleteProviderProfile(valid)

		expect(deleteConfig).toHaveBeenCalledExactlyOnceWith("Active", { expectedId: "active" })
		expect(activate).not.toHaveBeenCalled()
		expect(updateTask).toHaveBeenCalledExactlyOnceWith(
			{ apiProvider: "vertex", apiModelId: "model-b" },
			{ forceRebuild: true, task },
		)
		expect(sticky).toHaveBeenCalledExactlyOnceWith("Replacement", task)
		expect(state).toMatchObject({
			currentApiConfigName: "Replacement",
			apiProvider: "vertex",
			apiModelId: "model-b",
		})
	})

	it("keeps the explicit unavailable selection and clears stale provider settings if all remaining profiles are invalid", async () => {
		const { provider, state, activate, setProviderSettings, post } = createProvider([valid, invalid])
		await provider.deleteProviderProfile(valid)

		expect(activate).not.toHaveBeenCalled()
		expect(state.currentApiConfigName).toBe("Invalid")
		expect(state.listApiConfigMeta).toEqual([invalid])
		expect(setProviderSettings).toHaveBeenCalledExactlyOnceWith(
			{},
			{ currentApiConfigName: "Invalid", listApiConfigMeta: [invalid] },
		)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("invalid settings"))
		expect(post).toHaveBeenCalledOnce()
	})

	it("rejects stale identity metadata before deleting a newly reused display name", async () => {
		const { provider, deleteConfig, activate } = createProvider([valid, { ...invalid, id: "new-identity" }])
		await expect(provider.deleteProviderProfile(invalid)).rejects.toThrow(/changed|exist|identity/i)

		expect(deleteConfig).not.toHaveBeenCalled()
		expect(activate).not.toHaveBeenCalled()
	})

	it("keeps the last-profile precondition ahead of every durable or projection change", async () => {
		const { provider, deleteConfig, activate, setProviderSettings } = createProvider([valid])
		await expect(provider.deleteProviderProfile(valid)).rejects.toThrow(/last profile/i)

		expect(deleteConfig).not.toHaveBeenCalled()
		expect(activate).not.toHaveBeenCalled()
		expect(setProviderSettings).not.toHaveBeenCalled()
	})

	it("does not retarget replacement activation to an unrelated task selected during the delete", async () => {
		const { provider, deleteConfig, updateTask, sticky } = createProvider([valid, replacement])
		deleteConfig.mockImplementationOnce(async () => {
			const next = { taskId: "new-task", instanceId: "new-instance" } as Task
			Object.assign(provider, { getCurrentTask: () => next, getLiveTask: () => next })
			return {
				currentApiConfigName: replacement.name,
				entries: [replacement],
				selectedProfile: {
					name: replacement.name,
					id: replacement.id,
					apiProvider: "vertex" as const,
					apiModelId: "model-b",
				},
			}
		})
		await provider.deleteProviderProfile(valid)

		expect(updateTask).not.toHaveBeenCalled()
		expect(sticky).toHaveBeenCalledExactlyOnceWith("Replacement", undefined)
	})

	it("reports a post-delete task projection failure without leaving valid B selected with cached A", async () => {
		const { provider, state, updateTask, post } = createProvider([valid, replacement])
		updateTask.mockImplementationOnce(() => {
			throw new Error("private endpoint and key")
		})
		await expect(provider.deleteProviderProfile(valid)).resolves.toBeUndefined()

		expect(state.listApiConfigMeta).toEqual([replacement])
		expect(state.currentApiConfigName).toBe("Replacement")
		expect(state.apiProvider).toBe("vertex")
		expect(state.apiModelId).toBe("model-b")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to load"))
		expect(post).toHaveBeenCalledOnce()
		expect(JSON.stringify(vi.mocked(provider.log).mock.calls)).not.toContain("private endpoint and key")
	})

	it("preserves the paired B cache after projection persistence fails and surfaces the loading failure", async () => {
		const { provider, state, setProviderSettings, updateTask, deleteConfig, post } = createProvider([
			valid,
			replacement,
		])
		setProviderSettings.mockImplementationOnce(async (settings, projection) => {
			Object.assign(state, settings, projection)
			throw new Error("storage write rejected")
		})
		await expect(provider.deleteProviderProfile(valid)).resolves.toBeUndefined()

		expect(deleteConfig).toHaveBeenCalledOnce()
		expect(state).toMatchObject({
			currentApiConfigName: "Replacement",
			apiProvider: "vertex",
			apiModelId: "model-b",
		})
		expect(updateTask).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to load"))
		expect(post).toHaveBeenCalledOnce()
	})

	it("does not project replacement B if the durable deletion fails", async () => {
		const { provider, state, deleteConfig, setProviderSettings, updateTask, post } = createProvider([
			valid,
			replacement,
		])
		deleteConfig.mockRejectedValueOnce(new Error("durable delete failed"))
		await expect(provider.deleteProviderProfile(valid)).rejects.toThrow("durable delete failed")

		expect(state).toMatchObject({ currentApiConfigName: "Active", apiProvider: "openai", apiModelId: "model-a" })
		expect(setProviderSettings).not.toHaveBeenCalled()
		expect(updateTask).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalled()
	})
})
