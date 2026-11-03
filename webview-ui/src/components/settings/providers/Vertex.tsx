import { useCallback } from "react"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	VERTEX_REGIONS,
	VERTEX_1M_CONTEXT_MODEL_IDS,
	hasCustomVertexConnection,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { SearchableSelect } from "@src/components/ui"

type VertexProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Vertex = ({ apiConfiguration, setApiConfigurationField }: VertexProps) => {
	const { t } = useAppTranslation()
	const location = apiConfiguration?.location || apiConfiguration?.vertexRegion || ""
	const projectId = apiConfiguration?.projectId || apiConfiguration?.vertexProjectId || ""

	// Check if the selected model supports 1M context (supported Claude 4 models)
	const supports1MContextBeta =
		!!apiConfiguration?.apiModelId &&
		VERTEX_1M_CONTEXT_MODEL_IDS.includes(
			apiConfiguration.apiModelId as (typeof VERTEX_1M_CONTEXT_MODEL_IDS)[number],
		)

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
			{hasCustomVertexConnection(apiConfiguration) && (
				<div role="alert" className="text-sm text-vscode-descriptionForeground">
					<p>{t("settings:providers.vertexConnectionRemoved")}</p>
					<VSCodeButton
						appearance="secondary"
						onClick={() => {
							for (const field of [
								"gatewayBaseUrl",
								"pemCaBundlePath",
								"helixCommand",
								"helixParseMode",
								"helixTokenKey",
								"refreshIntervalMinutes",
								"modelRoutingMap",
								"vertexGatewayBaseUrl",
								"vertexGatewayCaBundlePath",
								"vertexGatewayHelixCommand",
								"vertexGatewayTokenRefreshMinutes",
								"vertexGatewayModelRoutingMap",
							] as const)
								setApiConfigurationField(field, undefined)
						}}>
						{t("settings:providers.useStandardVertex")}
					</VSCodeButton>
				</div>
			)}
			<div className="text-sm text-vscode-descriptionForeground">
				<div>{t("settings:providers.googleCloudSetup.title")}</div>
				<div>
					<VSCodeLink
						href="https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#before_you_begin"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step1")}
					</VSCodeLink>
				</div>
				<div>
					<VSCodeLink
						href="https://cloud.google.com/docs/authentication/provide-credentials-adc#google-idp"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step2")}
					</VSCodeLink>
				</div>
				<div>
					<VSCodeLink
						href="https://developers.google.com/workspace/guides/create-credentials?hl=en#service-account"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step3")}
					</VSCodeLink>
				</div>
			</div>
			<VSCodeTextField
				value={projectId}
				onInput={handleInputChange("projectId")}
				placeholder={t("settings:placeholders.projectId")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudProjectId")}</label>
			</VSCodeTextField>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudRegion")}</label>
				<SearchableSelect
					value={location}
					onValueChange={(value) => setApiConfigurationField("location", value)}
					options={VERTEX_REGIONS}
					placeholder={t("settings:common.select")}
					searchPlaceholder={t("settings:providers.googleCloudRegionPicker.searchPlaceholder")}
					emptyMessage={t("settings:providers.googleCloudRegionPicker.noMatchFound")}
					allowCustomValue
					customValueLabel={(value) =>
						t("settings:providers.googleCloudRegionPicker.useCustomRegion", { region: value })
					}
					aria-label={t("settings:providers.googleCloudRegion")}
					data-testid="vertex-region-picker"
				/>
			</div>
			<VSCodeTextField
				value={apiConfiguration?.vertexJsonCredentials || ""}
				onInput={handleInputChange("vertexJsonCredentials")}
				placeholder={t("settings:placeholders.credentialsJson")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudCredentials")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.vertexKeyFile || ""}
				onInput={handleInputChange("vertexKeyFile")}
				placeholder={t("settings:placeholders.keyFilePath")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudKeyFile")}</label>
			</VSCodeTextField>

			<div>
				<Checkbox
					data-testid="checkbox-vertex-streaming-enabled"
					checked={apiConfiguration?.vertexStreamingEnabled ?? true}
					onChange={(checked: boolean) => {
						setApiConfigurationField("vertexStreamingEnabled", checked)
					}}>
					{t("settings:providers.vertexStreamingEnabledLabel")}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
					{t("settings:providers.vertexStreamingEnabledDescription")}
				</div>
			</div>

			{supports1MContextBeta && (
				<div>
					<Checkbox
						data-testid="checkbox-vertex-1m-context"
						checked={apiConfiguration?.vertex1MContext ?? false}
						onChange={(checked: boolean) => {
							setApiConfigurationField("vertex1MContext", checked)
						}}>
						{t("settings:providers.vertex1MContextBetaLabel")}
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
						{t("settings:providers.vertex1MContextBetaDescription")}
					</div>
				</div>
			)}
		</>
	)
}

function getInputValue(event: unknown): string {
	const customTargetValue = (event as CustomEvent<{ target?: { value?: string } }>)?.detail?.target?.value
	if (customTargetValue !== undefined) {
		return customTargetValue
	}

	const targetValue = (event as { target?: HTMLInputElement | HTMLTextAreaElement })?.target?.value
	return targetValue ?? ""
}
