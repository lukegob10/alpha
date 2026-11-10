import { useCallback, useId } from "react"
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

import { SettingsHelp } from "../SettingsHelp"

type VertexProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Vertex = ({ apiConfiguration, setApiConfigurationField }: VertexProps) => {
	const { t } = useAppTranslation()
	const id = useId()
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
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-1">
					<label htmlFor={`${id}-project`} className="font-medium">
						{t("settings:providers.googleCloudProjectId")}
					</label>
					<SettingsHelp label={t("settings:providers.googleCloudProjectId")}>
						<VSCodeLink href="https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#before_you_begin">
							{t("settings:providers.googleCloudSetup.step1")}
						</VSCodeLink>
					</SettingsHelp>
				</div>
				<VSCodeTextField
					id={`${id}-project`}
					value={projectId}
					onInput={handleInputChange("projectId")}
					placeholder={t("settings:placeholders.projectId")}
					aria-label={t("settings:providers.googleCloudProjectId")}
					className="w-full"
				/>
			</div>
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
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-1">
					<label htmlFor={`${id}-credentials`} className="font-medium">
						{t("settings:providers.googleCloudCredentials")}
					</label>
					<SettingsHelp label={t("settings:providers.googleCloudCredentials")}>
						<p>{t("settings:providers.vertexCredentialsHelp")}</p>
						<VSCodeLink href="https://cloud.google.com/docs/authentication/provide-credentials-adc#google-idp">
							{t("settings:providers.googleCloudSetup.step2")}
						</VSCodeLink>
					</SettingsHelp>
				</div>
				<VSCodeTextField
					id={`${id}-credentials`}
					value={apiConfiguration?.vertexJsonCredentials || ""}
					onInput={handleInputChange("vertexJsonCredentials")}
					placeholder={t("settings:placeholders.credentialsJson")}
					aria-label={t("settings:providers.googleCloudCredentials")}
					className="w-full"
				/>
			</div>
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-1">
					<label htmlFor={`${id}-key-file`} className="font-medium">
						{t("settings:providers.googleCloudKeyFile")}
					</label>
					<SettingsHelp label={t("settings:providers.googleCloudKeyFile")}>
						<VSCodeLink href="https://developers.google.com/workspace/guides/create-credentials?hl=en#service-account">
							{t("settings:providers.googleCloudSetup.step3")}
						</VSCodeLink>
					</SettingsHelp>
				</div>
				<VSCodeTextField
					id={`${id}-key-file`}
					value={apiConfiguration?.vertexKeyFile || ""}
					onInput={handleInputChange("vertexKeyFile")}
					placeholder={t("settings:placeholders.keyFilePath")}
					aria-label={t("settings:providers.googleCloudKeyFile")}
					className="w-full"
				/>
			</div>

			<div className="flex items-center gap-1">
				<Checkbox
					data-testid="checkbox-vertex-streaming-enabled"
					checked={apiConfiguration?.vertexStreamingEnabled ?? true}
					onChange={(checked: boolean) => {
						setApiConfigurationField("vertexStreamingEnabled", checked)
					}}>
					{t("settings:providers.vertexStreamingEnabledLabel")}
				</Checkbox>
				<SettingsHelp label={t("settings:providers.vertexStreamingEnabledLabel")}>
					{t("settings:providers.vertexStreamingEnabledDescription")}
				</SettingsHelp>
			</div>

			{supports1MContextBeta && (
				<div className="flex items-center gap-1">
					<Checkbox
						data-testid="checkbox-vertex-1m-context"
						checked={apiConfiguration?.vertex1MContext ?? false}
						onChange={(checked: boolean) => {
							setApiConfigurationField("vertex1MContext", checked)
						}}>
						{t("settings:providers.vertex1MContextBetaLabel")}
					</Checkbox>
					<SettingsHelp label={t("settings:providers.vertex1MContextBetaLabel")}>
						{t("settings:providers.vertex1MContextBetaDescription")}
					</SettingsHelp>
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
