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
import { SettingsHelp } from "../SettingsHelp"

type CuratedProviderProps = {
	provider: CuratedProviderName
	apiConfiguration: ProviderSettingsWithId
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	onOutputTokenLimitError?: (error: string | undefined) => void
}

const API_KEY_URLS: Partial<Record<CuratedProviderName, string>> = {
	"openai-native": "https://platform.openai.com/api-keys",
	anthropic: "https://platform.claude.com/settings/keys",
	gemini: "https://aistudio.google.com/apikey",
	xai: "https://console.x.ai",
	openrouter: "https://openrouter.ai/settings/keys",
	meta: "https://dev.meta.ai",
}

/** Provider forms edit the caller's settings buffer; they never update extension state directly. */
export const CuratedProvider = ({
	provider,
	apiConfiguration,
	setApiConfigurationField,
}: Omit<CuratedProviderProps, "onOutputTokenLimitError">) => {
	const { t } = useAppTranslation()
	const keyField = curatedProviderApiKeyFields[provider]
	const keyValue = keyField ? apiConfiguration[keyField] : undefined
	const providerName = t(`settings:providers.names.${provider}`)
	const label = t("settings:providers.providerApiKey", { provider: providerName })
	const unsupportedFields = getUnsupportedCuratedProviderSettings(provider, apiConfiguration)
	const apiKeyId = useId()

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
			{keyField && (
				<>
					<div className="flex min-w-0 flex-col gap-1">
						<div className="flex items-center gap-1">
							<label htmlFor={apiKeyId} className="font-medium">
								{label}
							</label>
							<SettingsHelp label={label}>{t("settings:providers.apiKeyStorageNotice")}</SettingsHelp>
						</div>
						<VSCodeTextField
							id={apiKeyId}
							type="password"
							value={typeof keyValue === "string" ? keyValue : ""}
							aria-label={label}
							onInput={(event) =>
								setApiConfigurationField(keyField, (event.target as HTMLInputElement).value)
							}
							placeholder={t("settings:placeholders.apiKey")}
							className="w-full min-w-0"
							data-testid="curated-provider-api-key"
						/>
					</div>
					{API_KEY_URLS[provider] && (
						<VSCodeLink href={API_KEY_URLS[provider]} target="_blank" className="text-xs self-end">
							{t("settings:providers.manageApiKeys", { provider: providerName })}
						</VSCodeLink>
					)}
				</>
			)}
		</div>
	)
}

/** Keep numeric drafts mounted inside the disclosure so closing it cannot clear validation. */
export const CuratedProviderAdvanced = ({
	provider,
	apiConfiguration,
	setApiConfigurationField,
	onOutputTokenLimitError,
}: CuratedProviderProps) => {
	const { t } = useAppTranslation()
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
	const supportsOutputTokenLimit = provider !== "openai-codex"
	const includesOutputTokenLimit = supportsOutputTokenLimit && isMaxOutputTokensIncluded(apiConfiguration)
	let outputTokenLimitDraftError: string | undefined
	try {
		if (supportsOutputTokenLimit) validateOptionalOutputTokenLimit(parsedOutputTokenLimit)
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
		outputTokenLimitDraftError = t("settings:validation.outputTokenLimit")
	}
	const outputTokenLimitError = supportsOutputTokenLimit
		? ((isOutputTokenLimitEdited && includesOutputTokenLimit ? outputTokenLimitDraftError : undefined) ??
			(model ? getOutputTokenLimitValidationError(apiConfiguration, modelId, model) : undefined))
		: undefined
	useEffect(() => {
		onOutputTokenLimitError?.(
			isOutputTokenLimitEdited && includesOutputTokenLimit ? outputTokenLimitDraftError : undefined,
		)
	}, [onOutputTokenLimitError, isOutputTokenLimitEdited, includesOutputTokenLimit, outputTokenLimitDraftError])
	useEffect(() => () => onOutputTokenLimitError?.(undefined), [onOutputTokenLimitError])

	return (
		<div className="flex flex-col gap-1">
			{supportsOutputTokenLimit && (
				<>
					<Checkbox
						checked={includesOutputTokenLimit}
						onChange={(checked: boolean) => setApiConfigurationField("includeMaxTokens", checked)}>
						{t("settings:includeMaxOutputTokens")}
					</Checkbox>
					<div className="flex items-center gap-1">
						<label htmlFor={outputTokenLimitId} className="font-medium">
							{t("settings:maxOutputTokensLabel")}
						</label>
						<SettingsHelp label={t("settings:maxOutputTokensLabel")}>
							{t("settings:providers.outputTokenLimitDescription")}
						</SettingsHelp>
					</div>
					<VSCodeTextField
						id={outputTokenLimitId}
						type="text"
						value={outputTokenLimitInput}
						aria-label={t("settings:maxOutputTokensLabel")}
						aria-invalid={outputTokenLimitError !== undefined}
						aria-describedby={outputTokenLimitError ? `${outputTokenLimitId}-error` : undefined}
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
						data-testid="curated-output-token-limit"
					/>
					{outputTokenLimitError && (
						<div
							id={`${outputTokenLimitId}-error`}
							role="alert"
							className="text-sm text-vscode-errorForeground">
							{outputTokenLimitError}
						</div>
					)}
				</>
			)}
		</div>
	)
}
