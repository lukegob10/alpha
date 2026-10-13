import { ExtensionContext } from "vscode"
import { z, ZodError } from "zod"

import {
	type ProviderSettingsWithId,
	providerSettingsWithIdSchema,
	discriminatedProviderSettingsWithIdSchema,
	ProviderSettingsEntry,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	getModelId,
	type ProviderName,
	persistedProviderSettingsWithIdSchema,
	isProviderName,
	isRetiredProvider,
	type ProviderProfileRenameErrorCode,
	type ProviderProfileSaveResult,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Mode, modes } from "../../shared/modes"
import { buildApiHandler } from "../../api"

// Type-safe model migrations mapping
type ModelMigrations = {
	[K in ProviderName]?: Record<string, string>
}

const MODEL_MIGRATIONS: ModelMigrations = {} as const satisfies ModelMigrations

export const providerProfilesSchema = z.object({
	currentApiConfigName: z.string(),
	apiConfigs: z.record(z.string(), providerSettingsWithIdSchema),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),

	migrations: z
		.object({
			rateLimitSecondsMigrated: z.boolean().optional(),
			openAiHeadersMigrated: z.boolean().optional(),
			consecutiveMistakeLimitMigrated: z.boolean().optional(),
			todoListEnabledMigrated: z.boolean().optional(),
			claudeCodeLegacySettingsMigrated: z.boolean().optional(),
		})
		.optional(),
})

export type ProviderProfiles = z.infer<typeof providerProfilesSchema>

export class ProviderProfileRenameError extends Error {
	constructor(
		public readonly code: ProviderProfileRenameErrorCode,
		public readonly profile?: { id: string; name: string },
	) {
		super("Failed to rename provider profile")
		this.name = "ProviderProfileRenameError"
	}
}

export class ProviderProfileSaveError extends Error {
	constructor(public readonly code: Extract<ProviderProfileSaveResult, { status: "error" }>["error"]) {
		super("Failed to save provider profile")
		this.name = "ProviderProfileSaveError"
	}
}

export type ProviderProfileSaved = Pick<ProviderSettingsEntry, "id" | "name">

export interface ProviderProfileRename {
	id: string
	oldName: string
	newName: string
	isActive: boolean
	entries: ProviderSettingsEntry[]
}

export class ProviderSettingsManager {
	// Keep the existing SecretStorage namespace so a source rename cannot orphan saved profiles.
	private static readonly SCOPE_PREFIX = "roo_cline_config_"
	private static readonly storageLocks = new WeakMap<ExtensionContext["secrets"], Promise<void>>()
	private readonly defaultConfigId = this.generateId()

	private readonly defaultModeApiConfigs: Record<string, string> = Object.fromEntries(
		modes.map((mode) => [mode.slug, this.defaultConfigId]),
	)

	private readonly defaultProviderProfiles: ProviderProfiles = {
		currentApiConfigName: "default",
		apiConfigs: { default: { id: this.defaultConfigId } },
		modeApiConfigs: this.defaultModeApiConfigs,
		migrations: {
			rateLimitSecondsMigrated: true, // Mark as migrated on fresh installs
			openAiHeadersMigrated: true, // Mark as migrated on fresh installs
			consecutiveMistakeLimitMigrated: true, // Mark as migrated on fresh installs
			todoListEnabledMigrated: true, // Mark as migrated on fresh installs
			claudeCodeLegacySettingsMigrated: true, // Mark as migrated on fresh installs
		},
	}

	private readonly context: ExtensionContext

	constructor(context: ExtensionContext) {
		this.context = context

		// TODO: We really shouldn't have async methods in the constructor.
		this.initialize().catch(console.error)
	}

	public generateId() {
		return Math.random().toString(36).substring(2, 15)
	}

	// Sidebar and editor views share SecretStorage; serialize their read-modify-write operations together.
	private lock<T>(cb: () => Promise<T>) {
		const previous = ProviderSettingsManager.storageLocks.get(this.context.secrets) ?? Promise.resolve()
		const next = previous.then(cb)
		ProviderSettingsManager.storageLocks.set(
			this.context.secrets,
			next.then(
				() => undefined,
				() => undefined,
			),
		)
		return next
	}

	/**
	 * Initialize config if it doesn't exist and run migrations.
	 */
	public async initialize() {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				if (!providerProfiles) {
					await this.store(this.defaultProviderProfiles)
					return
				}

				let isDirty = false

				// Migrate existing installs to have per-mode API config map
				if (!providerProfiles.modeApiConfigs) {
					// Use the currently selected config for all modes initially
					const currentName = providerProfiles.currentApiConfigName
					const seedId =
						providerProfiles.apiConfigs[currentName]?.id ??
						Object.values(providerProfiles.apiConfigs)[0]?.id ??
						this.defaultConfigId
					providerProfiles.modeApiConfigs = Object.fromEntries(modes.map((m) => [m.slug, seedId]))
					isDirty = true
				}

				// Apply model migrations for all providers
				if (this.applyModelMigrations(providerProfiles)) {
					isDirty = true
				}

				// Ensure all configs have IDs.
				for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
					if (!apiConfig.id) {
						apiConfig.id = this.generateId()
						isDirty = true
					}
				}

				// Ensure migrations field exists
				if (!providerProfiles.migrations) {
					providerProfiles.migrations = {
						rateLimitSecondsMigrated: false,
						openAiHeadersMigrated: false,
						consecutiveMistakeLimitMigrated: false,
						todoListEnabledMigrated: false,
						claudeCodeLegacySettingsMigrated: false,
					} // Initialize with default values
					isDirty = true
				}

				if (!providerProfiles.migrations.rateLimitSecondsMigrated) {
					await this.migrateRateLimitSeconds(providerProfiles)
					providerProfiles.migrations.rateLimitSecondsMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.openAiHeadersMigrated) {
					await this.migrateOpenAiHeaders(providerProfiles)
					providerProfiles.migrations.openAiHeadersMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.consecutiveMistakeLimitMigrated) {
					await this.migrateConsecutiveMistakeLimit(providerProfiles)
					providerProfiles.migrations.consecutiveMistakeLimitMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.todoListEnabledMigrated) {
					await this.migrateTodoListEnabled(providerProfiles)
					providerProfiles.migrations.todoListEnabledMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.claudeCodeLegacySettingsMigrated) {
					// These keys were used by the removed local Claude Code CLI wrapper.
					for (const apiConfig of Object.values(providerProfiles.apiConfigs)) {
						// Cast to string for comparison since "claude-code" is no longer a valid ProviderName
						if ((apiConfig.apiProvider as string) !== "claude-code") continue

						const config = apiConfig as unknown as Record<string, unknown>
						if ("claudeCodePath" in config) {
							delete config.claudeCodePath
							isDirty = true
						}
						if ("claudeCodeMaxOutputTokens" in config) {
							delete config.claudeCodeMaxOutputTokens
							isDirty = true
						}
					}

					providerProfiles.migrations.claudeCodeLegacySettingsMigrated = true
					isDirty = true
				}

				if (isDirty) {
					await this.store(providerProfiles)
				}
			})
		} catch (error) {
			throw new Error(`Failed to initialize config: ${error}`)
		}
	}

	private async migrateRateLimitSeconds(providerProfiles: ProviderProfiles) {
		try {
			let rateLimitSeconds: number | undefined

			try {
				rateLimitSeconds = await this.context.globalState.get<number>("rateLimitSeconds")
			} catch (error) {
				console.error("[MigrateRateLimitSeconds] Error getting global rate limit:", error)
			}

			if (rateLimitSeconds === undefined) {
				// Failed to get the existing value, use the default.
				rateLimitSeconds = 0
			}

			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.rateLimitSeconds === undefined) {
					apiConfig.rateLimitSeconds = rateLimitSeconds
				}
			}
		} catch (error) {
			console.error(`[MigrateRateLimitSeconds] Failed to migrate rate limit settings:`, error)
		}
	}

	private async migrateOpenAiHeaders(providerProfiles: ProviderProfiles) {
		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				// Use type assertion to access the deprecated property safely
				const configAny = apiConfig as any

				// Check if openAiHostHeader exists but openAiHeaders doesn't
				if (
					configAny.openAiHostHeader &&
					(!apiConfig.openAiHeaders || Object.keys(apiConfig.openAiHeaders || {}).length === 0)
				) {
					// Create the headers object with the Host value
					apiConfig.openAiHeaders = { Host: configAny.openAiHostHeader }

					// Delete the old property to prevent re-migration
					// This prevents the header from reappearing after deletion
					configAny.openAiHostHeader = undefined
				}
			}
		} catch (error) {
			console.error(`[MigrateOpenAiHeaders] Failed to migrate OpenAI headers:`, error)
		}
	}

	private async migrateConsecutiveMistakeLimit(providerProfiles: ProviderProfiles) {
		try {
			for (const [name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.consecutiveMistakeLimit == null) {
					apiConfig.consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
				}
			}
		} catch (error) {
			console.error(`[MigrateConsecutiveMistakeLimit] Failed to migrate consecutive mistake limit:`, error)
		}
	}

	private async migrateTodoListEnabled(providerProfiles: ProviderProfiles) {
		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.todoListEnabled === undefined) {
					apiConfig.todoListEnabled = true
				}
			}
		} catch (error) {
			console.error(`[MigrateTodoListEnabled] Failed to migrate todo list enabled setting:`, error)
		}
	}

	/**
	 * Apply model migrations for all providers
	 * Returns true if any migrations were applied
	 */
	private applyModelMigrations(providerProfiles: ProviderProfiles): boolean {
		let migrated = false

		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				// Skip configs without provider or model ID
				if (!apiConfig.apiProvider || !apiConfig.apiModelId) {
					continue
				}

				// Check if this provider has migrations (with type safety)
				const provider = apiConfig.apiProvider as ProviderName
				const providerMigrations = MODEL_MIGRATIONS[provider]
				if (!providerMigrations) {
					continue
				}

				// Check if the current model ID needs migration
				const newModelId = providerMigrations[apiConfig.apiModelId]
				if (newModelId && newModelId !== apiConfig.apiModelId) {
					console.log(
						`[ModelMigration] Migrating ${apiConfig.apiProvider} model from ${apiConfig.apiModelId} to ${newModelId}`,
					)
					apiConfig.apiModelId = newModelId
					migrated = true
				}
			}
		} catch (error) {
			console.error(`[ModelMigration] Failed to apply model migrations:`, error)
		}

		return migrated
	}

	/**
	 * Clean model ID by removing prefix before "/"
	 */
	private cleanModelId(modelId: string | undefined): string | undefined {
		if (!modelId) return undefined

		// Check for "/" and take the part after it
		if (modelId.includes("/")) {
			return modelId.split("/").pop()
		}

		return modelId
	}

	/**
	 * List all available configs with metadata.
	 */
	public async listConfig(): Promise<ProviderSettingsEntry[]> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				return this.profileEntries(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to list configs: ${error}`)
		}
	}

	private profileEntries(providerProfiles: ProviderProfiles): ProviderSettingsEntry[] {
		return Object.entries(providerProfiles.apiConfigs).map(([name, apiConfig]) => ({
			name,
			id: apiConfig.id || "",
			apiProvider: apiConfig.apiProvider,
			modelId: this.cleanModelId(getModelId(apiConfig)),
		}))
	}

	/** Rename only persisted identity metadata; provider settings never come from the UI edit buffer. */
	public async renameProfile(
		params: { id: string } | { name: string },
		newName: string,
		options: { expectedName?: string } = {},
	): Promise<ProviderProfileRename> {
		try {
			return await this.lock(async () => {
				const name = newName.trim()
				if (!name) throw new ProviderProfileRenameError("invalid")
				const providerProfiles = await this.load()
				const entries = Object.entries(providerProfiles.apiConfigs)
				const entry = entries.find(([existingName, config]) =>
					"id" in params ? config.id === params.id : existingName === params.name,
				)
				if (!entry) throw new ProviderProfileRenameError("notFound")
				const [oldName, config] = entry
				const id = config.id
				if (!id) throw new ProviderProfileRenameError("notFound")
				if (options.expectedName !== undefined && oldName !== options.expectedName) {
					throw new ProviderProfileRenameError("invalid")
				}
				if (
					entries.some(
						([existingName]) =>
							existingName !== oldName && existingName.toLowerCase() === name.toLowerCase(),
					)
				) {
					throw new ProviderProfileRenameError("nameInUse")
				}
				const isActive = providerProfiles.currentApiConfigName === oldName
				const renamed = {
					...providerProfiles,
					currentApiConfigName: isActive ? name : providerProfiles.currentApiConfigName,
					// Object.fromEntries retains arbitrary display names such as __proto__ as own data keys.
					apiConfigs: Object.fromEntries(
						entries.map(([key, value]) => [key === oldName ? name : key, value]),
					),
				}
				if (name !== oldName) {
					try {
						await this.store(renamed)
					} catch {
						throw new ProviderProfileRenameError("saveFailed", { id, name: oldName })
					}
				}
				return { id, oldName, newName: name, isActive, entries: this.profileEntries(renamed) }
			})
		} catch (error) {
			if (error instanceof ProviderProfileRenameError) throw error
			throw new ProviderProfileRenameError("saveFailed")
		}
	}

	/**
	 * Existing-profile saves resolve their current name and preserve their ID inside the write lock.
	 * Name-based creation and legacy callers retain their existing ID-import semantics.
	 */
	public saveConfig(target: { id: string }, config: ProviderSettingsWithId): Promise<ProviderProfileSaved>
	public saveConfig(name: string, config: ProviderSettingsWithId): Promise<string>
	public async saveConfig(
		target: string | { id: string },
		config: ProviderSettingsWithId,
	): Promise<string | ProviderProfileSaved> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				let name: string
				let id: string
				if (typeof target === "string") {
					name = target
					const existingId = Object.hasOwn(providerProfiles.apiConfigs, name)
						? providerProfiles.apiConfigs[name]?.id
						: undefined
					id = config.id || existingId || this.generateId()
				} else {
					const entry = Object.entries(providerProfiles.apiConfigs).find(
						([, saved]) => saved.id === target.id,
					)
					if (!entry) throw new ProviderProfileSaveError("notFound")
					name = entry[0]
					id = target.id
					// Validate the original container; object spread would turn malformed wire values into empty profiles.
					z.record(z.unknown()).parse(config)
				}
				// A draft's embedded ID cannot change the authority of an explicit existing-profile target.
				const configToSave = typeof target === "string" ? config : { ...config, id }

				// For active providers, filter out settings from other providers.
				// For retired providers, preserve full profile fields (including legacy
				// provider-specific keys) to avoid data loss — passthrough() keeps
				// unknown keys that strict parse() would strip.
				const providerValue = configToSave.apiProvider
				const isUnsupportedProvider =
					typeof providerValue === "string" &&
					!isProviderName(providerValue) &&
					!isRetiredProvider(providerValue) &&
					providerValue !== "fake-ai"
				const filteredConfig = isUnsupportedProvider
					? persistedProviderSettingsWithIdSchema.parse(configToSave)
					: typeof providerValue === "string" && isRetiredProvider(providerValue)
						? providerSettingsWithIdSchema.passthrough().parse(configToSave)
						: discriminatedProviderSettingsWithIdSchema.parse(configToSave)
				const updated = {
					...providerProfiles,
					apiConfigs: {
						...providerProfiles.apiConfigs,
						[name]: { ...filteredConfig, id } as ProviderSettingsWithId,
					},
				}
				await this.store(updated)
				return typeof target === "string" ? id : { id, name }
			})
		} catch (error) {
			if (typeof target !== "string") {
				if (error instanceof ProviderProfileSaveError) throw error
				throw new ProviderProfileSaveError(error instanceof ZodError ? "invalid" : "saveFailed")
			}
			throw new Error(`Failed to save config: ${error}`)
		}
	}

	public async getProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				let name: string
				let providerSettings: ProviderSettingsWithId

				if ("name" in params) {
					name = params.name

					if (!Object.hasOwn(providerProfiles.apiConfigs, name)) {
						throw new Error(`Config with name '${name}' not found`)
					}

					providerSettings = providerProfiles.apiConfigs[name]
				} else {
					const id = params.id

					const entry = Object.entries(providerProfiles.apiConfigs).find(
						([_, apiConfig]) => apiConfig.id === id,
					)

					if (!entry) {
						throw new Error(`Config with ID '${id}' not found`)
					}

					name = entry[0]
					providerSettings = entry[1]
				}

				return { name, ...providerSettings }
			})
		} catch (error) {
			throw new Error(`Failed to get profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Activate a profile by name or ID.
	 */
	public async activateProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		const { name, ...providerSettings } = await this.getProfile(params)

		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				providerProfiles.currentApiConfigName = name
				await this.store(providerProfiles)
				return { name, ...providerSettings }
			})
		} catch (error) {
			throw new Error(`Failed to activate profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Delete a config by name.
	 */
	public async deleteConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				if (!Object.hasOwn(providerProfiles.apiConfigs, name)) {
					throw new Error(`Config '${name}' not found`)
				}

				if (Object.keys(providerProfiles.apiConfigs).length === 1) {
					throw new Error(`Cannot delete the last remaining configuration`)
				}

				delete providerProfiles.apiConfigs[name]
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to delete config: ${error}`)
		}
	}

	/**
	 * Check if a config exists by name.
	 */
	public async hasConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				return Object.hasOwn(providerProfiles.apiConfigs, name)
			})
		} catch (error) {
			throw new Error(`Failed to check config existence: ${error}`)
		}
	}

	/**
	 * Set the API config for a specific mode.
	 */
	public async setModeConfig(mode: Mode, configId: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Ensure the per-mode config map exists
				if (!providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = {}
				}
				// Assign the chosen config ID to this mode
				providerProfiles.modeApiConfigs[mode] = configId
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to set mode config: ${error}`)
		}
	}

	/**
	 * Get the API config ID for a specific mode.
	 */
	public async getModeConfigId(mode: Mode) {
		try {
			return await this.lock(async () => {
				const { modeApiConfigs } = await this.load()
				return modeApiConfigs?.[mode]
			})
		} catch (error) {
			throw new Error(`Failed to get mode config: ${error}`)
		}
	}

	public async export() {
		try {
			return await this.lock(async () => {
				const profiles = await this.load()
				const configs = profiles.apiConfigs
				for (const name in configs) {
					const apiProvider = configs[name].apiProvider

					if (
						typeof apiProvider === "string" &&
						(!isProviderName(apiProvider) || isRetiredProvider(apiProvider))
					) {
						// Preserve retired-provider profiles as-is to prevent dropping legacy fields.
						continue
					}

					// Avoid leaking properties from other active providers.
					configs[name] = discriminatedProviderSettingsWithIdSchema.parse(configs[name])

					// If it has no apiProvider, skip filtering
					if (!configs[name].apiProvider) {
						continue
					}

					// Try to build an API handler to get model information
					try {
						const apiHandler = buildApiHandler(configs[name])
						const modelInfo = apiHandler.getModel().info

						// Check if the model supports reasoning budgets
						const supportsReasoningBudget =
							modelInfo.supportsReasoningBudget || modelInfo.requiredReasoningBudget

						// If the model doesn't support reasoning budgets, remove the token fields
						if (!supportsReasoningBudget) {
							delete configs[name].modelMaxTokens
							delete configs[name].modelMaxThinkingTokens
						}
					} catch (error) {
						// If we can't build the API handler or get model info, skip filtering
						// to avoid accidental data loss from incomplete configurations
						console.warn(`Skipping token field filtering for config '${name}': ${error}`)
					}
				}
				return profiles
			})
		} catch (error) {
			throw new Error(`Failed to export provider profiles: ${error}`)
		}
	}

	public async import(providerProfiles: ProviderProfiles) {
		try {
			return await this.lock(() => this.store(providerProfiles))
		} catch (error) {
			throw new Error(`Failed to import provider profiles: ${error}`)
		}
	}

	/**
	 * Reset provider profiles by deleting them from secrets.
	 */
	public async resetAllConfigs() {
		return await this.lock(async () => {
			await this.context.secrets.delete(this.secretsKey)
		})
	}

	private get secretsKey() {
		return `${ProviderSettingsManager.SCOPE_PREFIX}api_config`
	}

	private async load(): Promise<ProviderProfiles> {
		try {
			const content = await this.context.secrets.get(this.secretsKey)

			if (!content) {
				return this.defaultProviderProfiles
			}

			const providerProfiles = providerProfilesSchema
				.extend({
					// Zod record parsing omits __proto__. Profile display names are data keys, so
					// validate the record shape here and its values below without discarding that name.
					apiConfigs: z.custom<Record<string, unknown>>(
						(value) => typeof value === "object" && value !== null && !Array.isArray(value),
					),
				})
				.parse(JSON.parse(content))

			const apiConfigs = Object.entries(providerProfiles.apiConfigs).reduce(
				(acc, [key, apiConfig]) => {
					// Persisted readers accept unknown provider IDs and retain the full
					// profile so callers can report the exact unsupported identifier.
					const result = persistedProviderSettingsWithIdSchema.safeParse(apiConfig)
					return result.success ? { ...acc, [key]: result.data as ProviderSettingsWithId } : acc
				},
				{} as Record<string, ProviderSettingsWithId>,
			)

			return {
				...providerProfiles,
				apiConfigs: Object.fromEntries(
					Object.entries(apiConfigs).filter(([_, apiConfig]) => apiConfig !== null),
				),
			}
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({
					schemaName: "ProviderProfiles",
					error,
				})
			}

			throw new Error(`Failed to read provider profiles from secrets: ${error}`)
		}
	}

	private async store(providerProfiles: ProviderProfiles) {
		try {
			await this.context.secrets.store(this.secretsKey, JSON.stringify(providerProfiles, null, 2))
		} catch (error) {
			throw new Error(`Failed to write provider profiles to secrets: ${error}`)
		}
	}
}
