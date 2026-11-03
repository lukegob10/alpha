import {
	embedderProviders,
	embeddingApiKeyFields,
	embeddingDefaultModels,
	embeddingModelProfiles,
} from "@alpha-code/types"
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Trans } from "react-i18next"
import { z } from "zod"
import {
	VSCodeButton,
	VSCodeTextField,
	VSCodeDropdown,
	VSCodeOption,
	VSCodeLink,
	VSCodeCheckbox,
} from "@vscode/webview-ui-toolkit/react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { AlertTriangle } from "lucide-react"

import {
	type CodebaseIndexEmbedderProvider,
	type IndexingStatus,
	CODEBASE_INDEX_DEFAULTS,
	VERTEX_REGIONS,
	isSupportedCodebaseIndexEmbedderProvider,
	normalizeCodeIndexSearchMaxResults,
} from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { buildDocLink } from "@src/utils/docLinks"
import { cn } from "@src/lib/utils"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Popover,
	PopoverContent,
	Slider,
	StandardTooltip,
	Button,
} from "@src/components/ui"
import { useAlphaPortal } from "@src/components/ui/hooks/useAlphaPortal"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

const DEFAULT_QDRANT_URL = "http://localhost:6333"
const DEFAULT_LOCAL_INDEX_PATH = ".alpha/code-index/lancedb"

type VectorStoreProvider = "qdrant" | "lancedb"

interface CodeIndexPopoverProps {
	children: React.ReactNode
	indexingStatus: IndexingStatus
}

interface LocalCodeIndexSettings {
	// Global state settings
	codebaseIndexEnabled: boolean
	codebaseIndexVectorStoreProvider: VectorStoreProvider
	codebaseIndexLocalIndexPath: string
	codebaseIndexQdrantUrl: string
	codebaseIndexEmbedderProvider: CodebaseIndexEmbedderProvider
	codebaseIndexEmbedderModelId: string
	codebaseIndexEmbedderModelDimension?: number
	codebaseIndexSearchMaxResults?: number
	codebaseIndexSearchMinScore?: number
	codebaseIndexEmbeddingRateLimitEnabled?: boolean
	codebaseIndexEmbeddingRateLimitSeconds?: number

	codebaseIndexVertexProjectId?: string
	codebaseIndexVertexRegion?: string
	codebaseIndexVertexKeyFile?: string

	codeIndexQdrantApiKey?: string
	codebaseIndexVertexJsonCredentials?: string
	codebaseIndexGeminiApiKey?: string
	codebaseIndexOpenAiApiKey?: string
	codebaseIndexOpenAiCompatibleApiKey?: string
	codebaseIndexOpenRouterApiKey?: string
	codebaseIndexBedrockApiKey?: string
	codebaseIndexOpenAiCompatibleBaseUrl?: string
	codebaseIndexBedrockRegion?: string
	codebaseIndexBedrockProfile?: string
}

const secretStatusKeyByField = {
	codeIndexQdrantApiKey: "hasQdrantApiKey",
	codebaseIndexVertexJsonCredentials: "hasVertexJsonCredentials",
	codebaseIndexGeminiApiKey: "hasGeminiApiKey",
	codebaseIndexOpenAiApiKey: "hasOpenAiApiKey",
	codebaseIndexOpenAiCompatibleApiKey: "hasOpenAiCompatibleApiKey",
	codebaseIndexOpenRouterApiKey: "hasOpenRouterApiKey",
	codebaseIndexBedrockApiKey: "hasBedrockApiKey",
} as const

type SecretField = keyof typeof secretStatusKeyByField
type SavedSecretStatus = Record<SecretField, boolean>

const emptySavedSecretStatus = (): SavedSecretStatus =>
	Object.fromEntries(Object.keys(secretStatusKeyByField).map((field) => [field, false])) as SavedSecretStatus

const createValidationSchema = (vectorStoreProvider: VectorStoreProvider, embedderProvider: string, t: any) => {
	const vectorStoreSchema =
		vectorStoreProvider === "qdrant"
			? {
					codebaseIndexQdrantUrl: z
						.string()
						.min(1, t("settings:codeIndex.validation.qdrantUrlRequired"))
						.url(t("settings:codeIndex.validation.invalidQdrantUrl")),
					codebaseIndexLocalIndexPath: z.string().optional(),
				}
			: {
					codebaseIndexQdrantUrl: z.string().optional(),
					codebaseIndexLocalIndexPath: z
						.string()
						.min(1, t("settings:codeIndex.validation.localIndexPathRequired")),
				}

	const baseSchema = z.object({
		codebaseIndexEnabled: z.boolean(),
		codebaseIndexVectorStoreProvider: z.enum(["qdrant", "lancedb"]),
		codebaseIndexEmbedderProvider: z.enum(embedderProviders),
		codeIndexQdrantApiKey: z.string().optional(),
		codebaseIndexEmbeddingRateLimitEnabled: z.boolean().optional(),
		codebaseIndexEmbeddingRateLimitSeconds: z
			.number()
			.min(
				CODEBASE_INDEX_DEFAULTS.MIN_EMBEDDING_RATE_LIMIT_SECONDS,
				t("settings:codeIndex.validation.embeddingRateLimitSecondsRange"),
			)
			.max(
				CODEBASE_INDEX_DEFAULTS.MAX_EMBEDDING_RATE_LIMIT_SECONDS,
				t("settings:codeIndex.validation.embeddingRateLimitSecondsRange"),
			)
			.optional(),
		...vectorStoreSchema,
	})
	if (embedderProvider !== "vertex") {
		const key =
			isSupportedCodebaseIndexEmbedderProvider(embedderProvider) && embedderProvider !== "vertex"
				? embeddingApiKeyFields[embedderProvider]
				: undefined
		const requiredKey = ["gemini", "openai-native", "openrouter"].includes(embedderProvider)
		return baseSchema
			.extend({
				...(key
					? {
							[key]: requiredKey
								? z.string().trim().min(1, t("settings:codeIndex.validation.apiKeyRequired"))
								: z.string().optional(),
						}
					: {}),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
				...(embedderProvider === "openai"
					? {
							codebaseIndexOpenAiCompatibleBaseUrl: z
								.string()
								.url(t("settings:codeIndex.validation.invalidEmbeddingBaseUrl")),
							codebaseIndexEmbedderModelDimension: z
								.number()
								.int()
								.positive(t("settings:codeIndex.validation.embeddingDimensionRequired"))
								.optional(),
						}
					: {}),
				...(embedderProvider === "bedrock"
					? {
							codebaseIndexBedrockRegion: z
								.string()
								.regex(
									/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/,
									t("settings:codeIndex.validation.bedrockRegionRequired"),
								),
						}
					: {}),
			})
			.superRefine((value, context) => {
				if (
					embedderProvider === "openai" &&
					!embeddingModelProfiles.openai?.[value.codebaseIndexEmbedderModelId] &&
					!value.codebaseIndexEmbedderModelDimension
				)
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["codebaseIndexEmbedderModelDimension"],
						message: t("settings:codeIndex.validation.embeddingDimensionRequired"),
					})
			})
	}

	return baseSchema.extend({
		codebaseIndexVertexProjectId: z.string().min(1, t("settings:codeIndex.validation.vertexProjectIdRequired")),
		codebaseIndexVertexRegion: z.string().min(1, t("settings:codeIndex.validation.vertexRegionRequired")),
		codebaseIndexVertexJsonCredentials: z.string().optional(),
		codebaseIndexVertexKeyFile: z.string().optional(),

		codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
	})
}

export const CodeIndexPopover: React.FC<CodeIndexPopoverProps> = ({
	children,
	indexingStatus: externalIndexingStatus,
}) => {
	const SECRET_PLACEHOLDER = "••••••••••••••••"
	const { t } = useAppTranslation()
	const { codebaseIndexConfig, codebaseIndexModels, cwd, apiConfiguration } = useExtensionState()
	const [open, setOpen] = useState(false)
	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)
	const [isSetupSettingsOpen, setIsSetupSettingsOpen] = useState(false)

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>(externalIndexingStatus)

	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
	const [saveError, setSaveError] = useState<string | null>(null)
	const [savedSecretStatus, setSavedSecretStatus] = useState<SavedSecretStatus>(emptySavedSecretStatus())

	useEffect(() => {
		if (saveStatus !== "error") return

		const timeout = setTimeout(() => {
			setSaveStatus("idle")
			setSaveError(null)
		}, 5_000)

		return () => clearTimeout(timeout)
	}, [saveError, saveStatus])

	// Form validation state
	const [formErrors, setFormErrors] = useState<Record<string, string>>({})

	// Discard changes dialog state
	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const confirmDialogHandler = useRef<(() => void) | null>(null)

	// Default settings template
	const getDefaultSettings = (): LocalCodeIndexSettings => ({
		codebaseIndexEnabled: true,
		codebaseIndexVectorStoreProvider: "lancedb",
		codebaseIndexLocalIndexPath: DEFAULT_LOCAL_INDEX_PATH,
		codebaseIndexQdrantUrl: "",
		codebaseIndexEmbedderProvider: "vertex",
		codebaseIndexEmbedderModelId: "",
		codebaseIndexEmbedderModelDimension: undefined,
		codebaseIndexSearchMaxResults: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
		codebaseIndexSearchMinScore: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
		codebaseIndexEmbeddingRateLimitEnabled: false,
		codebaseIndexEmbeddingRateLimitSeconds: CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
		codebaseIndexVertexProjectId: "",
		codebaseIndexVertexRegion: "",
		codebaseIndexVertexKeyFile: "",
		codeIndexQdrantApiKey: "",
		codebaseIndexVertexJsonCredentials: "",
		codebaseIndexGeminiApiKey: "",
		codebaseIndexOpenAiApiKey: "",
		codebaseIndexOpenAiCompatibleApiKey: "",
		codebaseIndexOpenRouterApiKey: "",
		codebaseIndexBedrockApiKey: "",
		codebaseIndexOpenAiCompatibleBaseUrl: "",
		codebaseIndexBedrockRegion: "us-east-1",
		codebaseIndexBedrockProfile: "",
	})

	// Initial settings state - stores the settings when popover opens
	const [initialSettings, setInitialSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Current settings state - tracks user changes
	const [currentSettings, setCurrentSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	const hasUnsavedChanges = useMemo(() => {
		const keys = new Set([...Object.keys(initialSettings), ...Object.keys(currentSettings)])
		return [...keys].some((key) => {
			const field = key as keyof LocalCodeIndexSettings
			return currentSettings[field] !== SECRET_PLACEHOLDER && currentSettings[field] !== initialSettings[field]
		})
	}, [currentSettings, initialSettings])
	const preserveDraftRef = useRef(false)
	preserveDraftRef.current = hasUnsavedChanges || saveStatus === "saving"

	const hasSavedSecret = useCallback((field: SecretField) => savedSecretStatus[field], [savedSecretStatus])

	const getSecretPlaceholder = useCallback(
		(field: SecretField, placeholderKey: string) =>
			hasSavedSecret(field) && !currentSettings[field]
				? t("settings:codeIndex.savedSecretPlaceholder")
				: t(placeholderKey),
		[hasSavedSecret, currentSettings, t],
	)

	const redactSavedSecrets = useCallback(
		(settings: LocalCodeIndexSettings): LocalCodeIndexSettings => {
			const redacted = { ...settings }

			for (const field of Object.keys(secretStatusKeyByField) as SecretField[]) {
				if (redacted[field] && redacted[field] !== SECRET_PLACEHOLDER) {
					redacted[field] = ""
				}
			}

			return redacted
		},
		[SECRET_PLACEHOLDER],
	)

	// Update indexing status from parent
	useEffect(() => {
		setIndexingStatus(externalIndexingStatus)
	}, [externalIndexingStatus])

	// Initialize settings from global state
	useEffect(() => {
		// State broadcasts recreate these objects during chat activity. Keep edits until Save or Discard;
		// changing dirty state alone must not reload the older host snapshot after a save acknowledgement.
		if (preserveDraftRef.current) return

		if (codebaseIndexConfig) {
			const embedderProvider: CodebaseIndexEmbedderProvider =
				codebaseIndexConfig.codebaseIndexEmbedderProvider || "vertex"
			const activeVertexConfig = apiConfiguration?.apiProvider === "vertex" ? apiConfiguration : undefined
			const settings = {
				codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? true,
				codebaseIndexVectorStoreProvider: codebaseIndexConfig.codebaseIndexVectorStoreProvider || "lancedb",
				codebaseIndexLocalIndexPath:
					codebaseIndexConfig.codebaseIndexLocalIndexPath || DEFAULT_LOCAL_INDEX_PATH,
				codebaseIndexQdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl || "",
				codebaseIndexEmbedderProvider: embedderProvider,
				codebaseIndexEmbedderModelId:
					codebaseIndexConfig.codebaseIndexEmbedderModelId ||
					(isSupportedCodebaseIndexEmbedderProvider(embedderProvider)
						? embeddingDefaultModels[embedderProvider]
						: ""),
				codebaseIndexEmbedderModelDimension:
					codebaseIndexConfig.codebaseIndexEmbedderModelDimension || undefined,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl || "",
				codebaseIndexBedrockRegion: codebaseIndexConfig.codebaseIndexBedrockRegion || "us-east-1",
				codebaseIndexBedrockProfile: codebaseIndexConfig.codebaseIndexBedrockProfile || "",
				codebaseIndexSearchMaxResults: normalizeCodeIndexSearchMaxResults(
					codebaseIndexConfig.codebaseIndexSearchMaxResults,
				),
				codebaseIndexSearchMinScore:
					codebaseIndexConfig.codebaseIndexSearchMinScore ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
				codebaseIndexEmbeddingRateLimitEnabled:
					codebaseIndexConfig.codebaseIndexEmbeddingRateLimitEnabled ?? false,
				codebaseIndexEmbeddingRateLimitSeconds:
					codebaseIndexConfig.codebaseIndexEmbeddingRateLimitSeconds ??
					CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
				codebaseIndexVertexProjectId:
					codebaseIndexConfig.codebaseIndexVertexProjectId ||
					activeVertexConfig?.projectId ||
					activeVertexConfig?.vertexProjectId ||
					"",
				codebaseIndexVertexRegion:
					codebaseIndexConfig.codebaseIndexVertexRegion ||
					activeVertexConfig?.location ||
					activeVertexConfig?.vertexRegion ||
					"",
				codebaseIndexVertexKeyFile:
					codebaseIndexConfig.codebaseIndexVertexKeyFile || activeVertexConfig?.vertexKeyFile || "",
				codeIndexQdrantApiKey: "",
				codebaseIndexVertexJsonCredentials: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexOpenAiApiKey: "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
				codebaseIndexBedrockApiKey: "",
			}
			setInitialSettings(settings)
			setCurrentSettings(settings)

			// Request secret status to check if secrets exist
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
		}
	}, [apiConfiguration, codebaseIndexConfig, open])

	// Request initial indexing status
	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestIndexingStatus" })
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
		}
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "workspaceUpdated") {
				// When workspace changes, request updated indexing status
				if (open) {
					vscode.postMessage({ type: "requestIndexingStatus" })
					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [open])

	// Acknowledgements apply to the submitted snapshot, not edits made while saving.
	const pendingSettingsRef = useRef<LocalCodeIndexSettings>()

	// Listen for indexing status updates and save responses
	useEffect(() => {
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "indexingStatusUpdate") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setIndexingStatus((prev) => ({
						...prev,
						systemStatus: event.data.values.systemStatus,
						message: event.data.values.message || "",
						processedItems: event.data.values.processedItems,
						totalItems: event.data.values.totalItems,
						currentItemUnit: event.data.values.currentItemUnit || "items",
						workspacePath: event.data.values.workspacePath ?? prev.workspacePath,
						workspaceEnabled: event.data.values.workspaceEnabled ?? prev.workspaceEnabled,
						autoEnableDefault: event.data.values.autoEnableDefault ?? prev.autoEnableDefault,
					}))
				}
			} else if (event.data.type === "codeIndexSettingsSaved") {
				if (event.data.success) {
					const submittedSettings = pendingSettingsRef.current
					if (!submittedSettings) return
					pendingSettingsRef.current = undefined
					const savedSettings = redactSavedSecrets(submittedSettings)
					setInitialSettings(savedSettings)
					setCurrentSettings((current) => ({
						...current,
						...Object.fromEntries(
							Object.entries(savedSettings).filter(([key]) => {
								const field = key as keyof LocalCodeIndexSettings
								return current[field] === submittedSettings[field]
							}),
						),
					}))
					setSavedSecretStatus((previous) => {
						const next = { ...previous }
						for (const field of Object.keys(secretStatusKeyByField) as SecretField[]) {
							if (submittedSettings[field]) next[field] = true
						}
						return next
					})
					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
					setSaveStatus("idle")
				} else {
					pendingSettingsRef.current = undefined
					setSaveStatus("error")
					setSaveError(event.data.error || t("settings:codeIndex.saveError"))
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [t, cwd, redactSavedSecrets])

	// Listen for secret status
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "codeIndexSecretStatus") {
				// Update settings to show placeholders for existing secrets
				const secretStatus = event.data.values
				const nextSavedSecretStatus = Object.fromEntries(
					(Object.entries(secretStatusKeyByField) as [SecretField, keyof typeof secretStatus][]).map(
						([field, statusKey]) => [field, !!secretStatus[statusKey]],
					),
				) as SavedSecretStatus

				setSavedSecretStatus(nextSavedSecretStatus)

				// Preserve active edits while clearing saved-secret placeholders.
				const updateWithSecrets = (prev: LocalCodeIndexSettings): LocalCodeIndexSettings => {
					const updated = { ...prev }

					for (const field of Object.keys(secretStatusKeyByField) as SecretField[]) {
						if (!prev[field] || prev[field] === SECRET_PLACEHOLDER) updated[field] = ""
					}

					return updated
				}

				// Only update settings if we're not in the middle of saving
				// After save is complete (saved status), we still want to update to maintain consistency
				if (saveStatus === "idle" || saveStatus === "saved") {
					setCurrentSettings(updateWithSecrets)
					setInitialSettings(updateWithSecrets)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [saveStatus])

	const updateSetting = (key: keyof LocalCodeIndexSettings, value: any) => {
		setCurrentSettings((prev) => ({ ...prev, [key]: value }))
		// Clear validation error for this field when user starts typing
		if (formErrors[key]) {
			setFormErrors((prev) => {
				const newErrors = { ...prev }
				delete newErrors[key]
				return newErrors
			})
		}
	}

	// Validation function
	const validateSettings = (): boolean => {
		const schema = createValidationSchema(
			currentSettings.codebaseIndexVectorStoreProvider,
			currentSettings.codebaseIndexEmbedderProvider,
			t,
		)

		// Prepare data for validation
		const dataToValidate: any = {}
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder values, treat them as valid (they exist in backend)
			const secretField = key as SecretField
			if (
				value === SECRET_PLACEHOLDER ||
				(key in secretStatusKeyByField && !value && savedSecretStatus[secretField])
			) {
				if (key in secretStatusKeyByField) {
					dataToValidate[key] = "placeholder-valid"
				}
			} else {
				dataToValidate[key] = value
			}
		}

		try {
			// Validate using the schema
			schema.parse(dataToValidate)
			setFormErrors({})
			return true
		} catch (error) {
			if (error instanceof z.ZodError) {
				const errors: Record<string, string> = {}
				error.errors.forEach((err) => {
					if (err.path[0]) {
						errors[err.path[0] as string] = err.message
					}
				})
				setFormErrors(errors)
			}
			return false
		}
	}

	// Discard changes functionality
	const checkUnsavedChanges = useCallback(
		(then: () => void) => {
			if (hasUnsavedChanges) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[hasUnsavedChanges],
	)

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset to initial settings
				setCurrentSettings(initialSettings)
				setFormErrors({}) // Clear any validation errors
				confirmDialogHandler.current?.() // Execute the pending action (e.g., close popover)
			}
			setDiscardDialogShow(false)
		},
		[initialSettings],
	)

	// Handle popover close with unsaved changes check
	const handlePopoverClose = useCallback(() => {
		checkUnsavedChanges(() => {
			setOpen(false)
		})
	}, [checkUnsavedChanges])

	// Use the shared ESC key handler hook - respects unsaved changes logic
	useEscapeKey(open, handlePopoverClose)

	const handleSaveSettings = () => {
		// Validate settings before saving
		if (!validateSettings()) {
			return
		}

		setSaveStatus("saving")
		setSaveError(null)
		pendingSettingsRef.current = { ...currentSettings }

		// Prepare settings to save
		const settingsToSave: any = {}

		// Iterate through all current settings
		for (const [key, value] of Object.entries(currentSettings)) {
			// Blank drafts preserve stored credentials, including before presence flags arrive.
			if (value === SECRET_PLACEHOLDER || (key in secretStatusKeyByField && value === "")) {
				// Skip sending placeholder values - backend will preserve existing secrets
				continue
			}

			// Include public settings and explicitly entered credentials.
			settingsToSave[key] = value
		}

		// Always include codebaseIndexEnabled to ensure it's persisted
		settingsToSave.codebaseIndexEnabled = currentSettings.codebaseIndexEnabled

		// Save settings to backend
		vscode.postMessage({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settingsToSave,
		})
	}

	const progressPercentage = useMemo(
		() =>
			indexingStatus.totalItems > 0
				? Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100)
				: 0,
		[indexingStatus.processedItems, indexingStatus.totalItems],
	)

	const transformStyleString = `translateX(-${100 - progressPercentage}%)`

	const getAvailableModels = () => {
		const provider = currentSettings.codebaseIndexEmbedderProvider
		const models = isSupportedCodebaseIndexEmbedderProvider(provider)
			? (codebaseIndexModels?.[provider] ?? embeddingModelProfiles[provider])
			: undefined
		return models ? Object.keys(models) : []
	}

	const getModelProfile = (modelId: string) => {
		const provider = currentSettings.codebaseIndexEmbedderProvider
		return isSupportedCodebaseIndexEmbedderProvider(provider)
			? (codebaseIndexModels?.[provider] ?? embeddingModelProfiles[provider])?.[modelId]
			: undefined
	}

	const portalContainer = useAlphaPortal("alpha-portal")

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(newOpen) => {
					if (!newOpen) {
						// User is trying to close the popover
						handlePopoverClose()
					} else {
						setOpen(newOpen)
					}
				}}>
				{children}
				<PopoverContent
					className="w-[calc(100vw-32px)] max-w-[450px] max-h-[80vh] overflow-y-auto p-0"
					align="end"
					alignOffset={0}
					side="top"
					sideOffset={5}
					collisionPadding={16}
					avoidCollisions={true}
					container={portalContainer}>
					<div className="p-3 border-b border-vscode-dropdown-border cursor-default">
						<div className="flex flex-row items-center gap-1 p-0 mt-0 mb-1 w-full">
							<h4 className="m-0 pb-2 flex-1">{t("settings:codeIndex.title")}</h4>
						</div>
						<p className="my-0 pr-4 text-sm w-full">
							<Trans i18nKey="settings:codeIndex.description">
								<VSCodeLink
									href={buildDocLink("features/experimental/codebase-indexing", "settings")}
									style={{ display: "inline" }}
								/>
							</Trans>
						</p>
					</div>

					<div className="p-4">
						{/* Enable/Disable Toggle */}
						<div className="mb-4">
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={currentSettings.codebaseIndexEnabled}
									onChange={(e: any) => updateSetting("codebaseIndexEnabled", e.target.checked)}>
									<span className="font-medium">{t("settings:codeIndex.enableLabel")}</span>
								</VSCodeCheckbox>
								<StandardTooltip content={t("settings:codeIndex.enableDescription")}>
									<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
								</StandardTooltip>
							</div>
						</div>

						{/* Status Section */}
						<div className="space-y-2">
							<h4 className="text-sm font-medium">{t("settings:codeIndex.statusTitle")}</h4>
							<div className="text-sm text-vscode-descriptionForeground">
								<span
									className={cn("inline-block w-3 h-3 rounded-full mr-2", {
										"bg-gray-400": indexingStatus.systemStatus === "Standby",
										"bg-yellow-500 animate-pulse": indexingStatus.systemStatus === "Indexing",
										"bg-green-500": indexingStatus.systemStatus === "Indexed",
										"bg-red-500": indexingStatus.systemStatus === "Error",
									})}
								/>
								{t(`settings:codeIndex.indexingStatuses.${indexingStatus.systemStatus.toLowerCase()}`)}
								{indexingStatus.message ? ` - ${indexingStatus.message}` : ""}
							</div>

							{indexingStatus.systemStatus === "Indexing" && (
								<div className="mt-2">
									<p className="mb-2 text-xs text-vscode-descriptionForeground">
										{t("settings:codeIndex.freshnessNote")}
									</p>
									<ProgressPrimitive.Root
										className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
										value={progressPercentage}>
										<ProgressPrimitive.Indicator
											className="h-full w-full flex-1 bg-primary transition-transform duration-300 ease-in-out"
											style={{
												transform: transformStyleString,
											}}
										/>
									</ProgressPrimitive.Root>
								</div>
							)}
						</div>

						{/* Setup Settings Disclosure */}
						<div className="mt-4">
							<button
								onClick={() => setIsSetupSettingsOpen(!isSetupSettingsOpen)}
								className="flex items-center text-xs text-vscode-foreground hover:text-vscode-textLink-foreground focus:outline-none"
								aria-expanded={isSetupSettingsOpen}>
								<span
									className={`codicon codicon-${isSetupSettingsOpen ? "chevron-down" : "chevron-right"} mr-1`}></span>
								<span className="text-base font-semibold">
									{t("settings:codeIndex.setupConfigLabel")}
								</span>
							</button>

							{isSetupSettingsOpen && (
								<div className="mt-4 space-y-4">
									{/* Vector Store Section */}
									<div className="space-y-2">
										<label className="text-sm font-medium">
											{t("settings:codeIndex.vectorStoreProviderLabel")}
										</label>
										<Select
											value={currentSettings.codebaseIndexVectorStoreProvider}
											onValueChange={(value: VectorStoreProvider) => {
												updateSetting("codebaseIndexVectorStoreProvider", value)

												if (
													value === "lancedb" &&
													!currentSettings.codebaseIndexLocalIndexPath
												) {
													updateSetting(
														"codebaseIndexLocalIndexPath",
														DEFAULT_LOCAL_INDEX_PATH,
													)
												}

												if (value === "qdrant" && !currentSettings.codebaseIndexQdrantUrl) {
													updateSetting("codebaseIndexQdrantUrl", DEFAULT_QDRANT_URL)
												}
											}}>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="lancedb">
													{t("settings:codeIndex.lancedbVectorStore")}
												</SelectItem>
												<SelectItem value="qdrant">
													{t("settings:codeIndex.qdrantVectorStore")}
												</SelectItem>
											</SelectContent>
										</Select>
									</div>

									{/* Embedder Provider Section */}
									<div className="space-y-2">
										<label className="text-sm font-medium">
											{t("settings:codeIndex.embedderProviderLabel")}
										</label>
										<Select
											value={
												isSupportedCodebaseIndexEmbedderProvider(
													currentSettings.codebaseIndexEmbedderProvider,
												)
													? currentSettings.codebaseIndexEmbedderProvider
													: ""
											}
											onValueChange={(value) => {
												if (!isSupportedCodebaseIndexEmbedderProvider(value)) return

												updateSetting("codebaseIndexEmbedderProvider", value)
												updateSetting(
													"codebaseIndexEmbedderModelId",
													embeddingDefaultModels[value],
												)
												updateSetting("codebaseIndexEmbedderModelDimension", undefined)

												if (value === "vertex" && apiConfiguration?.apiProvider === "vertex") {
													const vertexFallbacks: Partial<LocalCodeIndexSettings> = {
														codebaseIndexVertexProjectId:
															apiConfiguration.projectId ||
															apiConfiguration.vertexProjectId,
														codebaseIndexVertexRegion:
															apiConfiguration.location || apiConfiguration.vertexRegion,
														codebaseIndexVertexKeyFile: apiConfiguration.vertexKeyFile,
													}

													Object.entries(vertexFallbacks).forEach(([key, fallbackValue]) => {
														const settingKey = key as keyof LocalCodeIndexSettings
														if (!currentSettings[settingKey] && fallbackValue) {
															updateSetting(settingKey, fallbackValue)
														}
													})
												}
											}}>
											<SelectTrigger className="w-full">
												<SelectValue placeholder={t("settings:common.select")} />
											</SelectTrigger>
											<SelectContent>
												{embedderProviders.map((provider) => (
													<SelectItem key={provider} value={provider}>
														{provider === "vertex"
															? t("settings:codeIndex.vertexProvider")
															: provider === "gemini"
																? t("settings:codeIndex.geminiProvider")
																: t(
																		`settings:codeIndex.embeddingProviders.${provider}`,
																	)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									{currentSettings.codebaseIndexEmbedderProvider === "vertex" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.googleCloudProjectId")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexVertexProjectId || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexVertexProjectId", e.target.value)
													}
													placeholder={t("settings:placeholders.projectId")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexVertexProjectId,
													})}
												/>
												{formErrors.codebaseIndexVertexProjectId && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVertexProjectId}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.googleCloudRegion")}
												</label>
												<Select
													value={currentSettings.codebaseIndexVertexRegion || ""}
													onValueChange={(value) =>
														updateSetting("codebaseIndexVertexRegion", value)
													}>
													<SelectTrigger
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexVertexRegion,
														})}>
														<SelectValue placeholder={t("settings:common.select")} />
													</SelectTrigger>
													<SelectContent>
														{VERTEX_REGIONS.map(({ value, label }) => (
															<SelectItem key={value} value={value}>
																{label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												{formErrors.codebaseIndexVertexRegion && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVertexRegion}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.googleCloudCredentials")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexVertexJsonCredentials || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVertexJsonCredentials",
															e.target.value,
														)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexVertexJsonCredentials",
														"settings:placeholders.credentialsJson",
													)}
													className="w-full"
												/>
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.googleCloudKeyFile")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexVertexKeyFile || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexVertexKeyFile", e.target.value)
													}
													placeholder={t("settings:placeholders.keyFilePath")}
													className="w-full"
												/>
											</div>
										</>
									)}
									{["openai-native", "openai", "openrouter", "bedrock"].includes(
										currentSettings.codebaseIndexEmbedderProvider,
									) &&
										(() => {
											const provider = currentSettings.codebaseIndexEmbedderProvider
											if (
												!isSupportedCodebaseIndexEmbedderProvider(provider) ||
												provider === "vertex" ||
												provider === "gemini"
											)
												return null
											const field = embeddingApiKeyFields[provider]
											return (
												<div className="space-y-2">
													<label className="text-sm font-medium" htmlFor="embedding-api-key">
														{t("settings:codeIndex.embeddingApiKeyLabel")}
													</label>
													<VSCodeTextField
														id="embedding-api-key"
														type="password"
														value={currentSettings[field] || ""}
														onInput={(e) =>
															updateSetting(field, (e.target as HTMLInputElement).value)
														}
														placeholder={getSecretPlaceholder(
															field,
															"settings:codeIndex.embeddingApiKeyPlaceholder",
														)}
														className="w-full"
													/>
													{hasSavedSecret(field) && !currentSettings[field] && (
														<p
															role="status"
															className="text-xs text-vscode-descriptionForeground m-0">
															{t("settings:codeIndex.embeddingApiKeySaved")}
														</p>
													)}
													{formErrors[field] && (
														<p className="text-xs text-vscode-errorForeground">
															{formErrors[field]}
														</p>
													)}
													{(provider === "openai" || provider === "bedrock") && (
														<p className="text-xs text-vscode-descriptionForeground">
															{t(
																provider === "bedrock"
																	? "settings:codeIndex.bedrockAuthenticationDescription"
																	: "settings:codeIndex.compatibleAuthenticationDescription",
															)}
														</p>
													)}
												</div>
											)
										})()}
									{currentSettings.codebaseIndexEmbedderProvider === "openai" && (
										<div className="space-y-2">
											<label className="text-sm font-medium">
												{t("settings:codeIndex.embeddingBaseUrlLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexOpenAiCompatibleBaseUrl || ""}
												aria-label={t("settings:codeIndex.embeddingBaseUrlLabel")}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexOpenAiCompatibleBaseUrl",
														(e.target as HTMLInputElement).value,
													)
												}
												placeholder={t("settings:placeholders.baseUrl")}
												className="w-full"
											/>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.embeddingModelIdLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexEmbedderModelId}
												placeholder={t("settings:codeIndex.embeddingModelIdLabel")}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexEmbedderModelId",
														(e.target as HTMLInputElement).value,
													)
												}
												aria-label={t("settings:codeIndex.embeddingModelIdLabel")}
												className="w-full"
											/>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.embeddingDimensionLabel")}
											</label>
											<VSCodeTextField
												inputMode="numeric"
												placeholder={t("settings:codeIndex.embeddingDimensionLabel")}
												value={
													currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
													""
												}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexEmbedderModelDimension",
														(e.target as HTMLInputElement).value
															? Number((e.target as HTMLInputElement).value)
															: undefined,
													)
												}
												aria-label={t("settings:codeIndex.embeddingDimensionLabel")}
												className="w-full"
											/>
											{[
												"codebaseIndexOpenAiCompatibleBaseUrl",
												"codebaseIndexEmbedderModelId",
												"codebaseIndexEmbedderModelDimension",
											].map(
												(field) =>
													formErrors[field] && (
														<p key={field} className="text-xs text-vscode-errorForeground">
															{formErrors[field]}
														</p>
													),
											)}
										</div>
									)}
									{currentSettings.codebaseIndexEmbedderProvider === "bedrock" && (
										<div className="space-y-2">
											<label className="text-sm font-medium">
												{t("settings:codeIndex.bedrockRegionLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexBedrockRegion || "us-east-1"}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexBedrockRegion",
														(e.target as HTMLInputElement).value,
													)
												}
												aria-label={t("settings:codeIndex.bedrockRegionLabel")}
												className="w-full"
											/>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.bedrockProfileLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexBedrockProfile || ""}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexBedrockProfile",
														(e.target as HTMLInputElement).value,
													)
												}
												aria-label={t("settings:codeIndex.bedrockProfileLabel")}
												className="w-full"
											/>
											{formErrors.codebaseIndexBedrockRegion && (
												<p className="text-xs text-vscode-errorForeground">
													{formErrors.codebaseIndexBedrockRegion}
												</p>
											)}
										</div>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "gemini" && (
										<div className="space-y-2">
											<label htmlFor="code-index-gemini-key" className="text-sm font-medium">
												{t("settings:codeIndex.geminiApiKeyLabel")}
											</label>
											<VSCodeTextField
												id="code-index-gemini-key"
												type="password"
												value={currentSettings.codebaseIndexGeminiApiKey || ""}
												onInput={(e) =>
													updateSetting(
														"codebaseIndexGeminiApiKey",
														(e.target as HTMLInputElement).value,
													)
												}
												placeholder={getSecretPlaceholder(
													"codebaseIndexGeminiApiKey",
													"settings:codeIndex.geminiApiKeyPlaceholder",
												)}
												className="w-full"
											/>
											{hasSavedSecret("codebaseIndexGeminiApiKey") &&
												!currentSettings.codebaseIndexGeminiApiKey && (
													<p
														role="status"
														className="text-xs text-vscode-descriptionForeground m-0">
														{t("settings:codeIndex.geminiApiKeySaved")}
													</p>
												)}
											{formErrors.codebaseIndexGeminiApiKey && (
												<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
													{formErrors.codebaseIndexGeminiApiKey}
												</p>
											)}
										</div>
									)}
									{currentSettings.codebaseIndexEmbedderProvider !== "openai" &&
										isSupportedCodebaseIndexEmbedderProvider(
											currentSettings.codebaseIndexEmbedderProvider,
										) && (
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.modelLabel")}
												</label>
												<VSCodeDropdown
													value={currentSettings.codebaseIndexEmbedderModelId}
													onChange={(e: any) =>
														updateSetting("codebaseIndexEmbedderModelId", e.target.value)
													}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexEmbedderModelId,
													})}>
													<VSCodeOption value="" className="p-2">
														{t("settings:codeIndex.selectModel")}
													</VSCodeOption>
													{getAvailableModels().map((modelId) => {
														const model = getModelProfile(modelId)
														return (
															<VSCodeOption key={modelId} value={modelId} className="p-2">
																{modelId}{" "}
																{model
																	? t("settings:codeIndex.modelDimensions", {
																			dimension: model.dimension,
																		})
																	: ""}
															</VSCodeOption>
														)
													})}
												</VSCodeDropdown>
												{formErrors.codebaseIndexEmbedderModelId && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderModelId}
													</p>
												)}
											</div>
										)}

									{/* Vector Store Settings */}
									{currentSettings.codebaseIndexVectorStoreProvider === "qdrant" ? (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.qdrantUrlLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexQdrantUrl || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexQdrantUrl", e.target.value)
													}
													onBlur={(e: any) => {
														if (!e.target.value.trim()) {
															updateSetting("codebaseIndexQdrantUrl", DEFAULT_QDRANT_URL)
														}
													}}
													placeholder={t("settings:codeIndex.qdrantUrlPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexQdrantUrl,
													})}
												/>
												{formErrors.codebaseIndexQdrantUrl && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexQdrantUrl}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.qdrantApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codeIndexQdrantApiKey || ""}
													onInput={(e: any) =>
														updateSetting("codeIndexQdrantApiKey", e.target.value)
													}
													placeholder={getSecretPlaceholder(
														"codeIndexQdrantApiKey",
														"settings:codeIndex.qdrantApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codeIndexQdrantApiKey,
													})}
												/>
												{formErrors.codeIndexQdrantApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codeIndexQdrantApiKey}
													</p>
												)}
											</div>
										</>
									) : (
										<div className="space-y-2">
											<label className="text-sm font-medium">
												{t("settings:codeIndex.localIndexPathLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexLocalIndexPath || ""}
												onInput={(e: any) =>
													updateSetting("codebaseIndexLocalIndexPath", e.target.value)
												}
												onBlur={(e: any) => {
													if (!e.target.value.trim()) {
														updateSetting(
															"codebaseIndexLocalIndexPath",
															DEFAULT_LOCAL_INDEX_PATH,
														)
													}
												}}
												placeholder={t("settings:codeIndex.localIndexPathPlaceholder")}
												className={cn("w-full", {
													"border-red-500": formErrors.codebaseIndexLocalIndexPath,
												})}
											/>
											{formErrors.codebaseIndexLocalIndexPath && (
												<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
													{formErrors.codebaseIndexLocalIndexPath}
												</p>
											)}
											<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
												{t("settings:codeIndex.localIndexPathDescription")}
											</p>
										</div>
									)}
								</div>
							)}
						</div>

						{/* Advanced Settings Disclosure */}
						<div className="mt-4">
							<button
								onClick={() => setIsAdvancedSettingsOpen(!isAdvancedSettingsOpen)}
								className="flex items-center text-xs text-vscode-foreground hover:text-vscode-textLink-foreground focus:outline-none"
								aria-expanded={isAdvancedSettingsOpen}>
								<span
									className={`codicon codicon-${isAdvancedSettingsOpen ? "chevron-down" : "chevron-right"} mr-1`}></span>
								<span className="text-base font-semibold">
									{t("settings:codeIndex.advancedConfigLabel")}
								</span>
							</button>

							{isAdvancedSettingsOpen && (
								<div className="mt-4 space-y-4">
									{/* Semantic Similarity Threshold Slider */}
									<div className="space-y-2">
										<div className="flex items-center gap-2">
											<label className="text-sm font-medium">
												{t("settings:codeIndex.searchMinScoreLabel")}
											</label>
											<StandardTooltip
												content={t("settings:codeIndex.searchMinScoreDescription")}>
												<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
											</StandardTooltip>
										</div>
										<div className="flex items-center gap-2">
											<Slider
												aria-label={t("settings:codeIndex.searchMinScoreLabel")}
												min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_SCORE}
												max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_SCORE}
												step={CODEBASE_INDEX_DEFAULTS.SEARCH_SCORE_STEP}
												value={[
													currentSettings.codebaseIndexSearchMinScore ??
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
												]}
												onValueChange={(values) =>
													updateSetting("codebaseIndexSearchMinScore", values[0])
												}
												className="flex-1"
												data-testid="search-min-score-slider"
											/>
											<span className="w-12 text-center">
												{(
													currentSettings.codebaseIndexSearchMinScore ??
													CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
												).toFixed(2)}
											</span>
											<VSCodeButton
												appearance="icon"
												title={t("settings:codeIndex.resetToDefault")}
												onClick={() =>
													updateSetting(
														"codebaseIndexSearchMinScore",
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
													)
												}>
												<span className="codicon codicon-discard" />
											</VSCodeButton>
										</div>
									</div>

									{/* Maximum Search Results Slider */}
									<div className="space-y-2">
										<div className="flex items-center gap-2">
											<label className="text-sm font-medium">
												{t("settings:codeIndex.searchMaxResultsLabel")}
											</label>
											<StandardTooltip
												content={t("settings:codeIndex.searchMaxResultsDescription")}>
												<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
											</StandardTooltip>
										</div>
										<div className="flex items-center gap-2">
											<Slider
												aria-label={t("settings:codeIndex.searchMaxResultsLabel")}
												min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS}
												max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS}
												step={CODEBASE_INDEX_DEFAULTS.SEARCH_RESULTS_STEP}
												value={[
													currentSettings.codebaseIndexSearchMaxResults ??
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
												]}
												onValueChange={(values) =>
													updateSetting("codebaseIndexSearchMaxResults", values[0])
												}
												className="flex-1"
												data-testid="search-max-results-slider"
											/>
											<span className="w-12 text-center">
												{currentSettings.codebaseIndexSearchMaxResults ??
													CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS}
											</span>
											<VSCodeButton
												appearance="icon"
												title={t("settings:codeIndex.resetToDefault")}
												onClick={() =>
													updateSetting(
														"codebaseIndexSearchMaxResults",
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
													)
												}>
												<span className="codicon codicon-discard" />
											</VSCodeButton>
										</div>
									</div>

									{/* Embedding Rate Limit */}
									<div className="space-y-2">
										<div className="flex items-center gap-2">
											<VSCodeCheckbox
												checked={
													currentSettings.codebaseIndexEmbeddingRateLimitEnabled ?? false
												}
												onChange={(e: any) =>
													updateSetting(
														"codebaseIndexEmbeddingRateLimitEnabled",
														e.target.checked,
													)
												}>
												{t("settings:codeIndex.embeddingRateLimitLabel")}
											</VSCodeCheckbox>
											<StandardTooltip
												content={t("settings:codeIndex.embeddingRateLimitDescription")}>
												<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
											</StandardTooltip>
										</div>
										<div className="flex items-center gap-2">
											<Slider
												min={CODEBASE_INDEX_DEFAULTS.MIN_EMBEDDING_RATE_LIMIT_SECONDS}
												max={CODEBASE_INDEX_DEFAULTS.MAX_EMBEDDING_RATE_LIMIT_SECONDS}
												step={CODEBASE_INDEX_DEFAULTS.EMBEDDING_RATE_LIMIT_STEP}
												value={[
													currentSettings.codebaseIndexEmbeddingRateLimitSeconds ??
														CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
												]}
												onValueChange={(values) =>
													updateSetting("codebaseIndexEmbeddingRateLimitSeconds", values[0])
												}
												disabled={!currentSettings.codebaseIndexEmbeddingRateLimitEnabled}
												className="flex-1"
												data-testid="embedding-rate-limit-slider"
											/>
											<span className="w-16 text-center">
												{(
													currentSettings.codebaseIndexEmbeddingRateLimitSeconds ??
													CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS
												).toFixed(1)}
												s
											</span>
											<VSCodeButton
												appearance="icon"
												title={t("settings:codeIndex.resetToDefault")}
												disabled={!currentSettings.codebaseIndexEmbeddingRateLimitEnabled}
												onClick={() =>
													updateSetting(
														"codebaseIndexEmbeddingRateLimitSeconds",
														CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
													)
												}>
												<span className="codicon codicon-discard" />
											</VSCodeButton>
										</div>
									</div>
								</div>
							)}
						</div>

						{/* Auto-enable default */}
						{currentSettings.codebaseIndexEnabled && (
							<div className="flex items-center gap-2 pt-4 pb-1">
								<input
									type="checkbox"
									id="auto-enable-default-toggle"
									checked={indexingStatus.autoEnableDefault ?? true}
									onChange={(e) => {
										const enabled = e.target.checked
										setIndexingStatus((prev) => ({ ...prev, autoEnableDefault: enabled }))
										vscode.postMessage({
											type: "setAutoEnableDefault",
											bool: enabled,
										})
									}}
									className="accent-vscode-focusBorder"
								/>
								<label
									htmlFor="auto-enable-default-toggle"
									className="text-xs text-vscode-foreground cursor-pointer">
									{t("settings:codeIndex.autoEnableDefaultLabel")}
								</label>
							</div>
						)}

						{/* Workspace Toggle */}
						{currentSettings.codebaseIndexEnabled && (
							<div className="flex items-center gap-2 pt-1 pb-2">
								<input
									type="checkbox"
									id="workspace-indexing-toggle"
									checked={indexingStatus.workspaceEnabled ?? false}
									onChange={(e) => {
										const enabled = e.target.checked
										setIndexingStatus((prev) => ({ ...prev, workspaceEnabled: enabled }))
										vscode.postMessage({
											type: "toggleWorkspaceIndexing",
											bool: enabled,
										})
									}}
									className="accent-vscode-focusBorder"
								/>
								<label
									htmlFor="workspace-indexing-toggle"
									className="text-xs text-vscode-foreground cursor-pointer">
									{t("settings:codeIndex.workspaceToggleLabel")}
								</label>
							</div>
						)}

						{currentSettings.codebaseIndexEnabled && !indexingStatus.workspaceEnabled && (
							<p className="text-xs text-vscode-descriptionForeground pb-2">
								{t("settings:codeIndex.workspaceDisabledMessage")}
							</p>
						)}

						{/* Action Buttons */}
						<div className="flex items-center justify-between gap-2 pt-6">
							<div className="flex gap-2">
								{currentSettings.codebaseIndexEnabled &&
									(indexingStatus.systemStatus === "Error" ||
										indexingStatus.systemStatus === "Standby") && (
										<Button
											onClick={() => vscode.postMessage({ type: "startIndexing" })}
											disabled={saveStatus === "saving" || hasUnsavedChanges}>
											{t("settings:codeIndex.startIndexingButton")}
										</Button>
									)}

								{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Indexing" && (
									<Button
										variant="destructive"
										onClick={() => vscode.postMessage({ type: "stopIndexing" })}>
										{t("settings:codeIndex.stopIndexingButton")}
									</Button>
								)}

								{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Stopping" && (
									<Button variant="destructive" disabled>
										{t("settings:codeIndex.stoppingButton")}
									</Button>
								)}

								{currentSettings.codebaseIndexEnabled &&
									(indexingStatus.systemStatus === "Indexed" ||
										indexingStatus.systemStatus === "Error") && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button variant="secondary">
													{t("settings:codeIndex.clearIndexDataButton")}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														{t("settings:codeIndex.clearDataDialog.title")}
													</AlertDialogTitle>
													<AlertDialogDescription>
														{t("settings:codeIndex.clearDataDialog.description")}
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>
														{t("settings:codeIndex.clearDataDialog.cancelButton")}
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => vscode.postMessage({ type: "clearIndexData" })}>
														{t("settings:codeIndex.clearDataDialog.confirmButton")}
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}
							</div>

							<Button
								onClick={handleSaveSettings}
								disabled={!hasUnsavedChanges || saveStatus === "saving"}>
								{saveStatus === "saving"
									? t("settings:codeIndex.saving")
									: t("settings:codeIndex.saveSettings")}
							</Button>
						</div>

						{/* Save Status Messages */}
						{saveStatus === "error" && (
							<div className="mt-2">
								<span className="text-sm text-vscode-errorForeground block">
									{saveError || t("settings:codeIndex.saveError")}
								</span>
							</div>
						)}
					</div>
				</PopoverContent>
			</Popover>

			{/* Discard Changes Dialog */}
			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
