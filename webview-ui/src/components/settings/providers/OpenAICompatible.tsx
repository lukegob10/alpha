import { useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { useEvent } from "react-use"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type ProviderSettingsWithId,
	type ModelInfo,
	type ReasoningEffortExtended,
	type OrganizationAllowList,
	type ExtensionMessage,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
	openAiCustomReasoningEfforts,
	resolveOpenAiCustomModelInfo,
	isMaxOutputTokensIncluded,
	validateOptionalOutputTokenLimit,
	supportsModelTemperature,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, StandardTooltip, Collapsible, CollapsibleTrigger, CollapsibleContent } from "@src/components/ui"

import { convertHeadersToObject } from "../utils/headers"
import { inputEventTransform, noTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { R1FormatSetting } from "../R1FormatSetting"
import { ThinkingBudget } from "../ThinkingBudget"
import { SettingsHelp } from "../SettingsHelp"

type OpenAICompatibleProps = {
	apiConfiguration: ProviderSettingsWithId
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
	onOutputTokenLimitError?: (error: string | undefined) => void
	advancedSettings?: ReactNode
}

export const OpenAICompatible = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
	onOutputTokenLimitError,
	advancedSettings,
}: OpenAICompatibleProps) => {
	const { t } = useAppTranslation()
	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)

	const [azureApiVersionSelected, setAzureApiVersionSelected] = useState(!!apiConfiguration?.azureApiVersion)

	const [openAiModels, setOpenAiModels] = useState<Record<string, ModelInfo> | null>(null)
	const configuredOutputTokenLimit =
		apiConfiguration.openAiCustomModelInfo?.maxTokens ?? openAiModelInfoSaneDefaults.maxTokens
	const [outputTokenLimitInput, setOutputTokenLimitInput] = useState(
		() => configuredOutputTokenLimit?.toString() ?? "",
	)
	const [isOutputTokenLimitEdited, setIsOutputTokenLimitEdited] = useState(false)

	useEffect(() => {
		setOutputTokenLimitInput(configuredOutputTokenLimit?.toString() ?? "")
		setIsOutputTokenLimitEdited(false)
	}, [configuredOutputTokenLimit, apiConfiguration.id, apiConfiguration.openAiModelId])

	const parsedOutputTokenLimit = outputTokenLimitInput.trim() ? Number(outputTokenLimitInput) : undefined
	let outputTokenLimitError: string | undefined
	try {
		validateOptionalOutputTokenLimit(parsedOutputTokenLimit)
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
		outputTokenLimitError = t("settings:validation.outputTokenLimit")
	}

	useEffect(() => {
		// Saved caps are checked against the effective request in configuration validation.
		// Only a user's uncommitted invalid draft adds a separate Save blocker here.
		onOutputTokenLimitError?.(isOutputTokenLimitEdited ? outputTokenLimitError : undefined)
	}, [onOutputTokenLimitError, outputTokenLimitError, isOutputTokenLimitEdited])

	useEffect(() => () => onOutputTokenLimitError?.(undefined), [onOutputTokenLimitError])

	const [customHeaders, setCustomHeaders] = useState<[string, string][]>(() => {
		const headers = apiConfiguration?.openAiHeaders || {}
		return Object.entries(headers)
	})
	const headerSource = useRef({ id: apiConfiguration.id, headers: apiConfiguration.openAiHeaders })

	useEffect(() => {
		setAzureApiVersionSelected(!!apiConfiguration?.azureApiVersion)
	}, [apiConfiguration?.azureApiVersion])

	useEffect(() => {
		if (
			headerSource.current.id === apiConfiguration.id &&
			headerSource.current.headers === apiConfiguration.openAiHeaders
		) {
			return
		}

		headerSource.current = { id: apiConfiguration.id, headers: apiConfiguration.openAiHeaders }
		setCustomHeaders(Object.entries(apiConfiguration?.openAiHeaders || {}))
	}, [apiConfiguration.id, apiConfiguration.openAiHeaders])

	const commitCustomHeaders = useCallback(
		(headers: [string, string][]) => {
			const committed = convertHeadersToObject(headers)
			// A settings-buffer echo must preserve unfinished rows and editing whitespace.
			headerSource.current = { id: apiConfiguration.id, headers: committed }
			setCustomHeaders(headers)
			setApiConfigurationField("openAiHeaders", committed)
		},
		[apiConfiguration.id, setApiConfigurationField],
	)

	const handleAddCustomHeader = useCallback(() => {
		// Only update the local state to show the new row in the UI.
		setCustomHeaders((prev) => [...prev, ["", ""]])
		// Do not update the main configuration yet, wait for user input.
	}, [])

	const handleUpdateHeaderKey = useCallback(
		(index: number, newKey: string) => {
			const updated = [...customHeaders]
			if (updated[index]) {
				updated[index] = [newKey, updated[index][1]]
				commitCustomHeaders(updated)
			}
		},
		[commitCustomHeaders, customHeaders],
	)

	const handleUpdateHeaderValue = useCallback(
		(index: number, newValue: string) => {
			const updated = [...customHeaders]
			if (updated[index]) {
				updated[index] = [updated[index][0], newValue]
				commitCustomHeaders(updated)
			}
		},
		[commitCustomHeaders, customHeaders],
	)

	const handleRemoveCustomHeader = useCallback(
		(index: number) => commitCustomHeaders(customHeaders.filter((_, i) => i !== index)),
		[commitCustomHeaders, customHeaders],
	)

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "openAiModels": {
				const updatedModels = message.openAiModels ?? []
				setOpenAiModels(Object.fromEntries(updatedModels.map((item) => [item, openAiModelInfoSaneDefaults])))
				break
			}
		}
	}, [])

	useEvent("message", onMessage)

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.openAiBaseUrl || ""}
				type="url"
				onInput={handleInputChange("openAiBaseUrl")}
				placeholder={t("settings:placeholders.baseUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.openAiBaseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.openAiApiKey || ""}
				type="password"
				onInput={handleInputChange("openAiApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.apiKey")}</label>
			</VSCodeTextField>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId="gpt-4o"
				models={openAiModels}
				modelIdKey="openAiModelId"
				serviceName="OpenAI"
				serviceUrl="https://platform.openai.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
			<Collapsible open={isAdvancedSettingsOpen} onOpenChange={setIsAdvancedSettingsOpen}>
				<div className="flex items-center gap-1 mb-2">
					<CollapsibleTrigger className="flex items-center gap-1 flex-1 cursor-pointer hover:opacity-80">
						<span
							className={`codicon codicon-chevron-${isAdvancedSettingsOpen ? "down" : "right"}`}
							aria-hidden="true"></span>
						<span className="font-medium">{t("settings:providers.advancedConnection")}</span>
					</CollapsibleTrigger>
					<SettingsHelp label={t("settings:providers.advancedConnection")}>
						{t("settings:providers.customModel.capabilities")}
					</SettingsHelp>
				</div>
				{/* Hidden editors stay mounted to retain draft headers, invalid values and Save blockers. */}
				<CollapsibleContent forceMount hidden={!isAdvancedSettingsOpen} className="space-y-3">
					<R1FormatSetting
						onChange={handleInputChange("openAiR1FormatEnabled", noTransform)}
						openAiR1FormatEnabled={apiConfiguration?.openAiR1FormatEnabled ?? false}
					/>
					<Checkbox
						checked={apiConfiguration?.openAiStreamingEnabled ?? true}
						onChange={handleInputChange("openAiStreamingEnabled", noTransform)}>
						{t("settings:modelInfo.enableStreaming")}
					</Checkbox>
					<div className="flex items-center gap-1">
						<Checkbox
							checked={isMaxOutputTokensIncluded(apiConfiguration)}
							onChange={handleInputChange("includeMaxTokens", noTransform)}>
							{t("settings:includeMaxOutputTokens")}
						</Checkbox>
						<SettingsHelp label={t("settings:includeMaxOutputTokens")}>
							{t("settings:includeMaxOutputTokensDescription")}
						</SettingsHelp>
					</div>
					<Checkbox
						checked={apiConfiguration?.openAiUseAzure ?? false}
						onChange={handleInputChange("openAiUseAzure", noTransform)}>
						{t("settings:modelInfo.useAzure")}
					</Checkbox>
					<div>
						<Checkbox
							checked={azureApiVersionSelected}
							onChange={(checked: boolean) => {
								setAzureApiVersionSelected(checked)

								if (!checked) {
									setApiConfigurationField("azureApiVersion", "")
								}
							}}>
							{t("settings:modelInfo.azureApiVersion")}
						</Checkbox>
						{azureApiVersionSelected && (
							<VSCodeTextField
								value={apiConfiguration?.azureApiVersion || ""}
								onInput={handleInputChange("azureApiVersion")}
								placeholder={`Default: ${azureOpenAiDefaultApiVersion}`}
								className="w-full mt-1"
							/>
						)}
					</div>

					{/* Custom Headers UI */}
					<div className="mb-4">
						<div className="flex justify-between items-center mb-2">
							<label className="block font-medium">{t("settings:providers.customHeaders")}</label>
							<StandardTooltip content={t("settings:common.add")}>
								<VSCodeButton appearance="icon" onClick={handleAddCustomHeader}>
									<span className="codicon codicon-add"></span>
								</VSCodeButton>
							</StandardTooltip>
						</div>
						{!customHeaders.length ? (
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:providers.noCustomHeaders")}
							</div>
						) : (
							customHeaders.map(([key, value], index) => (
								<div key={index} className="flex items-center mb-2">
									<VSCodeTextField
										value={key}
										className="flex-1 mr-2"
										placeholder={t("settings:providers.headerName")}
										onInput={(e: any) => handleUpdateHeaderKey(index, e.target.value)}
									/>
									<VSCodeTextField
										value={value}
										className="flex-1 mr-2"
										placeholder={t("settings:providers.headerValue")}
										onInput={(e: any) => handleUpdateHeaderValue(index, e.target.value)}
									/>
									<StandardTooltip content={t("settings:common.remove")}>
										<VSCodeButton appearance="icon" onClick={() => handleRemoveCustomHeader(index)}>
											<span className="codicon codicon-trash"></span>
										</VSCodeButton>
									</StandardTooltip>
								</div>
							))
						)}
					</div>

					<div className="flex flex-col gap-1">
						<Checkbox
							checked={apiConfiguration.enableReasoningEffort ?? false}
							onChange={(checked: boolean) => {
								setApiConfigurationField("enableReasoningEffort", checked)
								if (checked) {
									const info = apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults
									setApiConfigurationField("openAiCustomModelInfo", {
										...info,
										supportsReasoningEffort: info.supportsReasoningEffort ?? [
											...openAiCustomReasoningEfforts,
										],
									})
								}

								if (!checked) {
									const { reasoningEffort: _, ...openAiCustomModelInfo } =
										resolveOpenAiCustomModelInfo(
											apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults,
										)

									setApiConfigurationField("openAiCustomModelInfo", openAiCustomModelInfo)
								}
							}}>
							{t("settings:providers.setReasoningLevel")}
						</Checkbox>
						{!!apiConfiguration.enableReasoningEffort && (
							<ThinkingBudget
								apiConfiguration={{
									...apiConfiguration,
									reasoningEffort: apiConfiguration.openAiCustomModelInfo?.reasoningEffort,
								}}
								setApiConfigurationField={(field, value) => {
									if (field === "reasoningEffort") {
										const openAiCustomModelInfo =
											apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults

										setApiConfigurationField("openAiCustomModelInfo", {
											...openAiCustomModelInfo,
											reasoningEffort: value as ReasoningEffortExtended,
											supportsReasoningEffort: openAiCustomModelInfo.supportsReasoningEffort ?? [
												...openAiCustomReasoningEfforts,
											],
										})
									}
								}}
								modelInfo={{
									...(apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
									supportsReasoningEffort: apiConfiguration.openAiCustomModelInfo
										?.supportsReasoningEffort ?? [...openAiCustomReasoningEfforts],
								}}
								showReasoningEffort
							/>
						)}
					</div>
					<div className="flex flex-col gap-3">
						<div>
							<div className="flex items-center gap-1 mb-1">
								<label htmlFor="openai-output-token-limit" className="font-medium">
									{t("settings:providers.customModel.maxTokens.label")}
								</label>
								<SettingsHelp label={t("settings:providers.customModel.maxTokens.label")}>
									{t("settings:providers.customModel.maxTokens.description")}
								</SettingsHelp>
							</div>
							<VSCodeTextField
								value={outputTokenLimitInput}
								id="openai-output-token-limit"
								data-testid="max-output-tokens"
								aria-label={t("settings:providers.customModel.maxTokens.label")}
								aria-invalid={outputTokenLimitError !== undefined}
								aria-describedby={outputTokenLimitError ? "openai-output-token-limit-error" : undefined}
								type="text"
								style={{
									borderColor: outputTokenLimitError
										? "var(--vscode-errorForeground)"
										: "var(--vscode-input-border)",
								}}
								onInput={(event) => {
									const input = (event.target as HTMLInputElement).value
									setOutputTokenLimitInput(input)
									setIsOutputTokenLimitEdited(true)
									const value = input.trim() ? Number(input) : undefined
									try {
										validateOptionalOutputTokenLimit(value)
									} catch (error) {
										if (!(error instanceof RangeError)) throw error
										// Mark the cached edit buffer dirty without replacing its last valid cap.
										setApiConfigurationField("openAiCustomModelInfo", {
											...(apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
										})
										return
									}
									setApiConfigurationField("openAiCustomModelInfo", {
										...(apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
										maxTokens: value,
									})
								}}
								placeholder={t("settings:placeholders.numbers.maxTokens")}
								className="w-full"
							/>
							{outputTokenLimitError && (
								<div
									id="openai-output-token-limit-error"
									role="alert"
									className="text-sm text-vscode-errorForeground">
									{outputTokenLimitError}
								</div>
							)}
						</div>

						<div>
							<div className="flex items-center gap-1 mb-1">
								<label htmlFor="openai-context-window" className="font-medium">
									{t("settings:providers.customModel.contextWindow.label")}
								</label>
								<SettingsHelp label={t("settings:providers.customModel.contextWindow.label")}>
									{t("settings:providers.customModel.contextWindow.description")}
								</SettingsHelp>
							</div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.contextWindow?.toString() ||
									openAiModelInfoSaneDefaults.contextWindow?.toString() ||
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.contextWindow

										if (!value) {
											return "var(--vscode-input-border)"
										}

										return value > 0
											? "var(--vscode-charts-green)"
											: "var(--vscode-errorForeground)"
									})(),
								}}
								onInput={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseInt(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
										contextWindow: isNaN(parsed)
											? openAiModelInfoSaneDefaults.contextWindow
											: parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.contextWindow")}
								id="openai-context-window"
								aria-label={t("settings:providers.customModel.contextWindow.label")}
								className="w-full"
							/>
						</div>

						<div className="flex items-center gap-1">
							<Checkbox
								checked={supportsModelTemperature(
									apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults,
									true,
								)}
								onChange={handleInputChange("openAiCustomModelInfo", (checked) => ({
									...(apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
									supportsTemperature: checked,
								}))}>
								{t("settings:providers.customModel.temperatureSupport.label")}
							</Checkbox>
							<SettingsHelp label={t("settings:providers.customModel.temperatureSupport.label")}>
								{t("settings:providers.customModel.temperatureSupport.description")}
							</SettingsHelp>
						</div>

						<div>
							<div className="flex items-center gap-1">
								<Checkbox
									checked={
										apiConfiguration?.openAiCustomModelInfo?.supportsImages ??
										openAiModelInfoSaneDefaults.supportsImages
									}
									onChange={handleInputChange("openAiCustomModelInfo", (checked) => {
										return {
											...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
											supportsImages: checked,
										}
									})}>
									<span className="font-medium">
										{t("settings:providers.customModel.imageSupport.label")}
									</span>
								</Checkbox>
								<SettingsHelp label={t("settings:providers.customModel.imageSupport.label")}>
									{t("settings:providers.customModel.imageSupport.description")}
								</SettingsHelp>
							</div>
						</div>

						<div>
							<div className="flex items-center gap-1">
								<Checkbox
									checked={apiConfiguration?.openAiCustomModelInfo?.supportsPromptCache ?? false}
									onChange={handleInputChange("openAiCustomModelInfo", (checked) => {
										return {
											...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
											supportsPromptCache: checked,
										}
									})}>
									<span className="font-medium">
										{t("settings:providers.customModel.promptCache.label")}
									</span>
								</Checkbox>
								<SettingsHelp label={t("settings:providers.customModel.promptCache.label")}>
									{t("settings:providers.customModel.promptCache.description")}
								</SettingsHelp>
							</div>
						</div>

						<div>
							<div className="flex items-center gap-1 mb-1">
								<label htmlFor="openai-input-price" className="font-medium">
									{t("settings:providers.customModel.pricing.input.label")}
								</label>
								<SettingsHelp label={t("settings:providers.customModel.pricing.input.label")}>
									{t("settings:providers.customModel.pricing.input.description")}
								</SettingsHelp>
							</div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.inputPrice?.toString() ??
									openAiModelInfoSaneDefaults.inputPrice?.toString() ??
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.inputPrice

										if (!value && value !== 0) {
											return "var(--vscode-input-border)"
										}

										return value >= 0
											? "var(--vscode-charts-green)"
											: "var(--vscode-errorForeground)"
									})(),
								}}
								onChange={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseFloat(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
										inputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.inputPrice : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.inputPrice")}
								id="openai-input-price"
								aria-label={t("settings:providers.customModel.pricing.input.label")}
								className="w-full"
							/>
						</div>

						<div>
							<div className="flex items-center gap-1 mb-1">
								<label htmlFor="openai-output-price" className="font-medium">
									{t("settings:providers.customModel.pricing.output.label")}
								</label>
								<SettingsHelp label={t("settings:providers.customModel.pricing.output.label")}>
									{t("settings:providers.customModel.pricing.output.description")}
								</SettingsHelp>
							</div>
							<VSCodeTextField
								value={
									apiConfiguration?.openAiCustomModelInfo?.outputPrice?.toString() ||
									openAiModelInfoSaneDefaults.outputPrice?.toString() ||
									""
								}
								type="text"
								style={{
									borderColor: (() => {
										const value = apiConfiguration?.openAiCustomModelInfo?.outputPrice

										if (!value && value !== 0) {
											return "var(--vscode-input-border)"
										}

										return value >= 0
											? "var(--vscode-charts-green)"
											: "var(--vscode-errorForeground)"
									})(),
								}}
								onChange={handleInputChange("openAiCustomModelInfo", (e) => {
									const value = (e.target as HTMLInputElement).value
									const parsed = parseFloat(value)

									return {
										...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
										outputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.outputPrice : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.outputPrice")}
								id="openai-output-price"
								aria-label={t("settings:providers.customModel.pricing.output.label")}
								className="w-full"
							/>
						</div>

						{apiConfiguration?.openAiCustomModelInfo?.supportsPromptCache && (
							<>
								<div>
									<div className="flex items-center gap-1 mb-1">
										<label htmlFor="openai-cache-read-price" className="font-medium">
											{t("settings:providers.customModel.pricing.cacheReads.label")}
										</label>
										<SettingsHelp
											label={t("settings:providers.customModel.pricing.cacheReads.label")}>
											{t("settings:providers.customModel.pricing.cacheReads.description")}
										</SettingsHelp>
									</div>
									<VSCodeTextField
										value={
											apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice?.toString() ?? "0"
										}
										type="text"
										style={{
											borderColor: (() => {
												const value = apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice

												if (!value && value !== 0) {
													return "var(--vscode-input-border)"
												}

												return value >= 0
													? "var(--vscode-charts-green)"
													: "var(--vscode-errorForeground)"
											})(),
										}}
										onChange={handleInputChange("openAiCustomModelInfo", (e) => {
											const value = (e.target as HTMLInputElement).value
											const parsed = parseFloat(value)

											return {
												...(apiConfiguration?.openAiCustomModelInfo ??
													openAiModelInfoSaneDefaults),
												cacheReadsPrice: isNaN(parsed) ? 0 : parsed,
											}
										})}
										placeholder={t("settings:placeholders.numbers.inputPrice")}
										id="openai-cache-read-price"
										aria-label={t("settings:providers.customModel.pricing.cacheReads.label")}
										className="w-full"
									/>
								</div>
								<div>
									<div className="flex items-center gap-1 mb-1">
										<label htmlFor="openai-cache-write-price" className="font-medium">
											{t("settings:providers.customModel.pricing.cacheWrites.label")}
										</label>
										<SettingsHelp
											label={t("settings:providers.customModel.pricing.cacheWrites.label")}>
											{t("settings:providers.customModel.pricing.cacheWrites.description")}
										</SettingsHelp>
									</div>
									<VSCodeTextField
										value={
											apiConfiguration?.openAiCustomModelInfo?.cacheWritesPrice?.toString() ?? "0"
										}
										type="text"
										style={{
											borderColor: (() => {
												const value = apiConfiguration?.openAiCustomModelInfo?.cacheWritesPrice

												if (!value && value !== 0) {
													return "var(--vscode-input-border)"
												}

												return value >= 0
													? "var(--vscode-charts-green)"
													: "var(--vscode-errorForeground)"
											})(),
										}}
										onChange={handleInputChange("openAiCustomModelInfo", (e) => {
											const value = (e.target as HTMLInputElement).value
											const parsed = parseFloat(value)

											return {
												...(apiConfiguration?.openAiCustomModelInfo ??
													openAiModelInfoSaneDefaults),
												cacheWritesPrice: isNaN(parsed) ? 0 : parsed,
											}
										})}
										placeholder={t("settings:placeholders.numbers.cacheWritePrice")}
										id="openai-cache-write-price"
										aria-label={t("settings:providers.customModel.pricing.cacheWrites.label")}
										className="w-full"
									/>
								</div>
							</>
						)}

						<Button
							variant="secondary"
							onClick={() =>
								setApiConfigurationField("openAiCustomModelInfo", openAiModelInfoSaneDefaults)
							}>
							{t("settings:providers.customModel.resetDefaults")}
						</Button>
					</div>
					{advancedSettings}
				</CollapsibleContent>
			</Collapsible>
		</>
	)
}
