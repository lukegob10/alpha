import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useRef, useState } from "react"
import { Checkbox } from "vscrui"

import {
	curatedProviderApiKeyFields,
	getUnsupportedCuratedProviderSettings,
	isMaxOutputTokensIncluded,
	validateOptionalOutputTokenLimit,
	type CuratedProvider as CuratedProviderName,
	type ProviderSettings,
	type ProviderSettingsWithId,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { getOutputTokenLimitValidationError } from "@src/utils/validate"

type CuratedProviderProps = {
	provider: CuratedProviderName
	apiConfiguration: ProviderSettingsWithId
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	onOutputTokenLimitError?: (error: string | undefined) => void
}

const API_KEY_URLS: Record<CuratedProviderName, string> = {
	"openai-native": "https://platform.openai.com/api-keys",
	anthropic: "https://platform.claude.com/settings/keys",
	gemini: "https://aistudio.google.com/apikey",
	xai: "https://console.x.ai",
	openrouter: "https://openrouter.ai/settings/keys",
}

/** Provider forms edit the caller's settings buffer; they never update extension state directly. */
export const CuratedProvider = ({
	provider,
	apiConfiguration,
	setApiConfigurationField,
	onOutputTokenLimitError,
}: CuratedProviderProps) => {
	const { t } = useAppTranslation()
	const keyField = curatedProviderApiKeyFields[provider]
	const providerName = t(`settings:providers.names.${provider}`)
	const label = t("settings:providers.providerApiKey", { provider: providerName })
	const unsupportedFields = getUnsupportedCuratedProviderSettings(provider, apiConfiguration)
	const { id: modelId, info: model } = useSelectedModel(apiConfiguration)
	const outputTokenLimitId = useId()
	const [outputTokenLimitInput, setOutputTokenLimitInput] = useState(
		() => apiConfiguration.modelMaxTokens?.toString() ?? "",
	)
	const [isOutputTokenLimitEdited, setIsOutputTokenLimitEdited] = useState(false)
	const outputSource = useRef({
		provider,
		modelId,
		profileId: apiConfiguration.id,
		value: apiConfiguration.modelMaxTokens,
	})

	useEffect(() => {
		const previous = outputSource.current
		if (
			previous.provider === provider &&
			previous.modelId === modelId &&
			previous.profileId === apiConfiguration.id &&
			previous.value === apiConfiguration.modelMaxTokens
		)
			return
		outputSource.current = {
			provider,
			modelId,
			profileId: apiConfiguration.id,
			value: apiConfiguration.modelMaxTokens,
		}
		setOutputTokenLimitInput(apiConfiguration.modelMaxTokens?.toString() ?? "")
		setIsOutputTokenLimitEdited(false)
	}, [provider, modelId, apiConfiguration.id, apiConfiguration.modelMaxTokens])

	const parsedOutputTokenLimit = outputTokenLimitInput.trim() ? Number(outputTokenLimitInput) : undefined
	const includesOutputTokenLimit = isMaxOutputTokensIncluded(apiConfiguration)
	let outputTokenLimitDraftError: string | undefined
	try {
		validateOptionalOutputTokenLimit(parsedOutputTokenLimit)
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
		outputTokenLimitDraftError = t("settings:validation.outputTokenLimit")
	}
	const outputTokenLimitError =
		(isOutputTokenLimitEdited && includesOutputTokenLimit ? outputTokenLimitDraftError : undefined) ??
		(model ? getOutputTokenLimitValidationError(apiConfiguration, modelId, model) : undefined)
	useEffect(() => {
		onOutputTokenLimitError?.(
			isOutputTokenLimitEdited && includesOutputTokenLimit ? outputTokenLimitDraftError : undefined,
		)
	}, [onOutputTokenLimitError, isOutputTokenLimitEdited, includesOutputTokenLimit, outputTokenLimitDraftError])
	useEffect(() => () => onOutputTokenLimitError?.(undefined), [onOutputTokenLimitError])

	return (
		<div className="flex flex-col gap-1">
			{unsupportedFields.length > 0 && (
				<Button
					variant="secondary"
					onClick={() => {
						for (const field of unsupportedFields) setApiConfigurationField(field, undefined)
					}}>
					{t("settings:providers.useProviderDefaults")}
				</Button>
			)}
			<VSCodeTextField
				type="password"
				value={apiConfiguration[keyField] ?? ""}
				aria-label={label}
				onInput={(event) => setApiConfigurationField(keyField, (event.target as HTMLInputElement).value)}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full"
				data-testid="curated-provider-api-key">
				<label className="block font-medium mb-1">{label}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			<VSCodeLink href={API_KEY_URLS[provider]} target="_blank">
				{t("settings:providers.manageApiKeys", { provider: providerName })}
			</VSCodeLink>
			<Checkbox
				checked={includesOutputTokenLimit}
				onChange={(checked: boolean) => setApiConfigurationField("includeMaxTokens", checked)}>
				{t("settings:includeMaxOutputTokens")}
			</Checkbox>
			<VSCodeTextField
				id={outputTokenLimitId}
				type="text"
				value={outputTokenLimitInput}
				aria-label={t("settings:maxOutputTokensLabel")}
				aria-invalid={outputTokenLimitError !== undefined}
				aria-describedby={`${outputTokenLimitId}-description${outputTokenLimitError ? ` ${outputTokenLimitId}-error` : ""}`}
				placeholder={model?.maxTokens?.toString() ?? ""}
				onInput={(event) => {
					const input = (event.target as HTMLInputElement).value
					setOutputTokenLimitInput(input)
					setIsOutputTokenLimitEdited(true)
					const parsed = input.trim() ? Number(input) : undefined
					// Invalid drafts remain editable and block Save without putting NaN in the settings buffer.
					const value = parsed !== undefined && !Number.isFinite(parsed) ? 0 : parsed
					outputSource.current = { provider, modelId, profileId: apiConfiguration.id, value }
					setApiConfigurationField("modelMaxTokens", value)
				}}
				className="w-full"
				data-testid="curated-output-token-limit">
				<label htmlFor={outputTokenLimitId} className="block font-medium mb-1">
					{t("settings:maxOutputTokensLabel")}
				</label>
			</VSCodeTextField>
			<div id={`${outputTokenLimitId}-description`} className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.outputTokenLimitDescription")}
			</div>
			{outputTokenLimitError && (
				<div id={`${outputTokenLimitId}-error`} role="alert" className="text-sm text-vscode-errorForeground">
					{outputTokenLimitError}
				</div>
			)}
		</div>
	)
}
