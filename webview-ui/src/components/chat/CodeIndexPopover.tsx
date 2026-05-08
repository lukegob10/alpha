import React, { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Trans } from "react-i18next"
import { z } from "zod"
import {
	VSCodeButton,
	VSCodeTextField,
	VSCodeTextArea,
	VSCodeDropdown,
	VSCodeOption,
	VSCodeLink,
	VSCodeCheckbox,
} from "@vscode/webview-ui-toolkit/react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { AlertTriangle } from "lucide-react"

import { type IndexingStatus, type EmbedderProvider, CODEBASE_INDEX_DEFAULTS, VERTEX_REGIONS } from "@alpha-code/types"

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
import {
	useOpenRouterModelProviders,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
} from "@src/components/ui/hooks/useOpenRouterModelProviders"

// Default URLs for providers
const DEFAULT_QDRANT_URL = "http://localhost:6333"
const DEFAULT_LOCAL_INDEX_PATH = ".alpha/code-index/lancedb"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"
const DEFAULT_VERTEX_MODEL = "gemini-embedding-001"
const DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND = "helix auth access-token print -a"

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
	codebaseIndexEmbedderProvider: EmbedderProvider
	codebaseIndexEmbedderBaseUrl?: string
	codebaseIndexEmbedderModelId: string
	codebaseIndexEmbedderModelDimension?: number // Generic dimension for all providers
	codebaseIndexSearchMaxResults?: number
	codebaseIndexSearchMinScore?: number
	codebaseIndexEmbeddingRateLimitEnabled?: boolean
	codebaseIndexEmbeddingRateLimitSeconds?: number

	// Bedrock-specific settings
	codebaseIndexBedrockRegion?: string
	codebaseIndexBedrockProfile?: string

	// Vertex-specific settings
	codebaseIndexVertexProjectId?: string
	codebaseIndexVertexRegion?: string
	codebaseIndexVertexKeyFile?: string
	codebaseIndexVertexGatewayBaseUrl?: string
	codebaseIndexVertexGatewayCaBundlePath?: string
	codebaseIndexVertexGatewayHelixCommand?: string
	codebaseIndexVertexGatewayTokenRefreshMinutes?: number
	codebaseIndexVertexGatewayModelRoutingMap?: string

	// Secret settings (start empty, will be loaded separately)
	codeIndexOpenAiKey?: string
	codeIndexQdrantApiKey?: string
	codebaseIndexOpenAiCompatibleBaseUrl?: string
	codebaseIndexOpenAiCompatibleApiKey?: string
	codebaseIndexGeminiApiKey?: string
	codebaseIndexVertexJsonCredentials?: string
	codebaseIndexMistralApiKey?: string
	codebaseIndexVercelAiGatewayApiKey?: string
	codebaseIndexOpenRouterApiKey?: string
	codebaseIndexOpenRouterSpecificProvider?: string
}

const secretStatusKeyByField = {
	codeIndexOpenAiKey: "hasOpenAiKey",
	codeIndexQdrantApiKey: "hasQdrantApiKey",
	codebaseIndexOpenAiCompatibleApiKey: "hasOpenAiCompatibleApiKey",
	codebaseIndexGeminiApiKey: "hasGeminiApiKey",
	codebaseIndexVertexJsonCredentials: "hasVertexJsonCredentials",
	codebaseIndexMistralApiKey: "hasMistralApiKey",
	codebaseIndexVercelAiGatewayApiKey: "hasVercelAiGatewayApiKey",
	codebaseIndexOpenRouterApiKey: "hasOpenRouterApiKey",
} as const

type SecretField = keyof typeof secretStatusKeyByField
type SavedSecretStatus = Record<SecretField, boolean>

const emptySavedSecretStatus = (): SavedSecretStatus =>
	Object.fromEntries(Object.keys(secretStatusKeyByField).map((field) => [field, false])) as SavedSecretStatus

const optionalUrlSchema = (message: string) =>
	z
		.string()
		.refine((value) => !value || z.string().url().safeParse(value).success, message)
		.optional()

const isValidVertexGatewayModelRoutingMap = (value: string | undefined): boolean => {
	if (!value?.trim()) {
		return true
	}

	try {
		const parsed = JSON.parse(value)

		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			Object.entries(parsed).every(
				([key, route]) => key.trim().length > 0 && typeof route === "string" && route.trim().length > 0,
			)
		)
	} catch {
		return false
	}
}

// Validation schema for codebase index settings
const createValidationSchema = (provider: EmbedderProvider, vectorStoreProvider: VectorStoreProvider, t: any) => {
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

	switch (provider) {
		case "openai":
			return baseSchema.extend({
				codeIndexOpenAiKey: z.string().min(1, t("settings:codeIndex.validation.openaiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "ollama":
			return baseSchema.extend({
				codebaseIndexEmbedderBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.ollamaBaseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidOllamaUrl")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired"))
					.optional(),
			})

		case "openai-compatible":
			return baseSchema.extend({
				codebaseIndexOpenAiCompatibleBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.baseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidBaseUrl")),
				codebaseIndexOpenAiCompatibleApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.apiKeyRequired")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired")),
			})

		case "gemini":
			return baseSchema.extend({
				codebaseIndexGeminiApiKey: z.string().min(1, t("settings:codeIndex.validation.geminiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "vertex":
			return baseSchema.extend({
				codebaseIndexVertexProjectId: z
					.string()
					.min(1, t("settings:codeIndex.validation.vertexProjectIdRequired")),
				codebaseIndexVertexRegion: z.string().min(1, t("settings:codeIndex.validation.vertexRegionRequired")),
				codebaseIndexVertexJsonCredentials: z.string().optional(),
				codebaseIndexVertexKeyFile: z.string().optional(),
				codebaseIndexVertexGatewayBaseUrl: optionalUrlSchema(
					t("settings:codeIndex.validation.invalidVertexGatewayBaseUrl"),
				),
				codebaseIndexVertexGatewayCaBundlePath: z.string().optional(),
				codebaseIndexVertexGatewayHelixCommand: z.string().optional(),
				codebaseIndexVertexGatewayTokenRefreshMinutes: z
					.number()
					.int()
					.positive(t("settings:codeIndex.validation.vertexGatewayTokenRefreshMinutesRequired"))
					.optional(),
				codebaseIndexVertexGatewayModelRoutingMap: z
					.string()
					.optional()
					.refine(
						isValidVertexGatewayModelRoutingMap,
						t("settings:codeIndex.validation.vertexGatewayModelRoutingMap"),
					),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "mistral":
			return baseSchema.extend({
				codebaseIndexMistralApiKey: z.string().min(1, t("settings:codeIndex.validation.mistralApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "vercel-ai-gateway":
			return baseSchema.extend({
				codebaseIndexVercelAiGatewayApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.vercelAiGatewayApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "bedrock":
			return baseSchema.extend({
				codebaseIndexBedrockRegion: z.string().min(1, t("settings:codeIndex.validation.bedrockRegionRequired")),
				codebaseIndexBedrockProfile: z.string().optional(),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "openrouter":
			return baseSchema.extend({
				codebaseIndexOpenRouterApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.openRouterApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		default:
			return baseSchema
	}
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
		codebaseIndexEmbedderProvider: "openai",
		codebaseIndexEmbedderBaseUrl: "",
		codebaseIndexEmbedderModelId: "",
		codebaseIndexEmbedderModelDimension: undefined,
		codebaseIndexSearchMaxResults: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
		codebaseIndexSearchMinScore: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
		codebaseIndexEmbeddingRateLimitEnabled: false,
		codebaseIndexEmbeddingRateLimitSeconds: CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
		codebaseIndexBedrockRegion: "",
		codebaseIndexBedrockProfile: "",
		codebaseIndexVertexProjectId: "",
		codebaseIndexVertexRegion: "",
		codebaseIndexVertexKeyFile: "",
		codebaseIndexVertexGatewayBaseUrl: "",
		codebaseIndexVertexGatewayCaBundlePath: "",
		codebaseIndexVertexGatewayHelixCommand: "",
		codebaseIndexVertexGatewayTokenRefreshMinutes: undefined,
		codebaseIndexVertexGatewayModelRoutingMap: "",
		codeIndexOpenAiKey: "",
		codeIndexQdrantApiKey: "",
		codebaseIndexOpenAiCompatibleBaseUrl: "",
		codebaseIndexOpenAiCompatibleApiKey: "",
		codebaseIndexGeminiApiKey: "",
		codebaseIndexVertexJsonCredentials: "",
		codebaseIndexMistralApiKey: "",
		codebaseIndexVercelAiGatewayApiKey: "",
		codebaseIndexOpenRouterApiKey: "",
		codebaseIndexOpenRouterSpecificProvider: "",
	})

	// Initial settings state - stores the settings when popover opens
	const [initialSettings, setInitialSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Current settings state - tracks user changes
	const [currentSettings, setCurrentSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

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
		if (codebaseIndexConfig) {
			const embedderProvider = codebaseIndexConfig.codebaseIndexEmbedderProvider || "openai"
			const activeVertexConfig = apiConfiguration?.apiProvider === "vertex" ? apiConfiguration : undefined
			const settings = {
				codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? true,
				codebaseIndexVectorStoreProvider: codebaseIndexConfig.codebaseIndexVectorStoreProvider || "lancedb",
				codebaseIndexLocalIndexPath:
					codebaseIndexConfig.codebaseIndexLocalIndexPath || DEFAULT_LOCAL_INDEX_PATH,
				codebaseIndexQdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl || "",
				codebaseIndexEmbedderProvider: embedderProvider,
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig.codebaseIndexEmbedderBaseUrl || "",
				codebaseIndexEmbedderModelId:
					codebaseIndexConfig.codebaseIndexEmbedderModelId ||
					(embedderProvider === "vertex" ? DEFAULT_VERTEX_MODEL : ""),
				codebaseIndexEmbedderModelDimension:
					codebaseIndexConfig.codebaseIndexEmbedderModelDimension || undefined,
				codebaseIndexSearchMaxResults:
					codebaseIndexConfig.codebaseIndexSearchMaxResults ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
				codebaseIndexSearchMinScore:
					codebaseIndexConfig.codebaseIndexSearchMinScore ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
				codebaseIndexEmbeddingRateLimitEnabled:
					codebaseIndexConfig.codebaseIndexEmbeddingRateLimitEnabled ?? false,
				codebaseIndexEmbeddingRateLimitSeconds:
					codebaseIndexConfig.codebaseIndexEmbeddingRateLimitSeconds ??
					CODEBASE_INDEX_DEFAULTS.DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS,
				codebaseIndexBedrockRegion: codebaseIndexConfig.codebaseIndexBedrockRegion || "",
				codebaseIndexBedrockProfile: codebaseIndexConfig.codebaseIndexBedrockProfile || "",
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
				codebaseIndexVertexGatewayBaseUrl:
					codebaseIndexConfig.codebaseIndexVertexGatewayBaseUrl ||
					activeVertexConfig?.gatewayBaseUrl ||
					activeVertexConfig?.vertexGatewayBaseUrl ||
					"",
				codebaseIndexVertexGatewayCaBundlePath:
					codebaseIndexConfig.codebaseIndexVertexGatewayCaBundlePath ||
					activeVertexConfig?.pemCaBundlePath ||
					activeVertexConfig?.vertexGatewayCaBundlePath ||
					"",
				codebaseIndexVertexGatewayHelixCommand:
					codebaseIndexConfig.codebaseIndexVertexGatewayHelixCommand ||
					activeVertexConfig?.helixCommand ||
					activeVertexConfig?.vertexGatewayHelixCommand ||
					"",
				codebaseIndexVertexGatewayTokenRefreshMinutes:
					codebaseIndexConfig.codebaseIndexVertexGatewayTokenRefreshMinutes ??
					activeVertexConfig?.refreshIntervalMinutes ??
					activeVertexConfig?.vertexGatewayTokenRefreshMinutes,
				codebaseIndexVertexGatewayModelRoutingMap:
					codebaseIndexConfig.codebaseIndexVertexGatewayModelRoutingMap ||
					(typeof activeVertexConfig?.modelRoutingMap === "string"
						? activeVertexConfig.modelRoutingMap
						: activeVertexConfig?.modelRoutingMap
							? JSON.stringify(activeVertexConfig.modelRoutingMap)
							: "") ||
					activeVertexConfig?.vertexGatewayModelRoutingMap ||
					"",
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl || "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexVertexJsonCredentials: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
				codebaseIndexOpenRouterSpecificProvider:
					codebaseIndexConfig.codebaseIndexOpenRouterSpecificProvider || "",
			}
			setInitialSettings(settings)
			setCurrentSettings(settings)

			// Request secret status to check if secrets exist
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
		}
	}, [apiConfiguration, codebaseIndexConfig])

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

	// Use a ref to capture current settings for the save handler
	const currentSettingsRef = useRef(currentSettings)
	currentSettingsRef.current = currentSettings

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
					setSaveStatus("saved")
					// Update initial settings to match current settings after successful save
					// This ensures hasUnsavedChanges becomes false
					const savedSettings = redactSavedSecrets({ ...currentSettingsRef.current })
					setInitialSettings(savedSettings)
					// Also update current settings to maintain consistency
					setCurrentSettings(savedSettings)
					// Request secret status to ensure we have the latest state
					// This is important to maintain placeholder display after save

					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })

					setSaveStatus("idle")
				} else {
					setSaveStatus("error")
					setSaveError(event.data.error || t("settings:codeIndex.saveError"))
					// Clear error message after 5 seconds
					setSaveStatus("idle")
					setSaveError(null)
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

				// Update both current and initial settings based on what secrets exist
				const updateWithSecrets = (prev: LocalCodeIndexSettings): LocalCodeIndexSettings => {
					const updated = { ...prev }

					// Only update saved-secret fields if the field is currently empty or already a legacy placeholder.
					// This preserves user input when they're actively editing
					if (!prev.codeIndexOpenAiKey || prev.codeIndexOpenAiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexOpenAiKey = ""
					}
					if (!prev.codeIndexQdrantApiKey || prev.codeIndexQdrantApiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexQdrantApiKey = ""
					}
					if (
						!prev.codebaseIndexOpenAiCompatibleApiKey ||
						prev.codebaseIndexOpenAiCompatibleApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenAiCompatibleApiKey = ""
					}
					if (!prev.codebaseIndexGeminiApiKey || prev.codebaseIndexGeminiApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexGeminiApiKey = ""
					}
					if (
						!prev.codebaseIndexVertexJsonCredentials ||
						prev.codebaseIndexVertexJsonCredentials === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexVertexJsonCredentials = ""
					}
					if (!prev.codebaseIndexMistralApiKey || prev.codebaseIndexMistralApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexMistralApiKey = ""
					}
					if (
						!prev.codebaseIndexVercelAiGatewayApiKey ||
						prev.codebaseIndexVercelAiGatewayApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexVercelAiGatewayApiKey = ""
					}
					if (
						!prev.codebaseIndexOpenRouterApiKey ||
						prev.codebaseIndexOpenRouterApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenRouterApiKey = ""
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

	// Generic comparison function that detects changes between initial and current settings
	const hasUnsavedChanges = useMemo(() => {
		// Get all keys from both objects to handle any field
		const allKeys = [...Object.keys(initialSettings), ...Object.keys(currentSettings)] as Array<
			keyof LocalCodeIndexSettings
		>

		// Use a Set to ensure unique keys
		const uniqueKeys = Array.from(new Set(allKeys))

		for (const key of uniqueKeys) {
			const currentValue = currentSettings[key]
			const initialValue = initialSettings[key]

			// For secret fields, check if the value has been modified from placeholder
			if (currentValue === SECRET_PLACEHOLDER) {
				// If it's still showing placeholder, no change
				continue
			}

			// Compare values - handles all types including undefined
			if (currentValue !== initialValue) {
				return true
			}
		}

		return false
	}, [currentSettings, initialSettings])

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
			currentSettings.codebaseIndexEmbedderProvider,
			currentSettings.codebaseIndexVectorStoreProvider,
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
				// Add a dummy value that will pass validation for these fields
				if (
					key === "codeIndexOpenAiKey" ||
					key === "codebaseIndexOpenAiCompatibleApiKey" ||
					key === "codebaseIndexGeminiApiKey" ||
					key === "codebaseIndexVertexJsonCredentials" ||
					key === "codebaseIndexMistralApiKey" ||
					key === "codebaseIndexVercelAiGatewayApiKey" ||
					key === "codebaseIndexOpenRouterApiKey"
				) {
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

		// Prepare settings to save
		const settingsToSave: any = {}

		// Iterate through all current settings
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder, don't send the placeholder
			// but also don't send an empty string - just skip the field
			// This tells the backend to keep the existing secret
			const secretField = key as SecretField
			if (
				value === SECRET_PLACEHOLDER ||
				(key in secretStatusKeyByField && value === "" && savedSecretStatus[secretField])
			) {
				// Skip sending placeholder values - backend will preserve existing secrets
				continue
			}

			// Include all other fields, including empty strings (which clear secrets)
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
		if (!codebaseIndexModels) return []

		const models =
			codebaseIndexModels[currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels]
		return models ? Object.keys(models) : []
	}

	// Fetch OpenRouter model providers for embedding model
	const { data: openRouterEmbeddingProviders } = useOpenRouterModelProviders(
		currentSettings.codebaseIndexEmbedderProvider === "openrouter"
			? currentSettings.codebaseIndexEmbedderModelId
			: undefined,
		undefined,
		{
			enabled:
				currentSettings.codebaseIndexEmbedderProvider === "openrouter" &&
				!!currentSettings.codebaseIndexEmbedderModelId,
		},
	)

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
					side="bottom"
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
											value={currentSettings.codebaseIndexEmbedderProvider}
											onValueChange={(value: EmbedderProvider) => {
												updateSetting("codebaseIndexEmbedderProvider", value)
												updateSetting(
													"codebaseIndexEmbedderModelId",
													value === "vertex" ? DEFAULT_VERTEX_MODEL : "",
												)

												// Auto-populate Region and Profile when switching to Bedrock
												// if the main API provider is also configured for Bedrock
												if (
													value === "bedrock" &&
													apiConfiguration?.apiProvider === "bedrock"
												) {
													// Only populate if currently empty
													if (
														!currentSettings.codebaseIndexBedrockRegion &&
														apiConfiguration.awsRegion
													) {
														updateSetting(
															"codebaseIndexBedrockRegion",
															apiConfiguration.awsRegion,
														)
													}
													if (
														!currentSettings.codebaseIndexBedrockProfile &&
														apiConfiguration.awsProfile
													) {
														updateSetting(
															"codebaseIndexBedrockProfile",
															apiConfiguration.awsProfile,
														)
													}
												}

												if (value === "vertex" && apiConfiguration?.apiProvider === "vertex") {
													const routingMap =
														typeof apiConfiguration.modelRoutingMap === "string"
															? apiConfiguration.modelRoutingMap
															: apiConfiguration.modelRoutingMap
																? JSON.stringify(apiConfiguration.modelRoutingMap)
																: apiConfiguration.vertexGatewayModelRoutingMap

													const vertexFallbacks: Partial<LocalCodeIndexSettings> = {
														codebaseIndexVertexProjectId:
															apiConfiguration.projectId ||
															apiConfiguration.vertexProjectId,
														codebaseIndexVertexRegion:
															apiConfiguration.location || apiConfiguration.vertexRegion,
														codebaseIndexVertexKeyFile: apiConfiguration.vertexKeyFile,
														codebaseIndexVertexGatewayBaseUrl:
															apiConfiguration.gatewayBaseUrl ||
															apiConfiguration.vertexGatewayBaseUrl,
														codebaseIndexVertexGatewayCaBundlePath:
															apiConfiguration.pemCaBundlePath ||
															apiConfiguration.vertexGatewayCaBundlePath,
														codebaseIndexVertexGatewayHelixCommand:
															apiConfiguration.helixCommand ||
															apiConfiguration.vertexGatewayHelixCommand,
														codebaseIndexVertexGatewayTokenRefreshMinutes:
															apiConfiguration.refreshIntervalMinutes ??
															apiConfiguration.vertexGatewayTokenRefreshMinutes,
														codebaseIndexVertexGatewayModelRoutingMap: routingMap,
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
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="openai">
													{t("settings:codeIndex.openaiProvider")}
												</SelectItem>
												<SelectItem value="ollama">
													{t("settings:codeIndex.ollamaProvider")}
												</SelectItem>
												<SelectItem value="openai-compatible">
													{t("settings:codeIndex.openaiCompatibleProvider")}
												</SelectItem>
												<SelectItem value="gemini">
													{t("settings:codeIndex.geminiProvider")}
												</SelectItem>
												<SelectItem value="vertex">
													{t("settings:codeIndex.vertexProvider")}
												</SelectItem>
												<SelectItem value="mistral">
													{t("settings:codeIndex.mistralProvider")}
												</SelectItem>
												<SelectItem value="vercel-ai-gateway">
													{t("settings:codeIndex.vercelAiGatewayProvider")}
												</SelectItem>
												<SelectItem value="bedrock">
													{t("settings:codeIndex.bedrockProvider")}
												</SelectItem>
												<SelectItem value="openrouter">
													{t("settings:codeIndex.openRouterProvider")}
												</SelectItem>
											</SelectContent>
										</Select>
									</div>

									{/* Provider-specific settings */}
									{currentSettings.codebaseIndexEmbedderProvider === "openai" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.openAiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codeIndexOpenAiKey || ""}
													onInput={(e: any) =>
														updateSetting("codeIndexOpenAiKey", e.target.value)
													}
													placeholder={getSecretPlaceholder(
														"codeIndexOpenAiKey",
														"settings:codeIndex.openAiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codeIndexOpenAiKey,
													})}
												/>
												{formErrors.codeIndexOpenAiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codeIndexOpenAiKey}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "ollama" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.ollamaBaseUrlLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexEmbedderBaseUrl || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexEmbedderBaseUrl", e.target.value)
													}
													onBlur={(e: any) => {
														// Set default Ollama URL if field is empty
														if (!e.target.value.trim()) {
															e.target.value = DEFAULT_OLLAMA_URL
															updateSetting(
																"codebaseIndexEmbedderBaseUrl",
																DEFAULT_OLLAMA_URL,
															)
														}
													}}
													placeholder={t("settings:codeIndex.ollamaUrlPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexEmbedderBaseUrl,
													})}
												/>
												{formErrors.codebaseIndexEmbedderBaseUrl && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderBaseUrl}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.modelLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexEmbedderModelId || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexEmbedderModelId", e.target.value)
													}
													placeholder={t("settings:codeIndex.modelPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexEmbedderModelId,
													})}
												/>
												{formErrors.codebaseIndexEmbedderModelId && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderModelId}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.modelDimensionLabel")}
												</label>
												<VSCodeTextField
													value={
														currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
														""
													}
													onInput={(e: any) => {
														const value = e.target.value
															? parseInt(e.target.value, 10) || undefined
															: undefined
														updateSetting("codebaseIndexEmbedderModelDimension", value)
													}}
													placeholder={t("settings:codeIndex.modelDimensionPlaceholder")}
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexEmbedderModelDimension,
													})}
												/>
												{formErrors.codebaseIndexEmbedderModelDimension && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderModelDimension}
													</p>
												)}
											</div>
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "openai-compatible" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.openAiCompatibleBaseUrlLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexOpenAiCompatibleBaseUrl || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexOpenAiCompatibleBaseUrl",
															e.target.value,
														)
													}
													placeholder={t(
														"settings:codeIndex.openAiCompatibleBaseUrlPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexOpenAiCompatibleBaseUrl,
													})}
												/>
												{formErrors.codebaseIndexOpenAiCompatibleBaseUrl && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexOpenAiCompatibleBaseUrl}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.openAiCompatibleApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexOpenAiCompatibleApiKey || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexOpenAiCompatibleApiKey",
															e.target.value,
														)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexOpenAiCompatibleApiKey",
														"settings:codeIndex.openAiCompatibleApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexOpenAiCompatibleApiKey,
													})}
												/>
												{formErrors.codebaseIndexOpenAiCompatibleApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexOpenAiCompatibleApiKey}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.modelLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexEmbedderModelId || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexEmbedderModelId", e.target.value)
													}
													placeholder={t("settings:codeIndex.modelPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexEmbedderModelId,
													})}
												/>
												{formErrors.codebaseIndexEmbedderModelId && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderModelId}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.modelDimensionLabel")}
												</label>
												<VSCodeTextField
													value={
														currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
														""
													}
													onInput={(e: any) => {
														const value = e.target.value
															? parseInt(e.target.value, 10) || undefined
															: undefined
														updateSetting("codebaseIndexEmbedderModelDimension", value)
													}}
													placeholder={t("settings:codeIndex.modelDimensionPlaceholder")}
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexEmbedderModelDimension,
													})}
												/>
												{formErrors.codebaseIndexEmbedderModelDimension && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexEmbedderModelDimension}
													</p>
												)}
											</div>
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "gemini" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.geminiApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexGeminiApiKey || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexGeminiApiKey", e.target.value)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexGeminiApiKey",
														"settings:codeIndex.geminiApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexGeminiApiKey,
													})}
												/>
												{formErrors.codebaseIndexGeminiApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexGeminiApiKey}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

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

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.vertexGatewayBaseUrl")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexVertexGatewayBaseUrl || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVertexGatewayBaseUrl",
															e.target.value,
														)
													}
													placeholder={t("settings:placeholders.baseUrl")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexVertexGatewayBaseUrl,
													})}
												/>
												{formErrors.codebaseIndexVertexGatewayBaseUrl && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVertexGatewayBaseUrl}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.vertexGatewayCaBundlePath")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexVertexGatewayCaBundlePath || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVertexGatewayCaBundlePath",
															e.target.value,
														)
													}
													placeholder={t("settings:placeholders.keyFilePath")}
													className="w-full"
												/>
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.vertexGatewayHelixCommand")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexVertexGatewayHelixCommand || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVertexGatewayHelixCommand",
															e.target.value,
														)
													}
													placeholder={DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND}
													className="w-full"
												/>
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.vertexGatewayTokenRefreshMinutes")}
												</label>
												<VSCodeTextField
													value={
														currentSettings.codebaseIndexVertexGatewayTokenRefreshMinutes?.toString() ||
														""
													}
													onInput={(e: any) => {
														const parsed = Number.parseInt(e.target.value, 10)
														updateSetting(
															"codebaseIndexVertexGatewayTokenRefreshMinutes",
															Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
														)
													}}
													placeholder="10"
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexVertexGatewayTokenRefreshMinutes,
													})}
												/>
												{formErrors.codebaseIndexVertexGatewayTokenRefreshMinutes && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVertexGatewayTokenRefreshMinutes}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:providers.vertexGatewayModelRoutingMap")}
												</label>
												<VSCodeTextArea
													resize="vertical"
													value={
														currentSettings.codebaseIndexVertexGatewayModelRoutingMap || ""
													}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVertexGatewayModelRoutingMap",
															e.target.value,
														)
													}
													placeholder='{"gemini-embedding-001":"gateway-embedding-model"}'
													rows={4}
													className={cn("w-full", {
														"border-red-500":
															formErrors.codebaseIndexVertexGatewayModelRoutingMap,
													})}
												/>
												{formErrors.codebaseIndexVertexGatewayModelRoutingMap && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVertexGatewayModelRoutingMap}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "mistral" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.mistralApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexMistralApiKey || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexMistralApiKey", e.target.value)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexMistralApiKey",
														"settings:codeIndex.mistralApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexMistralApiKey,
													})}
												/>
												{formErrors.codebaseIndexMistralApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexMistralApiKey}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "vercel-ai-gateway" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.vercelAiGatewayApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexVercelAiGatewayApiKey || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexVercelAiGatewayApiKey",
															e.target.value,
														)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexVercelAiGatewayApiKey",
														"settings:codeIndex.vercelAiGatewayApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexVercelAiGatewayApiKey,
													})}
												/>
												{formErrors.codebaseIndexVercelAiGatewayApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexVercelAiGatewayApiKey}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "bedrock" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.bedrockRegionLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexBedrockRegion || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexBedrockRegion", e.target.value)
													}
													placeholder={t("settings:codeIndex.bedrockRegionPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexBedrockRegion,
													})}
												/>
												{formErrors.codebaseIndexBedrockRegion && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexBedrockRegion}
													</p>
												)}
											</div>

											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.bedrockProfileLabel")}
													<span className="text-xs text-vscode-descriptionForeground ml-1">
														({t("settings:codeIndex.optional")})
													</span>
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexBedrockProfile || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexBedrockProfile", e.target.value)
													}
													placeholder={t("settings:codeIndex.bedrockProfilePlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexBedrockProfile,
													})}
												/>
												{formErrors.codebaseIndexBedrockProfile && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexBedrockProfile}
													</p>
												)}
												{!formErrors.codebaseIndexBedrockProfile && (
													<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
														{t("settings:codeIndex.bedrockProfileDescription")}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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
										</>
									)}

									{currentSettings.codebaseIndexEmbedderProvider === "openrouter" && (
										<>
											<div className="space-y-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.openRouterApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codebaseIndexOpenRouterApiKey || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexOpenRouterApiKey", e.target.value)
													}
													placeholder={getSecretPlaceholder(
														"codebaseIndexOpenRouterApiKey",
														"settings:codeIndex.openRouterApiKeyPlaceholder",
													)}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexOpenRouterApiKey,
													})}
												/>
												{formErrors.codebaseIndexOpenRouterApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexOpenRouterApiKey}
													</p>
												)}
											</div>

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
														const model =
															codebaseIndexModels?.[
																currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
															]?.[modelId]
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

											{/* Provider Routing for OpenRouter */}
											{openRouterEmbeddingProviders &&
												Object.keys(openRouterEmbeddingProviders).length > 0 && (
													<div className="space-y-2">
														<label className="text-sm font-medium">
															<a
																href="https://openrouter.ai/docs/features/provider-routing"
																target="_blank"
																rel="noopener noreferrer"
																className="flex items-center gap-1 hover:underline">
																{t("settings:codeIndex.openRouterProviderRoutingLabel")}
																<span className="codicon codicon-link-external text-xs" />
															</a>
														</label>
														<Select
															value={
																currentSettings.codebaseIndexOpenRouterSpecificProvider ||
																OPENROUTER_DEFAULT_PROVIDER_NAME
															}
															onValueChange={(value) =>
																updateSetting(
																	"codebaseIndexOpenRouterSpecificProvider",
																	value,
																)
															}>
															<SelectTrigger className="w-full">
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																<SelectItem value={OPENROUTER_DEFAULT_PROVIDER_NAME}>
																	{OPENROUTER_DEFAULT_PROVIDER_NAME}
																</SelectItem>
																{Object.entries(openRouterEmbeddingProviders).map(
																	([value, { label }]) => (
																		<SelectItem key={value} value={value}>
																			{label}
																		</SelectItem>
																	),
																)}
															</SelectContent>
														</Select>
														<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
															{t(
																"settings:codeIndex.openRouterProviderRoutingDescription",
															)}
														</p>
													</div>
												)}
										</>
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
									{/* Search Score Threshold Slider */}
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
