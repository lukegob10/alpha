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
	PROVIDER_SETTINGS_KEYS,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Mode, modes } from "../../shared/modes"
import { buildApiHandler } from "../../api"
import { ProviderProfileUnavailableError } from "./ProviderProfileUnavailableError"
export { ProviderProfileUnavailableError } from "./ProviderProfileUnavailableError"

// Type-safe model migrations mapping
type ModelMigrations = {
	[K in ProviderName]?: Record<string, string>
}

const MODEL_MIGRATIONS: ModelMigrations = {} as const satisfies ModelMigrations

const retainedProviderConfigSchema = z.object({ id: z.string().min(1), value: z.unknown() })
export type RetainedProviderConfig = { id: string; value: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// Profile display names are data keys, including __proto__, which z.record omits.
const retainedApiConfigsSchema = z.custom<Record<string, RetainedProviderConfig>>(
	(value) =>
		isRecord(value) &&
		Object.values(value).every(
			(entry) =>
				isRecord(entry) &&
				Object.hasOwn(entry, "value") &&
				entry.value !== undefined &&
				retainedProviderConfigSchema.safeParse(entry).success,
		),
)

export const providerProfilesSchema = z.object({
	currentApiConfigName: z.string(),
	apiConfigs: z.record(z.string(), providerSettingsWithIdSchema),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	retainedApiConfigs: retainedApiConfigsSchema.optional(),

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

function profileIdentities(profiles: ProviderProfiles): [string, string][] {
	return [
		...Object.entries(profiles.apiConfigs).flatMap(([name, value]): [string, string][] =>
			value.id && !Object.hasOwn(profiles.retainedApiConfigs ?? {}, name) ? [[name, value.id]] : [],
		),
		...Object.entries(profiles.retainedApiConfigs ?? {}).map(([name, value]): [string, string] => [name, value.id]),
	]
}

/** Preserve reference identity after an explicit same-name import repairs saved settings. */
export function createImportedProfileIdRemapper(
	source: ProviderProfiles,
	destination: ProviderProfiles,
): (id: string) => string {
	const finalIds = new Map(profileIdentities(destination))
	const sourceIds = new Map<string, { target: string; count: number }>()
	for (const [name, id] of profileIdentities(source)) {
		const previous = sourceIds.get(id)
		sourceIds.set(id, { target: finalIds.get(name) ?? id, count: (previous?.count ?? 0) + 1 })
	}
	return (id) => {
		const entry = sourceIds.get(id)
		if (entry && entry.count > 1) {
			throw new ProviderProfileUnavailableError("invalid", { id, name: "Ambiguous imported profile identity" }, [
				"id",
			])
		}
		return entry?.target ?? id
	}
}

export const persistedProviderProfilesSchema = providerProfilesSchema.extend({
	apiConfigs: z.custom<Record<string, unknown>>(isRecord),
})

const knownProfileFields = new Set<string>([...PROVIDER_SETTINGS_KEYS, "id"])

export function getInvalidProviderFields(value: unknown): string[] {
	const parsed = persistedProviderSettingsWithIdSchema.safeParse(value)
	if (parsed.success) return []
	return [
		...new Set(
			parsed.error.issues.map(({ path }) => {
				const key = String(path[0] ?? "configuration")
				return knownProfileFields.has(key) ? key : "configuration"
			}),
		),
	].slice(0, 10)
}

/** Separate durable opaque data from settings that passed the persisted reader. */
export function readPersistedProviderProfiles(
	value: unknown,
	generateId: () => string,
): {
	profiles: ProviderProfiles
	needsPersistence: boolean
} {
	const raw = persistedProviderProfilesSchema.parse(value)
	const retained = { ...raw.retainedApiConfigs }
	const configs: [string, ProviderSettingsWithId][] = []
	let needsPersistence = false
	const ids = new Set([
		...Object.values(retained).map(({ id }) => id),
		...Object.values(raw.apiConfigs).flatMap((config) =>
			isRecord(config) && typeof config.id === "string" ? [config.id] : [],
		),
	])
	for (const [name, config] of Object.entries(raw.apiConfigs)) {
		const migratedConfig =
			!raw.migrations?.consecutiveMistakeLimitMigrated &&
			isRecord(config) &&
			config.consecutiveMistakeLimit === null
				? { ...config, consecutiveMistakeLimit: DEFAULT_CONSECUTIVE_MISTAKE_LIMIT }
				: config
		const result = persistedProviderSettingsWithIdSchema.safeParse(migratedConfig)
		if (result.success) {
			configs.push([name, result.data as ProviderSettingsWithId])
			if (result.data.id) ids.add(result.data.id)
		} else {
			const previous = Object.hasOwn(retained, name) ? retained[name] : undefined
			const storedId = isRecord(config) && typeof config.id === "string" && config.id ? config.id : undefined
			let id = previous?.id ?? storedId
			if (!id) {
				for (let attempt = 0; attempt < 16; attempt++) {
					const candidate = generateId()
					if (!ids.has(candidate)) {
						id = candidate
						break
					}
				}
				if (!id) throw new Error("Could not assign a unique saved provider profile identity")
			}
			Object.defineProperty(retained, name, {
				value: { id, value: config },
				enumerable: true,
				configurable: true,
				writable: true,
			})
			ids.add(id)
			needsPersistence = true
		}
	}
	const profiles: ProviderProfiles = { ...raw, apiConfigs: Object.fromEntries(configs) }
	if (Object.keys(retained).length) profiles.retainedApiConfigs = retained
	else delete profiles.retainedApiConfigs
	return { profiles, needsPersistence }
}

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
	// Fresh views must agree before the first settings write; persisted IDs remain authoritative.
	private readonly defaultConfigId = "default"

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
				const { profiles: providerProfiles, needsPersistence } = await this.read()

				if (!providerProfiles) {
					await this.store(this.defaultProviderProfiles)
					return
				}

				let isDirty = needsPersistence

				// Bind modes only after legacy profiles have durable IDs. Otherwise the
				// generated seed can point at no profile, or at an unrelated existing ID.
				for (const apiConfig of Object.values(providerProfiles.apiConfigs)) {
					if (!apiConfig.id) {
						apiConfig.id = this.generateId()
						isDirty = true
					}
				}

				const currentName = providerProfiles.currentApiConfigName
				const selectedId = this.profileEntries(providerProfiles).find(({ name }) => name === currentName)?.id
				const seedId = selectedId ?? Object.values(providerProfiles.apiConfigs)[0]?.id

				// Migrate existing installs to have per-mode API config map
				if (!providerProfiles.modeApiConfigs && seedId) {
					// Use the currently selected config for all modes initially
					providerProfiles.modeApiConfigs = Object.fromEntries(modes.map((m) => [m.slug, seedId]))
					isDirty = true
				}

				// Older migrations could persist a seed ID that never belonged to a
				// profile. Repair only dangling executable-mode bindings, retaining
				// valid per-mode choices and absent choices in existing maps.
				if (providerProfiles.modeApiConfigs && seedId) {
					const profileIds = new Set(this.profileEntries(providerProfiles).map(({ id }) => id))
					for (const { slug } of modes) {
						const boundId = providerProfiles.modeApiConfigs[slug]
						if (boundId !== undefined && !profileIds.has(boundId)) {
							providerProfiles.modeApiConfigs[slug] = seedId
							isDirty = true
						}
					}
				}

				// Apply model migrations for all providers
				if (this.applyModelMigrations(providerProfiles)) {
					isDirty = true
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
		const validEntries: ProviderSettingsEntry[] = Object.entries(providerProfiles.apiConfigs)
			.filter(([name]) => !Object.hasOwn(providerProfiles.retainedApiConfigs ?? {}, name))
			.map(([name, apiConfig]) => ({
				name,
				id: apiConfig.id || "",
				apiProvider: apiConfig.apiProvider,
				modelId: this.cleanModelId(getModelId(apiConfig)),
				...(this.isUnsupportedProvider(apiConfig.apiProvider) ? { availability: "unsupported" as const } : {}),
			}))
		const retainedEntries: ProviderSettingsEntry[] = Object.entries(providerProfiles.retainedApiConfigs ?? {}).map(
			([name, { id, value }]) => {
				const invalidFields = getInvalidProviderFields(value)
				return {
					name,
					id,
					...(isRecord(value) && typeof value.apiProvider === "string" && value.apiProvider
						? { apiProvider: value.apiProvider }
						: {}),
					availability: "invalid",
					invalidFields: invalidFields.length ? invalidFields : ["configuration"],
				}
			},
		)
		return [...validEntries, ...retainedEntries]
	}

	private isUnsupportedProvider(value: unknown): boolean {
		return typeof value === "string" && value !== "fake-ai" && (!isProviderName(value) || isRetiredProvider(value))
	}

	private resolveProfile(
		providerProfiles: ProviderProfiles,
		params: { name: string } | { id: string },
	): ProviderSettingsEntry {
		const entries = this.profileEntries(providerProfiles).filter((candidate) =>
			"name" in params ? candidate.name === params.name : candidate.id === params.id,
		)
		if ("id" in params && entries.length > 1) throw this.ambiguousIdentityError(params.id)
		const entry = entries[0]
		if (!entry)
			throw new Error(
				"name" in params
					? `Config with name '${params.name}' not found`
					: `Config with ID '${params.id}' not found`,
			)
		return entry
	}

	private ambiguousIdentityError(id: string): ProviderProfileUnavailableError {
		return new ProviderProfileUnavailableError("invalid", { id, name: "Ambiguous saved profile identity" }, ["id"])
	}

	private assertAvailable(entry: ProviderSettingsEntry): void {
		if (entry.availability) {
			throw new ProviderProfileUnavailableError(
				entry.availability,
				{ id: entry.id, name: entry.name },
				entry.invalidFields,
			)
		}
	}

	public async assertProfileAvailable(params: { name: string } | { id: string }): Promise<void> {
		return this.lock(async () => this.assertAvailable(this.resolveProfile(await this.load(), params)))
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
				const entries = this.profileEntries(providerProfiles)
				if ("id" in params && entries.filter(({ id }) => id === params.id).length > 1) {
					throw new ProviderProfileRenameError("invalid")
				}
				const entry = entries.find((config) =>
					"id" in params ? config.id === params.id : config.name === params.name,
				)
				if (!entry) throw new ProviderProfileRenameError("notFound")
				const { name: oldName, id } = entry
				if (!id) throw new ProviderProfileRenameError("notFound")
				if (options.expectedName !== undefined && oldName !== options.expectedName) {
					throw new ProviderProfileRenameError("invalid")
				}
				if (
					entries.some(
						({ name: existingName }) =>
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
						Object.entries(providerProfiles.apiConfigs).map(([key, value]) => [
							key === oldName ? name : key,
							value,
						]),
					),
					...(providerProfiles.retainedApiConfigs
						? {
								retainedApiConfigs: Object.fromEntries(
									Object.entries(providerProfiles.retainedApiConfigs).map(([key, value]) => [
										key === oldName ? name : key,
										value,
									]),
								),
							}
						: {}),
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
						: Object.hasOwn(providerProfiles.retainedApiConfigs ?? {}, name)
							? providerProfiles.retainedApiConfigs?.[name].id
							: undefined
					id = config.id || existingId || this.generateId()
				} else {
					const matches = this.profileEntries(providerProfiles).filter(({ id }) => id === target.id)
					if (matches.length > 1) throw new ProviderProfileSaveError("invalid")
					const entry = matches[0]
					if (!entry) throw new ProviderProfileSaveError("notFound")
					name = entry.name
					id = target.id
					// Validate the original container; object spread would turn malformed wire values into empty profiles.
					z.record(z.unknown()).parse(config)
				}
				// A draft's embedded ID cannot change the authority of an explicit existing-profile target.
				const configToSave = typeof target === "string" ? config : { ...config, id }
				if (Object.hasOwn(providerProfiles.retainedApiConfigs ?? {}, name)) {
					persistedProviderSettingsWithIdSchema.parse(configToSave)
				}

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
				if (updated.retainedApiConfigs) {
					updated.retainedApiConfigs = { ...updated.retainedApiConfigs }
					delete updated.retainedApiConfigs[name]
					if (!Object.keys(updated.retainedApiConfigs).length) delete updated.retainedApiConfigs
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
				const entry = this.resolveProfile(providerProfiles, params)
				if (entry.availability === "invalid") this.assertAvailable(entry)
				return { ...providerProfiles.apiConfigs[entry.name], name: entry.name }
			})
		} catch (error) {
			if (error instanceof ProviderProfileUnavailableError) throw error
			throw new Error(`Failed to get profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Activate a profile by name or ID.
	 */
	public async activateProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				const entry = this.resolveProfile(providerProfiles, params)
				this.assertAvailable(entry)
				providerProfiles.currentApiConfigName = entry.name
				await this.store(providerProfiles)
				return { ...providerProfiles.apiConfigs[entry.name], name: entry.name }
			})
		} catch (error) {
			if (error instanceof ProviderProfileUnavailableError) throw error
			throw new Error(`Failed to activate profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Delete a config by name.
	 */
	public async deleteConfig(name: string, options: { expectedId?: string } = {}) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				const isRetained = Object.hasOwn(providerProfiles.retainedApiConfigs ?? {}, name)
				const removed = this.profileEntries(providerProfiles).find((entry) => entry.name === name)
				if (!Object.hasOwn(providerProfiles.apiConfigs, name) && !isRetained) {
					throw new Error(`Config '${name}' not found`)
				}
				if (options.expectedId !== undefined && removed?.id !== options.expectedId) {
					throw new Error(
						"Saved provider profile identity changed. Refresh the profile list before deleting it.",
					)
				}

				if (this.profileEntries(providerProfiles).length === 1) {
					throw new Error(`Cannot delete the last remaining configuration`)
				}

				delete providerProfiles.apiConfigs[name]
				if (providerProfiles.retainedApiConfigs) {
					delete providerProfiles.retainedApiConfigs[name]
					if (!Object.keys(providerProfiles.retainedApiConfigs).length)
						delete providerProfiles.retainedApiConfigs
				}
				const entries = this.profileEntries(providerProfiles)
				if (providerProfiles.currentApiConfigName === name) {
					providerProfiles.currentApiConfigName = (
						entries.find((entry) => !entry.availability) ?? entries[0]
					).name
				}
				if (removed?.id && providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = Object.fromEntries(
						Object.entries(providerProfiles.modeApiConfigs).filter(([, id]) => id !== removed.id),
					)
				}
				const selected = entries.find((entry) => entry.name === providerProfiles.currentApiConfigName)
				const selectedProfile =
					selected && !selected.availability
						? { ...providerProfiles.apiConfigs[selected.name], name: selected.name }
						: undefined
				await this.store(providerProfiles)
				return { currentApiConfigName: providerProfiles.currentApiConfigName, entries, selectedProfile }
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
				return (
					Object.hasOwn(providerProfiles.apiConfigs, name) ||
					Object.hasOwn(providerProfiles.retainedApiConfigs ?? {}, name)
				)
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
				const profiles = await this.load()
				const id = profiles.modeApiConfigs?.[mode]
				if (id !== undefined && this.profileEntries(profiles).filter((entry) => entry.id === id).length > 1) {
					throw this.ambiguousIdentityError(id)
				}
				return id
			})
		} catch (error) {
			if (error instanceof ProviderProfileUnavailableError) throw error
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

	public async import(providerProfiles: ProviderProfiles, options: { referencedIds?: string[] } = {}) {
		try {
			return await this.lock(async () => {
				const previous = await this.load()
				const { profiles: imported } = readPersistedProviderProfiles(providerProfiles, () => this.generateId())
				const source: ProviderProfiles = {
					...imported,
					apiConfigs: { ...imported.apiConfigs },
					retainedApiConfigs: imported.retainedApiConfigs ? { ...imported.retainedApiConfigs } : undefined,
				}
				const retained = { ...previous.retainedApiConfigs, ...imported.retainedApiConfigs }
				for (const [name, entry] of Object.entries(imported.retainedApiConfigs ?? {})) {
					const previousId = Object.hasOwn(previous.retainedApiConfigs ?? {}, name)
						? previous.retainedApiConfigs?.[name].id
						: Object.hasOwn(previous.apiConfigs, name)
							? previous.apiConfigs[name].id
							: undefined
					if (previousId) {
						retained[name] = { ...entry, id: previousId }
					}
				}
				for (const name of Object.keys(imported.apiConfigs)) {
					if (!Object.hasOwn(imported.retainedApiConfigs ?? {}, name)) {
						const previousId = Object.hasOwn(previous.retainedApiConfigs ?? {}, name)
							? previous.retainedApiConfigs?.[name].id
							: undefined
						if (previousId) {
							imported.apiConfigs[name] = { ...imported.apiConfigs[name], id: previousId }
						}
						delete retained[name]
					}
				}
				imported.apiConfigs = { ...previous.apiConfigs, ...imported.apiConfigs }
				for (const name of Object.keys(imported.retainedApiConfigs ?? {})) delete imported.apiConfigs[name]
				for (const [name, config] of Object.entries(imported.apiConfigs)) {
					if (!config.id)
						imported.apiConfigs[name] = {
							...config,
							id: Object.hasOwn(previous.apiConfigs, name)
								? (previous.apiConfigs[name].id ?? this.generateId())
								: this.generateId(),
						}
				}
				if (Object.keys(retained).length) imported.retainedApiConfigs = retained
				else delete imported.retainedApiConfigs
				const remapId = createImportedProfileIdRemapper(source, imported)
				for (const id of options.referencedIds ?? []) remapId(id)
				imported.modeApiConfigs = {
					...previous.modeApiConfigs,
					...Object.fromEntries(
						Object.entries(source.modeApiConfigs ?? {}).map(([mode, id]) => [mode, remapId(id)]),
					),
				}
				await this.store(imported)
				return imported
			})
		} catch (error) {
			if (error instanceof ProviderProfileUnavailableError) throw error
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
		return (await this.read()).profiles
	}

	private async read(): Promise<{ profiles: ProviderProfiles; needsPersistence: boolean }> {
		try {
			const content = await this.context.secrets.get(this.secretsKey)

			if (!content) {
				return { profiles: this.defaultProviderProfiles, needsPersistence: false }
			}

			return readPersistedProviderProfiles(JSON.parse(content), () => this.generateId())
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({
					schemaName: "ProviderProfiles",
					error,
				})
				throw new Error("Saved provider profile metadata is invalid. Its stored data was not changed.")
			}
			if (error instanceof SyntaxError)
				throw new Error("Saved provider profiles are not valid JSON. Their stored data was not changed.")

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
