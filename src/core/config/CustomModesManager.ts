import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"

import * as yaml from "yaml"
import stripBom from "strip-bom"
import { z } from "zod"

import { type ModeConfig, type PromptComponent, customModesSettingsSchema, modeConfigSchema } from "@alpha-code/types"

import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspacePath } from "../../utils/path"
import {
	getGlobalConfigDirectory,
	getProjectConfigDirectory,
	getProjectConfigPathForRead,
} from "../../services/config-paths"
import { logger } from "../../utils/logging"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { ensureSettingsDirectoryExists } from "../../utils/globalContext"
import { atomicWriteText, withFileLock } from "../task-persistence/atomicWrite"
import { t } from "../../i18n"

const ALPHAMODES_FILENAME = ".alphamodes"
const MAX_RULE_EXPORT_ENTRIES = 20_000
const MAX_RULE_EXPORT_DEPTH = 32
const MAX_RULE_EXPORT_BYTES = 8 * 1024 * 1024

const hasErrorCode = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === code

// Type definitions for import/export functionality
interface RuleFile {
	relativePath: string
	content: string
}

interface ExportedModeConfig extends ModeConfig {
	rulesFiles?: RuleFile[]
}

const importedModesDocumentSchema = z.object({ customModes: z.array(z.unknown()).min(1) })
const importedModeSchema = modeConfigSchema
	.extend({
		rulesFiles: z.array(z.object({ relativePath: z.string(), content: z.string().optional() })).optional(),
	})
	.passthrough()

const legacyRulesPathPrefix = /^rules-[^/]+\//

function normalizeImportedRulePath(relativePath: string): string {
	const portablePath = relativePath.replace(/\\/g, "/")
	const isExplicitlyRelative = portablePath.startsWith("./")
	const segments = (isExplicitlyRelative ? portablePath.slice(2) : portablePath).split("/")
	if (
		segments.some(
			(segment) =>
				!segment ||
				Buffer.byteLength(segment) > 255 ||
				// eslint-disable-next-line no-control-regex
				/[\x00-\x1f:<>"|?*]/.test(segment) ||
				/[. ]$/.test(segment) ||
				/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment),
		)
	) {
		throw new Error(t("common:customModes.errors.invalidRulePath", { relativePath }))
	}
	const normalized = segments.join("/")
	// Old exports prefixed the rules folder even when the importer changed the mode's slug.
	return isExplicitlyRelative ? normalized : normalized.replace(legacyRulesPathPrefix, "")
}

function prepareImportedRules(rules: readonly { relativePath: string; content?: string }[]): RuleFile[] {
	const files = new Set<string>()
	const directories = new Set<string>()
	return rules.flatMap(({ relativePath, content }) => {
		const normalized = normalizeImportedRulePath(relativePath)
		if (content === undefined) return []
		const key = normalized.toLowerCase()
		if (files.has(key) || directories.has(key)) {
			throw new Error(t("common:customModes.errors.invalidRulePath", { relativePath }))
		}
		for (let parent = path.posix.dirname(key); parent !== "."; parent = path.posix.dirname(parent)) {
			if (files.has(parent)) throw new Error(t("common:customModes.errors.invalidRulePath", { relativePath }))
			directories.add(parent)
		}
		files.add(key)
		return [{ relativePath: normalized, content }]
	})
}

interface ExportResult {
	success: boolean
	yaml?: string
	error?: string
}

interface ImportResult {
	success: boolean
	slug?: string
	error?: string
}

export class CustomModesManager {
	private static readonly cacheTTL = 10_000

	private disposables: vscode.Disposable[] = []
	private writeQueue: Promise<void> = Promise.resolve()
	private settingsFileCreation?: Promise<void>
	private cachedModes: ModeConfig[] | null = null
	private cachedAt: number = 0
	private loadingModes?: Promise<ModeConfig[]>
	private cacheGeneration = 0
	private disposed = false

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		this.watchCustomModesFiles().catch((error) => {
			console.error("[CustomModesManager] Failed to setup file watchers:", error)
		})
	}

	private queueWrite(operation: () => Promise<void>): Promise<void> {
		const result = this.writeQueue.then(operation)
		// Keep the internal tail usable after a failure while returning the
		// operation-specific result to the caller that enqueued it.
		this.writeQueue = result.catch(() => {})
		return result
	}

	private async resolveSettingsFilePath(filePath: string): Promise<string> {
		try {
			return await fs.realpath(filePath)
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				try {
					// A dangling link is existing settings, not permission to create over its alias.
					await fs.lstat(filePath)
				} catch (metadataError) {
					if (hasErrorCode(metadataError, "ENOENT")) {
						try {
							return path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath))
						} catch {
							// A missing or unreadable parent cannot establish a safe write identity.
						}
					}
				}
			}
			throw new Error(t("common:customModes.errors.settingsResolveFailed", { path: filePath }))
		}
	}

	private async withSettingsFileWrite(filePath: string, operation: (resolvedPath: string) => Promise<void>) {
		const resolvedPath = await this.resolveSettingsFilePath(filePath)
		// The canonical file lease is shared by sidebar/editor managers and other extension windows.
		await withFileLock(resolvedPath, async () => {
			if ((await this.resolveSettingsFilePath(filePath)) !== resolvedPath) {
				throw new Error(t("common:customModes.errors.settingsConflict", { path: filePath }))
			}
			await operation(resolvedPath)
		})
	}

	private async getWorkspaceAlphaModes(): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders

		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined
		}

		const workspaceRoot = getWorkspacePath()
		const alphaModesPath = path.join(workspaceRoot, ALPHAMODES_FILENAME)
		const exists = await fileExistsAtPath(alphaModesPath)
		return exists ? alphaModesPath : undefined
	}

	/**
	 * Regex pattern for problematic characters that need to be cleaned from YAML content
	 * Includes:
	 * - \u00A0: Non-breaking space
	 * - \u200B-\u200D: Zero-width spaces and joiners
	 * - \u2010-\u2015, \u2212: Various dash characters
	 * - \u2018-\u2019: Smart single quotes
	 * - \u201C-\u201D: Smart double quotes
	 */
	private static readonly PROBLEMATIC_CHARS_REGEX =
		// eslint-disable-next-line no-misleading-character-class
		/[\u00A0\u200B\u200C\u200D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2018\u2019\u201C\u201D]/g

	/**
	 * Clean invisible and problematic characters from YAML content
	 */
	private cleanInvisibleCharacters(content: string): string {
		// Single pass replacement for all problematic characters
		return content.replace(CustomModesManager.PROBLEMATIC_CHARS_REGEX, (match) => {
			switch (match) {
				case "\u00A0": // Non-breaking space
					return " "
				case "\u200B": // Zero-width space
				case "\u200C": // Zero-width non-joiner
				case "\u200D": // Zero-width joiner
					return ""
				case "\u2018": // Left single quotation mark
				case "\u2019": // Right single quotation mark
					return "'"
				case "\u201C": // Left double quotation mark
				case "\u201D": // Right double quotation mark
					return '"'
				default: // Dash characters (U+2010 through U+2015, U+2212)
					return "-"
			}
		})
	}

	/**
	 * Parse YAML content with enhanced error handling and preprocessing
	 */
	private parseYamlSafely(content: string, filePath: string, requireValid = false): any {
		// Clean the content
		let cleanedContent = stripBom(content)
		cleanedContent = this.cleanInvisibleCharacters(cleanedContent)

		try {
			const parsed = yaml.parse(cleanedContent)
			// Display reads stay tolerant; mutations must validate the original document shape.
			return requireValid ? parsed : (parsed ?? {})
		} catch (yamlError) {
			// For .alphamodes files, try JSON as fallback
			if (filePath.endsWith(ALPHAMODES_FILENAME)) {
				try {
					// Try parsing the original content as JSON (not the cleaned content)
					return JSON.parse(content)
				} catch (jsonError) {
					if (requireValid)
						throw new Error(t("common:customModes.errors.settingsParseFailed", { path: filePath }))
					// JSON also failed, show the original YAML error
					const errorMsg = yamlError instanceof Error ? yamlError.message : String(yamlError)
					console.error(`[CustomModesManager] Failed to parse YAML from ${filePath}:`, errorMsg)

					const lineMatch = errorMsg.match(/at line (\d+)/)
					const line = lineMatch ? lineMatch[1] : "unknown"
					vscode.window.showErrorMessage(t("common:customModes.errors.yamlParseError", { line }))

					// Return empty object to prevent duplicate error handling
					return {}
				}
			}
			if (requireValid) throw new Error(t("common:customModes.errors.settingsParseFailed", { path: filePath }))

			// For non-.alphamodes files, just log and return empty object
			const errorMsg = yamlError instanceof Error ? yamlError.message : String(yamlError)
			console.error(`[CustomModesManager] Failed to parse YAML from ${filePath}:`, errorMsg)
			return {}
		}
	}

	private async loadModesFromFile(filePath: string): Promise<ModeConfig[]> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			const settings = this.parseYamlSafely(content, filePath)

			// Ensure settings has customModes property
			if (!settings || typeof settings !== "object" || !settings.customModes) {
				return []
			}

			const result = customModesSettingsSchema.safeParse(settings)

			if (!result.success) {
				console.error(`[CustomModesManager] Schema validation failed for ${filePath}:`, result.error)

				// Show user-friendly error for .alphamodes files
				if (filePath.endsWith(ALPHAMODES_FILENAME)) {
					const issues = result.error.issues
						.map((issue) => `• ${issue.path.join(".")}: ${issue.message}`)
						.join("\n")

					vscode.window.showErrorMessage(t("common:customModes.errors.schemaValidationError", { issues }))
				}

				return []
			}

			// Determine source based on file path
			const isAlphaModes = filePath.endsWith(ALPHAMODES_FILENAME)
			const source = isAlphaModes ? ("project" as const) : ("global" as const)

			// Add source to each mode
			return result.data.customModes.map((mode) => ({ ...mode, source }))
		} catch (error) {
			// Only log if the error wasn't already handled in parseYamlSafely
			if (!(error as any).alreadyHandled) {
				const errorMsg = `Failed to load modes from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
				console.error(`[CustomModesManager] ${errorMsg}`)
			}
			return []
		}
	}

	private async mergeCustomModes(projectModes: ModeConfig[], globalModes: ModeConfig[]): Promise<ModeConfig[]> {
		const slugs = new Set<string>()
		const merged: ModeConfig[] = []

		// Add project mode (takes precedence)
		for (const mode of projectModes) {
			if (!slugs.has(mode.slug)) {
				slugs.add(mode.slug)
				merged.push({ ...mode, source: "project" })
			}
		}

		// Add non-duplicate global modes
		for (const mode of globalModes) {
			if (!slugs.has(mode.slug)) {
				slugs.add(mode.slug)
				merged.push({ ...mode, source: "global" })
			}
		}

		return merged
	}

	public async getCustomModesFilePath(): Promise<string> {
		const settingsDir = await ensureSettingsDirectoryExists(this.context)
		const filePath = path.join(settingsDir, GlobalFileNames.customModes)
		const fileExists = await fileExistsAtPath(filePath)

		if (!fileExists) {
			const creation =
				this.settingsFileCreation ??
				fs
					.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }), { flag: "wx" })
					.catch((error) => {
						if (!hasErrorCode(error, "EEXIST")) throw error
					})
			this.settingsFileCreation = creation
			try {
				await creation
			} finally {
				if (this.settingsFileCreation === creation) this.settingsFileCreation = undefined
			}
		}

		return filePath
	}

	private async watchCustomModesFiles(): Promise<void> {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		const settingsPath = await this.getCustomModesFilePath()
		if (this.disposed) return

		// Watch settings file
		const settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPath)

		const handleSettingsChange = async () => {
			try {
				// Ensure that the settings file exists (especially important for delete events)
				await this.getCustomModesFilePath()
				const content = await fs.readFile(settingsPath, "utf-8")

				const errorMessage = t("common:customModes.errors.invalidFormat")

				let config: any

				try {
					config = this.parseYamlSafely(content, settingsPath)
				} catch (error) {
					console.error(error)
					vscode.window.showErrorMessage(errorMessage)
					return
				}

				const result = customModesSettingsSchema.safeParse(config)

				if (!result.success) {
					vscode.window.showErrorMessage(errorMessage)
					return
				}

				// Get modes from .alphamodes if it exists (takes precedence)
				const alphaModesPath = await this.getWorkspaceAlphaModes()
				const workspaceFileModes = alphaModesPath ? await this.loadModesFromFile(alphaModesPath) : []

				// Merge modes from both sources (.alphamodes takes precedence)
				const mergedModes = await this.mergeCustomModes(workspaceFileModes, result.data.customModes)
				await this.context.globalState.update("customModes", mergedModes)
				this.clearCache()
				await this.onUpdate()
			} catch (error) {
				console.error(`[CustomModesManager] Error handling settings file change:`, error)
			}
		}

		this.disposables.push(settingsWatcher.onDidChange(handleSettingsChange))
		this.disposables.push(settingsWatcher.onDidCreate(handleSettingsChange))
		this.disposables.push(settingsWatcher.onDidDelete(handleSettingsChange))
		this.disposables.push(settingsWatcher)

		// Watch .alphamodes file - watch the path even if it doesn't exist yet
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (workspaceFolders && workspaceFolders.length > 0) {
			const workspaceRoot = getWorkspacePath()
			const alphaModesPath = path.join(workspaceRoot, ALPHAMODES_FILENAME)
			const alphaModesWatcher = vscode.workspace.createFileSystemWatcher(alphaModesPath)

			const handleAlphaModesChange = async () => {
				try {
					const settingsModes = await this.loadModesFromFile(settingsPath)
					const workspaceFileModes = await this.loadModesFromFile(alphaModesPath)
					// .alphamodes takes precedence
					const mergedModes = await this.mergeCustomModes(workspaceFileModes, settingsModes)
					await this.context.globalState.update("customModes", mergedModes)
					this.clearCache()
					await this.onUpdate()
				} catch (error) {
					console.error(`[CustomModesManager] Error handling .alphamodes file change:`, error)
				}
			}

			this.disposables.push(alphaModesWatcher.onDidChange(handleAlphaModesChange))
			this.disposables.push(alphaModesWatcher.onDidCreate(handleAlphaModesChange))
			this.disposables.push(
				alphaModesWatcher.onDidDelete(async () => {
					// When .alphamodes is deleted, refresh with only settings modes
					try {
						const settingsModes = await this.loadModesFromFile(settingsPath)
						await this.context.globalState.update("customModes", settingsModes)
						this.clearCache()
						await this.onUpdate()
					} catch (error) {
						console.error(`[CustomModesManager] Error handling .alphamodes file deletion:`, error)
					}
				}),
			)
			this.disposables.push(alphaModesWatcher)
		}
	}

	public async getCustomModes(): Promise<ModeConfig[]> {
		// Check if we have a valid cached result.
		const now = Date.now()

		if (this.cachedModes && now - this.cachedAt < CustomModesManager.cacheTTL) {
			return this.cachedModes
		}
		if (this.loadingModes) return this.loadingModes

		const loading = this.loadCustomModes(this.cacheGeneration)
		this.loadingModes = loading
		try {
			return await loading
		} finally {
			if (this.loadingModes === loading) this.loadingModes = undefined
		}
	}

	private async loadCustomModes(generation: number): Promise<ModeConfig[]> {
		// Get modes from settings file.
		const settingsPath = await this.getCustomModesFilePath()
		const settingsModes = await this.loadModesFromFile(settingsPath)

		// Get modes from .alphamodes if it exists.
		const alphaModesPath = await this.getWorkspaceAlphaModes()
		const workspaceFileModes = alphaModesPath ? await this.loadModesFromFile(alphaModesPath) : []

		// Create maps to store modes by source.
		const projectModes = new Map<string, ModeConfig>()
		const globalModes = new Map<string, ModeConfig>()

		// Add project modes (they take precedence).
		for (const mode of workspaceFileModes) {
			projectModes.set(mode.slug, { ...mode, source: "project" as const })
		}

		// Add global modes.
		for (const mode of settingsModes) {
			if (!projectModes.has(mode.slug)) {
				globalModes.set(mode.slug, { ...mode, source: "global" as const })
			}
		}

		// Combine modes in the correct order: project modes first, then global modes.
		const mergedModes = [
			...workspaceFileModes.map((mode) => ({ ...mode, source: "project" as const })),
			...settingsModes
				.filter((mode) => !projectModes.has(mode.slug))
				.map((mode) => ({ ...mode, source: "global" as const })),
		]

		// A reset or file change can invalidate a load while its I/O is pending.
		if (generation !== this.cacheGeneration) return this.getCustomModes()
		await this.context.globalState.update("customModes", mergedModes)
		if (generation !== this.cacheGeneration) return this.getCustomModes()

		this.cachedModes = mergedModes
		this.cachedAt = Date.now()

		return mergedModes
	}

	public async updateCustomMode(slug: string, config: ModeConfig): Promise<void> {
		try {
			// Validate the mode configuration before saving
			const validationResult = modeConfigSchema.safeParse(config)
			if (!validationResult.success) {
				const errorMessages = validationResult.error.issues
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join(", ")
				const errorMessage = `Invalid mode configuration: ${errorMessages}`
				logger.error("Mode validation failed", { slug, errors: validationResult.error.issues })
				vscode.window.showErrorMessage(t("common:customModes.errors.updateFailed", { error: errorMessage }))
				throw new Error(errorMessage)
			}

			const isProjectMode = config.source === "project"
			let targetPath: string

			if (isProjectMode) {
				const workspaceFolders = vscode.workspace.workspaceFolders

				if (!workspaceFolders || workspaceFolders.length === 0) {
					logger.error("Failed to update project mode: No workspace folder found", { slug })
					throw new Error(t("common:customModes.errors.noWorkspaceForProject"))
				}

				const workspaceRoot = getWorkspacePath()
				targetPath = path.join(workspaceRoot, ALPHAMODES_FILENAME)
				const exists = await fileExistsAtPath(targetPath)

				logger.info(`${exists ? "Updating" : "Creating"} project mode in ${ALPHAMODES_FILENAME}`, {
					slug,
					workspace: workspaceRoot,
				})
			} else {
				targetPath = await this.getCustomModesFilePath()
			}

			await this.queueWrite(async () => {
				// Ensure source is set correctly based on target file.
				const modeWithSource = {
					...config,
					source: isProjectMode ? ("project" as const) : ("global" as const),
				}

				await this.updateModesInFile(targetPath, (modes) => {
					const updatedModes = modes.filter((m) => m.slug !== slug)
					updatedModes.push(modeWithSource)
					return updatedModes
				})

				this.clearCache()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update custom mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(t("common:customModes.errors.updateFailed", { error: errorMessage }))
			throw error
		}
	}

	private async updateModesInFile(filePath: string, operation: (modes: ModeConfig[]) => ModeConfig[]): Promise<void> {
		await this.withSettingsFileWrite(filePath, async (resolvedPath) => {
			let content = ""
			try {
				content = await fs.readFile(resolvedPath, "utf-8")
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) {
					throw new Error(t("common:customModes.errors.settingsReadFailed", { path: filePath }))
				}
			}
			const settings = content.trim() ? this.parseYamlSafely(content, filePath, true) : {}
			if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
				throw new Error(t("common:customModes.errors.settingsInvalid", { path: filePath }))
			}
			const modes = settings.customModes === undefined ? [] : settings.customModes
			if (!Array.isArray(modes) || !customModesSettingsSchema.safeParse({ customModes: modes }).success) {
				throw new Error(t("common:customModes.errors.settingsInvalid", { path: filePath }))
			}
			// Validate without replacing the original objects, preserving unknown saved fields.
			settings.customModes = operation(modes)
			await atomicWriteText(resolvedPath, yaml.stringify(settings, { lineWidth: 0 }), {
				requireAtomicReplace: true,
			})
		})
	}

	private async refreshMergedState(): Promise<void> {
		const settingsPath = await this.getCustomModesFilePath()
		const alphaModesPath = await this.getWorkspaceAlphaModes()

		const settingsModes = await this.loadModesFromFile(settingsPath)
		const workspaceFileModes = alphaModesPath ? await this.loadModesFromFile(alphaModesPath) : []
		const mergedModes = await this.mergeCustomModes(workspaceFileModes, settingsModes)

		await this.context.globalState.update("customModes", mergedModes)

		this.clearCache()

		await this.onUpdate()
	}

	public async deleteCustomMode(slug: string): Promise<void> {
		try {
			const settingsPath = await this.getCustomModesFilePath()
			const alphaModesPath = await this.getWorkspaceAlphaModes()

			const settingsModes = await this.loadModesFromFile(settingsPath)
			const workspaceFileModes = alphaModesPath ? await this.loadModesFromFile(alphaModesPath) : []

			// Find the mode in either file
			const projectMode = workspaceFileModes.find((m) => m.slug === slug)
			const globalMode = settingsModes.find((m) => m.slug === slug)

			if (!projectMode && !globalMode) {
				throw new Error(t("common:customModes.errors.modeNotFound"))
			}

			// Determine which mode to use for rules folder path calculation
			const modeToDelete = projectMode || globalMode

			await this.queueWrite(async () => {
				// Delete from project first if it exists there
				if (projectMode && alphaModesPath) {
					await this.updateModesInFile(alphaModesPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete from global settings if it exists there
				if (globalMode) {
					await this.updateModesInFile(settingsPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete associated rules folder
				if (modeToDelete) {
					await this.deleteRulesFolder(slug, modeToDelete)
				}

				// Clear cache when modes are deleted
				this.clearCache()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(t("common:customModes.errors.deleteFailed", { error: errorMessage }))
		}
	}

	/**
	 * Deletes the rules folder for a specific mode
	 * @param slug - The mode slug
	 * @param mode - The mode configuration to determine the scope
	 */
	private async deleteRulesFolder(slug: string, mode: ModeConfig): Promise<void> {
		try {
			// Determine the scope based on source (project or global)
			const scope = mode.source || "global"

			// Determine the rules folder path
			let rulesFolderPaths: string[]
			if (scope === "project") {
				const workspacePath = getWorkspacePath()
				if (workspacePath) {
					rulesFolderPaths = [path.join(getProjectConfigDirectory(workspacePath), `rules-${slug}`)]
				} else {
					return // No workspace, can't delete project rules
				}
			} else {
				rulesFolderPaths = [path.join(getGlobalConfigDirectory(), `rules-${slug}`)]
			}

			// Check if the rules folder exists and delete it
			for (const rulesFolderPath of rulesFolderPaths) {
				if (!(await fileExistsAtPath(rulesFolderPath))) continue
				try {
					await fs.rm(rulesFolderPath, { recursive: true, force: true })
					logger.info(`Deleted rules folder for mode ${slug}: ${rulesFolderPath}`)
				} catch (error) {
					logger.error(`Failed to delete rules folder for mode ${slug}: ${error}`)
					// Notify the user about the failure
					vscode.window.showWarningMessage(
						t("common:customModes.errors.rulesCleanupFailed", { rulesFolderPath }),
					)
					// Continue even if folder deletion fails
				}
			}
		} catch (error) {
			logger.error(`Error deleting rules folder for mode ${slug}`, {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	public async resetCustomModes(): Promise<void> {
		try {
			const filePath = await this.getCustomModesFilePath()
			await this.queueWrite(async () => {
				await this.withSettingsFileWrite(filePath, (resolvedPath) =>
					atomicWriteText(resolvedPath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }), {
						requireAtomicReplace: true,
					}),
				)
				await this.context.globalState.update("customModes", [])
				this.clearCache()
				await this.onUpdate()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(t("common:customModes.errors.resetFailed", { error: errorMessage }))
		}
	}

	/**
	 * Checks if a mode has associated rules files in the .alpha/rules-{slug}/ directory
	 * @param slug - The mode identifier to check
	 * @returns True if the mode has rules files with content, false otherwise
	 */
	public async checkRulesDirectoryHasContent(slug: string): Promise<boolean> {
		try {
			// First, find the mode to determine its source
			const allModes = await this.getCustomModes()
			const mode = allModes.find((m) => m.slug === slug)

			if (!mode) {
				// If not in custom modes, check if it's in .alphamodes (project-specific)
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return false
				}

				const alphaModesPath = path.join(workspacePath, ALPHAMODES_FILENAME)
				try {
					const alphaModesExists = await fileExistsAtPath(alphaModesPath)
					if (alphaModesExists) {
						const alphaModesContent = await fs.readFile(alphaModesPath, "utf-8")
						const alphaModesData = yaml.parse(alphaModesContent)
						const workspaceFileModes = alphaModesData?.customModes || []

						// Check if this specific mode exists in .alphamodes
						const modeInAlphaModes = workspaceFileModes.find((m: any) => m.slug === slug)
						if (!modeInAlphaModes) {
							return false // Mode not found anywhere
						}
					} else {
						return false // No .alphamodes file and not in custom modes
					}
				} catch (error) {
					return false // Cannot read .alphamodes and not in custom modes
				}
			}

			// Determine the correct rules directory based on mode source
			let modeRulesDir: string
			const isGlobalMode = mode?.source === "global"

			if (isGlobalMode) {
				// For global modes, check in global .alpha directory
				const globalConfigDir = getGlobalConfigDirectory()
				modeRulesDir = path.join(globalConfigDir, `rules-${slug}`)
			} else {
				// Project mode rules use the canonical Alpha directory.
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return false
				}
				modeRulesDir = await getProjectConfigPathForRead(workspacePath, `rules-${slug}`)
			}

			try {
				const stats = await fs.stat(modeRulesDir)
				if (!stats.isDirectory()) {
					return false
				}
			} catch (error) {
				return false
			}

			// Check if directory has any content files
			try {
				const entries = await fs.readdir(modeRulesDir, { withFileTypes: true })

				for (const entry of entries) {
					if (entry.isFile()) {
						// Use path.join with modeRulesDir and entry.name for compatibility
						const filePath = path.join(modeRulesDir, entry.name)
						const content = await fs.readFile(filePath, "utf-8")
						if (content.trim()) {
							return true // Found at least one file with content
						}
					}
				}

				return false // No files with content found
			} catch (error) {
				return false
			}
		} catch (error) {
			logger.error("Failed to check rules directory for mode", {
				slug,
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	/**
	 * Exports a mode configuration with its associated rules files into a shareable YAML format
	 * @param slug - The mode identifier to export
	 * @param customPrompts - Optional custom prompts to merge into the export
	 * @returns Success status with YAML content or error message
	 */
	public async exportModeWithRules(slug: string, customPrompts?: PromptComponent): Promise<ExportResult> {
		try {
			if (!modeConfigSchema.shape.slug.safeParse(slug).success) return { success: false, error: "Mode not found" }
			// Import modes from shared to check built-in modes
			const { modes: builtInModes } = await import("../../shared/modes")

			// Get all current modes
			const allModes = await this.getCustomModes()
			let mode = allModes.find((m) => m.slug === slug)

			// If mode not found in custom modes, check if it's a built-in mode that has been customized
			if (!mode) {
				// Only check workspace-based modes if workspace is available
				const workspacePath = getWorkspacePath()
				if (workspacePath) {
					const alphaModesPath = path.join(workspacePath, ALPHAMODES_FILENAME)
					try {
						const alphaModesExists = await fileExistsAtPath(alphaModesPath)
						if (alphaModesExists) {
							const alphaModesContent = await fs.readFile(alphaModesPath, "utf-8")
							const alphaModesData = yaml.parse(alphaModesContent)
							const workspaceFileModes = alphaModesData?.customModes || []

							// Find the mode in .alphamodes
							mode = workspaceFileModes.find((m: any) => m.slug === slug)
						}
					} catch (error) {
						// Continue to check built-in modes
					}
				}

				// If still not found, check if it's a built-in mode
				if (!mode) {
					const builtInMode = builtInModes.find((m) => m.slug === slug)
					if (builtInMode) {
						// Use the built-in mode as the base
						mode = { ...builtInMode }
					} else {
						return { success: false, error: "Mode not found" }
					}
				}
			}

			// Determine the base directory based on mode source
			const isGlobalMode = mode.source === "global"
			let baseDir: string
			if (isGlobalMode) {
				// For global modes, use the global .alpha directory
				baseDir = getGlobalConfigDirectory()
			} else {
				// For project modes, use the workspace directory
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return { success: false, error: "No workspace found" }
				}
				baseDir = workspacePath
			}

			// Check for .alpha/rules-{slug}/ directory (or rules-{slug}/ for global)
			const modeRulesDir = isGlobalMode
				? path.join(baseDir, `rules-${slug}`)
				: await getProjectConfigPathForRead(baseDir, `rules-${slug}`)

			const rulesFiles = await this.exportRulesFiles(modeRulesDir)

			// Create an export mode with rules files preserved
			const exportMode: ExportedModeConfig = {
				...mode,
				// Remove source property for export
				source: "project" as const,
			}

			// Merge custom prompts if provided
			if (customPrompts) {
				if (customPrompts.roleDefinition) exportMode.roleDefinition = customPrompts.roleDefinition
				if (customPrompts.description) exportMode.description = customPrompts.description
				if (customPrompts.whenToUse) exportMode.whenToUse = customPrompts.whenToUse
				if (customPrompts.customInstructions) exportMode.customInstructions = customPrompts.customInstructions
			}

			// Add rules files if any exist
			if (rulesFiles.length > 0) {
				exportMode.rulesFiles = rulesFiles
			}

			// Generate YAML
			const exportData = {
				customModes: [exportMode],
			}

			const yamlContent = yaml.stringify(exportData)

			return { success: true, yaml: yamlContent }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to export mode with rules", { slug, error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	private async exportRulesFiles(rulesDirectory: string): Promise<RuleFile[]> {
		try {
			if (!(await fs.stat(rulesDirectory)).isDirectory()) return []
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return []
			throw error
		}
		const canonicalParent = await fs.realpath(path.dirname(rulesDirectory))
		const canonicalDirectory = path.join(canonicalParent, path.basename(rulesDirectory))
		const ensureUnlinked = async (filePath: string) => {
			if (path.relative(filePath, await fs.realpath(filePath))) {
				throw new Error(t("common:customModes.errors.linkedRulePath", { path: filePath }))
			}
		}
		const limitExceeded = () => new Error(t("common:customModes.errors.ruleExportLimit"))
		const rulesFiles: RuleFile[] = []
		let scanned = 0
		let bytes = 0
		const walk = async (directory: string, segments: string[]): Promise<void> => {
			if (segments.length > MAX_RULE_EXPORT_DEPTH) throw limitExceeded()
			await ensureUnlinked(directory)
			for await (const entry of await fs.opendir(directory)) {
				if (++scanned > MAX_RULE_EXPORT_ENTRIES) throw limitExceeded()
				const filePath = path.join(directory, entry.name)
				const entrySegments = [...segments, entry.name]
				if (entry.isFile()) {
					await ensureUnlinked(filePath)
					if (bytes + (await fs.stat(filePath)).size > MAX_RULE_EXPORT_BYTES) throw limitExceeded()
					const content = await fs.readFile(filePath, "utf-8")
					bytes += Buffer.byteLength(content)
					if (bytes > MAX_RULE_EXPORT_BYTES) throw limitExceeded()
					const relativePath = entrySegments.join("/")
					if (relativePath.includes("\\")) {
						throw new Error(t("common:customModes.errors.invalidRulePath", { relativePath }))
					}
					// Distinguish a real nested rules-* folder from the legacy export prefix.
					const portablePath = legacyRulesPathPrefix.test(relativePath) ? "./" + relativePath : relativePath
					rulesFiles.push({ relativePath: portablePath, content })
				} else if (entry.isDirectory()) {
					await walk(filePath, entrySegments)
				}
			}
		}
		await walk(canonicalDirectory, [])
		// A successful export must also pass the importer's path and collision checks.
		prepareImportedRules(rulesFiles)
		return rulesFiles
	}

	private async importRulesFiles(rulesFolderPath: string, rulesFiles: readonly RuleFile[]): Promise<void> {
		await fs.rm(rulesFolderPath, { recursive: true, force: true })
		for (const ruleFile of rulesFiles) {
			const targetPath = path.join(rulesFolderPath, ruleFile.relativePath)
			await fs.mkdir(path.dirname(targetPath), { recursive: true })
			await fs.writeFile(targetPath, ruleFile.content, "utf-8")
		}
	}

	/**
	 * Imports modes from YAML content, including their associated rules files
	 * @param yamlContent - The YAML content containing mode configurations
	 * @param source - Target level for import: "global" (all projects) or "project" (current workspace only)
	 * @returns Success status with optional error message
	 */
	public async importModeWithRules(
		yamlContent: string,
		source: "global" | "project" = "project",
	): Promise<ImportResult> {
		try {
			let parsed: unknown
			try {
				parsed = yaml.parse(yamlContent)
			} catch (error) {
				return {
					success: false,
					error: `Invalid YAML format: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
			const document = importedModesDocumentSchema.safeParse(parsed)
			if (!document.success) {
				return { success: false, error: "Invalid import format: Expected 'customModes' array in YAML" }
			}

			const workspacePath = source === "project" ? getWorkspacePath() : undefined
			if (source === "project" && !workspacePath) return { success: false, error: "No workspace found" }
			const baseDir = workspacePath ? getProjectConfigDirectory(workspacePath) : getGlobalConfigDirectory()
			const importedSlugs = new Set<string>()
			const preparedModes: { mode: ModeConfig; rulesFiles: RuleFile[] }[] = []
			// Reject malformed entries anywhere in the document before replacing any saved modes or rules.
			for (const rawMode of document.data.customModes) {
				const validation = importedModeSchema.safeParse(rawMode)
				if (!validation.success) {
					const issues = validation.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`)
					return { success: false, error: `Invalid mode configuration: ${issues.join(", ")}` }
				}
				const { rulesFiles, ...modeConfig } = validation.data
				const slug = modeConfig.slug.toLowerCase()
				if (importedSlugs.has(slug)) {
					return {
						success: false,
						error: t("common:customModes.errors.duplicateImportMode", { slug: modeConfig.slug }),
					}
				}
				importedSlugs.add(slug)
				preparedModes.push({
					mode: { ...modeConfig, source },
					rulesFiles: prepareImportedRules(rulesFiles ?? []),
				})
			}

			for (const { mode, rulesFiles } of preparedModes) {
				await this.updateCustomMode(mode.slug, mode)
				await this.importRulesFiles(path.join(baseDir, `rules-${mode.slug}`), rulesFiles)
			}
			await this.refreshMergedState()
			return { success: true, slug: preparedModes[0]?.mode.slug }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to import mode with rules", { error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	private clearCache(): void {
		this.cachedModes = null
		this.cachedAt = 0
		this.cacheGeneration++
		this.loadingModes = undefined
	}

	dispose(): void {
		this.disposed = true
		for (const disposable of this.disposables) {
			disposable.dispose()
		}

		this.disposables = []
	}
}
