import { safeWriteJson } from "../../utils/safeWriteJson"
import os from "os"
import * as path from "path"
import fs from "fs/promises"
import { randomUUID } from "node:crypto"

import * as vscode from "vscode"
import { z, ZodError } from "zod"

import {
	globalSettingsSchema,
	providerSettingsWithIdSchema,
	persistedProviderSettingsWithIdSchema,
	isProviderName,
	isRetiredProvider,
	type ProviderSettingsWithId,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import {
	ProviderSettingsManager,
	persistedProviderProfilesSchema,
	readPersistedProviderProfiles,
	createImportedProfileIdRemapper,
	type ProviderProfiles,
} from "./ProviderSettingsManager"
import { ContextProxy } from "./ContextProxy"
import { CustomModesManager } from "./CustomModesManager"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { t } from "../../i18n"

export type ImportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
	customModesManager: CustomModesManager
}

type ExportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
}
type ImportWithProviderOptions = ImportOptions & {
	provider: {
		settingsImportedAt?: number
		postStateToWebview: () => Promise<void>
	}
}

/** Preserve unsupported provider IDs so imports remain recoverable. */
function sanitizeProviderConfig(configName: string, apiConfig: unknown): { config: unknown; warning?: string } {
	if (typeof apiConfig !== "object" || apiConfig === null) {
		return { config: apiConfig }
	}

	const config = apiConfig as Record<string, unknown>
	const isUnsupportedProvider =
		typeof config.apiProvider === "string" &&
		!isProviderName(config.apiProvider) &&
		!isRetiredProvider(config.apiProvider) &&
		config.apiProvider !== "fake-ai"

	if (isUnsupportedProvider) {
		return {
			config: apiConfig,
			warning: `Profile "${configName}": Unsupported provider "${config.apiProvider}" was retained. Reconfigure this profile before use.`,
		}
	}

	return { config: apiConfig }
}

/**
 * Imports configuration from a specific file path
 * Shares base functionality for import settings for both the manual
 * and automatic settings importing.
 *
 * Uses lenient parsing to handle invalid/removed providers gracefully:
 * - Unsupported apiProvider values are retained (profile is kept but needs reconfiguration)
 * - Schema-invalid profiles are retained outside executable settings
 * - Warnings are returned for any issues encountered
 */
export async function importSettingsFromPath(
	filePath: string,
	{ providerSettingsManager, contextProxy, customModesManager }: ImportOptions,
) {
	const lenientSchema = z.object({
		providerProfiles: persistedProviderProfilesSchema,
		globalSettings: globalSettingsSchema.optional(),
	})

	try {
		const rawData = JSON.parse(await fs.readFile(filePath, "utf-8"))
		const { providerProfiles: rawProfiles, globalSettings = {} } = lenientSchema.parse(rawData)
		const { profiles: rawProviderProfiles } = readPersistedProviderProfiles(rawProfiles, randomUUID)

		// Track warnings for profiles that had issues
		const warnings: string[] = []
		const validApiConfigs: Record<string, ProviderSettingsWithId> = {}
		for (const configName of Object.keys(rawProviderProfiles.retainedApiConfigs ?? {})) {
			warnings.push(
				`Profile "${configName}" has invalid saved settings and was retained for repair. It cannot be used until repaired.`,
			)
		}

		// Process each apiConfig individually with sanitization
		for (const [configName, rawConfig] of Object.entries(rawProviderProfiles.apiConfigs)) {
			// First sanitize to handle invalid apiProvider values
			const { config: sanitizedConfig, warning } = sanitizeProviderConfig(configName, rawConfig)
			if (warning) {
				warnings.push(warning)
			}

			// Then validate the sanitized config
			const providerValue =
				typeof sanitizedConfig === "object" && sanitizedConfig !== null && "apiProvider" in sanitizedConfig
					? (sanitizedConfig as Record<string, unknown>).apiProvider
					: undefined
			const isUnsupportedProvider =
				typeof providerValue === "string" &&
				!isProviderName(providerValue) &&
				!isRetiredProvider(providerValue) &&
				providerValue !== "fake-ai"
			const schema = isUnsupportedProvider
				? persistedProviderSettingsWithIdSchema
				: typeof providerValue === "string" && isRetiredProvider(providerValue)
					? providerSettingsWithIdSchema.passthrough()
					: providerSettingsWithIdSchema
			const result = schema.safeParse(sanitizedConfig)
			if (result.success) {
				// The persisted reader intentionally accepts retired/unknown provider IDs;
				// runtime validation reports those IDs before a handler is built.
				Object.defineProperty(validApiConfigs, configName, {
					value: result.data as ProviderSettingsWithId,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			} else {
				// The persisted reader already separated malformed settings. Keep a
				// future stricter import adapter from silently discarding that data.
				throw new Error(
					`Profile "${configName}" could not be imported. Its saved configuration was not changed.`,
				)
			}
		}

		// Merge only imported entries with current saved state inside the manager's write lock.
		// An export snapshot here would overwrite saves, renames, or deletions made during file I/O.
		const providerProfiles: ProviderProfiles = {
			...rawProviderProfiles,
			apiConfigs: validApiConfigs,
		}
		// A retained import shadows a same-named older executable profile until
		// the user explicitly repairs it; it must never inherit those old settings.
		for (const name of Object.keys(rawProviderProfiles.retainedApiConfigs ?? {}))
			delete providerProfiles.apiConfigs[name]

		// OpenAI Compatible settings are now correctly stored in codebaseIndexConfig
		// They will be imported automatically with the config - no special handling needed

		const referencedIds = [
			globalSettings.enhancementApiConfigId,
			globalSettings.subagentDefaultApiConfigId,
			...Object.values(globalSettings.subagentApiConfigByRole ?? {}),
		].filter((id): id is string => typeof id === "string")
		const importedProfiles = referencedIds.length
			? await providerSettingsManager.import(providerProfiles, { referencedIds })
			: await providerSettingsManager.import(providerProfiles)
		const finalProfiles = importedProfiles ?? providerProfiles
		const remapId = createImportedProfileIdRemapper(providerProfiles, finalProfiles)
		const finalSettings = { ...globalSettings }
		if (finalSettings.enhancementApiConfigId !== undefined)
			finalSettings.enhancementApiConfigId = remapId(finalSettings.enhancementApiConfigId)
		if (finalSettings.subagentDefaultApiConfigId !== undefined)
			finalSettings.subagentDefaultApiConfigId = remapId(finalSettings.subagentDefaultApiConfigId)
		if (finalSettings.subagentApiConfigByRole)
			finalSettings.subagentApiConfigByRole = Object.fromEntries(
				Object.entries(finalSettings.subagentApiConfigByRole).flatMap(([role, id]) =>
					typeof id === "string" ? [[role, remapId(id)]] : [],
				),
			)
		// Reject invalid profile selections and references before any custom-mode file can be changed.
		for (const mode of globalSettings.customModes ?? []) {
			await customModesManager.updateCustomMode(mode.slug, mode)
		}
		await contextProxy.setValues(finalSettings)

		// Set the current provider.
		const currentProviderName = finalProfiles.currentApiConfigName
		const currentProvider = Object.hasOwn(finalProfiles.apiConfigs, currentProviderName)
			? finalProfiles.apiConfigs[currentProviderName]
			: undefined
		await contextProxy.setValue("currentApiConfigName", currentProviderName)

		// TODO: It seems like we don't need to have the provider settings in
		// the proxy; we can just use providerSettingsManager as the source of
		// truth.
		const supportedCurrentProvider =
			currentProvider?.apiProvider === undefined ||
			isProviderName(currentProvider.apiProvider) ||
			currentProvider.apiProvider === "fake-ai"
		if (currentProvider && supportedCurrentProvider) {
			await contextProxy.setProviderSettings(currentProvider)
		}

		await contextProxy.setValue("listApiConfigMeta", await providerSettingsManager.listConfig())

		return {
			providerProfiles: finalProfiles,
			globalSettings: finalSettings,
			success: true,
			warnings: warnings.length > 0 ? warnings : undefined,
		}
	} catch (e) {
		let error = "Unknown error"

		if (e instanceof ZodError) {
			error = e.issues.map((issue) => `[${issue.path.join(".")}]: ${issue.message}`).join("\n")
			TelemetryService.instance.captureSchemaValidationError({ schemaName: "ImportExport", error: e })
		} else if (e instanceof SyntaxError) {
			error = "Settings file is not valid JSON. Existing settings were not changed."
		} else if (e instanceof Error) {
			error = e.message
		}

		return { success: false, error }
	}
}

/**
 * Import settings from a file using a file dialog
 * @param options - Import options containing managers and proxy
 * @returns Promise resolving to import result
 */
export const importSettings = async ({ providerSettingsManager, contextProxy, customModesManager }: ImportOptions) => {
	// Use the last export path as a sensible default, falling back to Downloads
	const defaultUri = resolveDefaultSaveUri(contextProxy, "lastSettingsExportPath", "alpha-code-settings.json", {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uris = await vscode.window.showOpenDialog({
		filters: { JSON: ["json"] },
		canSelectMany: false,
		defaultUri,
	})

	if (!uris) {
		return { success: false, error: "User cancelled file selection" }
	}

	return importSettingsFromPath(uris[0].fsPath, {
		providerSettingsManager,
		contextProxy,
		customModesManager,
	})
}

/**
 * Import settings from a specific file
 * @param options - Import options containing managers and proxy
 * @param fileUri - URI of the file to import from
 * @returns Promise resolving to import result
 */
export const importSettingsFromFile = async (
	{ providerSettingsManager, contextProxy, customModesManager }: ImportOptions,
	fileUri: vscode.Uri,
) => {
	return importSettingsFromPath(fileUri.fsPath, {
		providerSettingsManager,
		contextProxy,
		customModesManager,
	})
}

export const exportSettings = async ({ providerSettingsManager, contextProxy }: ExportOptions) => {
	const defaultUri = await resolveDefaultSaveUri(contextProxy, "lastSettingsExportPath", "alpha-code-settings.json", {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uri = await vscode.window.showSaveDialog({
		filters: { JSON: ["json"] },
		defaultUri,
	})

	if (!uri) {
		return
	}

	await saveLastExportPath(contextProxy, "lastSettingsExportPath", uri)

	try {
		const providerProfiles = await providerSettingsManager.export()
		const globalSettings = await contextProxy.export()

		// It's okay if there are no global settings, but if there are no
		// provider profile configured then don't export. If we wanted to
		// support this case then the `importSettings` function would need to
		// be updated to handle the case where there are no provider profiles.
		if (typeof providerProfiles === "undefined") {
			return
		}

		// OpenAI Compatible settings are now correctly stored in codebaseIndexConfig
		// No workaround needed - they will be exported automatically with the config

		const dirname = path.dirname(uri.fsPath)
		await fs.mkdir(dirname, { recursive: true })
		await safeWriteJson(uri.fsPath, { providerProfiles, globalSettings })
	} catch (e) {
		console.error("Failed to export settings:", e)
		// Don't re-throw - the UI will handle showing error messages
	}
}

/**
 * Import settings with complete UI feedback and provider state updates
 * @param options - Import options with provider instance
 * @param filePath - Optional file path to import from. If not provided, a file dialog will be shown.
 * @returns Promise that resolves when import is complete
 */
export const importSettingsWithFeedback = async (
	{ providerSettingsManager, contextProxy, customModesManager, provider }: ImportWithProviderOptions,
	filePath?: string,
) => {
	let result

	if (filePath) {
		// Validate file path and check if file exists
		try {
			// Check if file exists and is readable
			await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK)
			result = await importSettingsFromPath(filePath, {
				providerSettingsManager,
				contextProxy,
				customModesManager,
			})
		} catch (error) {
			result = {
				success: false,
				error: `Cannot access file at path "${filePath}": ${error instanceof Error ? error.message : "Unknown error"}`,
			}
		}
	} else {
		result = await importSettings({ providerSettingsManager, contextProxy, customModesManager })
	}

	if (result.success) {
		provider.settingsImportedAt = Date.now()
		await provider.postStateToWebview()

		// Show warnings if any profiles had issues but were still imported (with modifications)
		if (result.warnings && result.warnings.length > 0) {
			// Log full details to the console for debugging
			console.warn("Settings import completed with warnings:", result.warnings)

			// Show a short summary in the toast notification
			const count = result.warnings.length
			const summary =
				count === 1 ? `1 profile had issues during import.` : `${count} profiles had issues during import.`
			await vscode.window.showWarningMessage(
				`${t("common:info.settings_imported")} ${summary} See Developer Tools console for details.`,
			)
		} else {
			await vscode.window.showInformationMessage(t("common:info.settings_imported"))
		}
	} else if (result.error) {
		await vscode.window.showErrorMessage(t("common:errors.settings_import_failed", { error: result.error }))
	}
}
