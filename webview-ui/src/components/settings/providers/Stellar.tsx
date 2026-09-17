import { useCallback } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

type StellarProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
}

const DEFAULT_STELLAR_HELIX_COMMAND = "helix auth access-token print -a"

export const Stellar = ({ apiConfiguration, setApiConfigurationField }: StellarProps) => {
	const { t } = useAppTranslation()
	const refreshIntervalValue =
		typeof apiConfiguration.stellarTokenRefreshMinutes === "number"
			? String(apiConfiguration.stellarTokenRefreshMinutes)
			: ""

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings>(
			field: K,
			transform: (value: string) => ProviderSettings[K] = (value) => value as ProviderSettings[K],
		) =>
			(event: unknown) => {
				setApiConfigurationField(field, transform(getInputValue(event)))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.stellarDescription")}
			</div>
			<VSCodeTextField
				value={apiConfiguration.stellarBaseUrl || ""}
				type="url"
				onInput={handleInputChange("stellarBaseUrl")}
				placeholder="https://your-internal-host/stellar/v1"
				className="w-full"
				data-testid="stellar-base-url">
				<label className="block font-medium mb-1">{t("settings:providers.stellarBaseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration.stellarPemCaBundlePath || ""}
				onInput={handleInputChange("stellarPemCaBundlePath")}
				placeholder={t("settings:placeholders.keyFilePath")}
				className="w-full"
				data-testid="stellar-ca-bundle-path">
				<label className="block font-medium mb-1">{t("settings:providers.stellarCaBundlePath")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration.stellarHelixCommand || DEFAULT_STELLAR_HELIX_COMMAND}
				onInput={handleInputChange("stellarHelixCommand")}
				placeholder={DEFAULT_STELLAR_HELIX_COMMAND}
				className="w-full"
				data-testid="stellar-helix-command">
				<label className="block font-medium mb-1">{t("settings:providers.stellarHelixCommand")}</label>
			</VSCodeTextField>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.stellarHelixParseMode")}</label>
				<Select
					value={apiConfiguration.stellarHelixParseMode || "raw_stdout"}
					onValueChange={(value) =>
						setApiConfigurationField(
							"stellarHelixParseMode",
							value as ProviderSettings["stellarHelixParseMode"],
						)
					}>
					<SelectTrigger className="w-full" data-testid="stellar-helix-parse-mode">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="raw_stdout">
							{t("settings:providers.stellarHelixParseModeRawStdout")}
						</SelectItem>
						<SelectItem value="json_field">
							{t("settings:providers.stellarHelixParseModeJsonField")}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{apiConfiguration.stellarHelixParseMode === "json_field" && (
				<VSCodeTextField
					value={apiConfiguration.stellarHelixTokenKey || "access_token"}
					onInput={handleInputChange("stellarHelixTokenKey")}
					placeholder="access_token"
					className="w-full"
					data-testid="stellar-helix-token-key">
					<label className="block font-medium mb-1">{t("settings:providers.stellarHelixTokenKey")}</label>
				</VSCodeTextField>
			)}
			<VSCodeTextField
				value={refreshIntervalValue}
				onInput={handleInputChange("stellarTokenRefreshMinutes", (value) => {
					const parsed = Number.parseInt(value, 10)
					return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
				})}
				placeholder="10"
				className="w-full"
				data-testid="stellar-token-refresh-minutes">
				<label className="block font-medium mb-1">{t("settings:providers.stellarTokenRefreshMinutes")}</label>
			</VSCodeTextField>
			<div>
				<Checkbox
					data-testid="checkbox-stellar-streaming-enabled"
					checked={apiConfiguration.stellarStreamingEnabled ?? true}
					onChange={(checked: boolean) => setApiConfigurationField("stellarStreamingEnabled", checked)}>
					{t("settings:providers.stellarStreamingEnabledLabel")}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
					{t("settings:providers.stellarStreamingEnabledDescription")}
				</div>
			</div>
		</>
	)
}

function getInputValue(event: unknown): string {
	const customTargetValue = (event as CustomEvent<{ target?: { value?: string } }>)?.detail?.target?.value
	if (customTargetValue !== undefined) {
		return customTargetValue
	}

	return (event as { target?: HTMLInputElement })?.target?.value ?? ""
}
