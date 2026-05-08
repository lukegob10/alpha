import { useCallback } from "react"
import { Checkbox } from "vscrui"
import { VSCodeLink, VSCodeTextArea, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, VERTEX_REGIONS, VERTEX_1M_CONTEXT_MODEL_IDS } from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

type VertexProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

const DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND = "helix auth access-token print -a"

export const Vertex = ({ apiConfiguration, setApiConfigurationField }: VertexProps) => {
	const { t } = useAppTranslation()
	const location = apiConfiguration?.location || apiConfiguration?.vertexRegion || ""
	const projectId = apiConfiguration?.projectId || apiConfiguration?.vertexProjectId || ""
	const rawModelRoutingMap = apiConfiguration?.modelRoutingMap ?? apiConfiguration?.vertexGatewayModelRoutingMap
	const modelRoutingMapValue =
		typeof rawModelRoutingMap === "string"
			? rawModelRoutingMap
			: rawModelRoutingMap
				? JSON.stringify(rawModelRoutingMap, null, 2)
				: ""
	const refreshInterval =
		typeof apiConfiguration?.refreshIntervalMinutes === "number"
			? apiConfiguration.refreshIntervalMinutes
			: apiConfiguration?.vertexGatewayTokenRefreshMinutes
	const refreshIntervalValue = typeof refreshInterval === "number" ? String(refreshInterval) : ""

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
				<Select value={location} onValueChange={(value) => setApiConfigurationField("location", value)}>
					<SelectTrigger className="w-full">
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
			<VSCodeTextField
				value={apiConfiguration?.gatewayBaseUrl || apiConfiguration?.vertexGatewayBaseUrl || ""}
				onInput={handleInputChange("gatewayBaseUrl")}
				placeholder={t("settings:placeholders.baseUrl")}
				className="w-full"
				data-testid="vertex-gateway-base-url">
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayBaseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.pemCaBundlePath || apiConfiguration?.vertexGatewayCaBundlePath || ""}
				onInput={handleInputChange("pemCaBundlePath")}
				placeholder={t("settings:placeholders.keyFilePath")}
				className="w-full"
				data-testid="vertex-gateway-ca-bundle-path">
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayCaBundlePath")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.helixCommand || apiConfiguration?.vertexGatewayHelixCommand || ""}
				onInput={handleInputChange("helixCommand")}
				placeholder={DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND}
				className="w-full"
				data-testid="vertex-gateway-helix-command">
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayHelixCommand")}</label>
			</VSCodeTextField>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayHelixParseMode")}</label>
				<Select
					value={apiConfiguration?.helixParseMode || "raw_stdout"}
					onValueChange={(value) =>
						setApiConfigurationField("helixParseMode", value as ProviderSettings["helixParseMode"])
					}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="raw_stdout">
							{t("settings:providers.vertexGatewayHelixParseModeRawStdout")}
						</SelectItem>
						<SelectItem value="json_field">
							{t("settings:providers.vertexGatewayHelixParseModeJsonField")}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<VSCodeTextField
				value={apiConfiguration?.helixTokenKey || "access_token"}
				onInput={handleInputChange("helixTokenKey")}
				placeholder="access_token"
				className="w-full"
				data-testid="vertex-gateway-helix-token-key">
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayHelixTokenKey")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={refreshIntervalValue}
				onInput={handleInputChange("refreshIntervalMinutes", (value) => {
					const parsed = Number.parseInt(value, 10)
					return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
				})}
				placeholder="10"
				className="w-full"
				data-testid="vertex-gateway-token-refresh-minutes">
				<label className="block font-medium mb-1">
					{t("settings:providers.vertexGatewayTokenRefreshMinutes")}
				</label>
			</VSCodeTextField>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.vertexGatewayModelRoutingMap")}</label>
				<VSCodeTextArea
					resize="vertical"
					value={modelRoutingMapValue}
					onInput={handleInputChange("modelRoutingMap")}
					placeholder='{"gemini-3-flash-preview":{"modelOverride":"gateway-model-id"}}'
					rows={4}
					className="w-full"
					data-testid="vertex-gateway-model-routing-map"
				/>
				<div className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.vertexGatewayModelRoutingMapDescription")}
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
