import { useId, type FormEvent } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { bedrockDefaultRegion, type ProviderSettings } from "@alpha-code/types"

import { SearchableSelect } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

type BedrockProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
}

/** AWS routing and credentials are edited in the caller's settings buffer. */
export const Bedrock = ({ apiConfiguration, setApiConfigurationField }: BedrockProps) => {
	const { t } = useAppTranslation()
	const id = useId()
	const authMethod = apiConfiguration.awsUseApiKey
		? "apiKey"
		: apiConfiguration.awsUseProfile
			? "profile"
			: "credentials"
	const update =
		<K extends keyof ProviderSettings>(field: K) =>
		(event: Event | FormEvent<HTMLElement>) =>
			setApiConfigurationField(field, (event.target as HTMLInputElement).value as ProviderSettings[K])

	return (
		<div className="flex flex-col gap-3" data-testid="bedrock-settings">
			<div className="flex flex-col gap-1">
				<label className="block font-medium">{t("settings:providers.bedrock.authMethod")}</label>
				<SearchableSelect
					value={authMethod}
					onValueChange={(value) => {
						setApiConfigurationField("awsUseApiKey", value === "apiKey")
						setApiConfigurationField("awsUseProfile", value === "profile")
					}}
					options={[
						{ value: "credentials", label: t("settings:providers.bedrock.credentials") },
						{ value: "profile", label: t("settings:providers.bedrock.profile") },
						{ value: "apiKey", label: t("settings:providers.bedrock.apiKey") },
					]}
					placeholder={t("settings:common.select")}
					searchPlaceholder={t("settings:providers.bedrock.searchAuthMethods")}
					emptyMessage={t("settings:providers.noMatchFound")}
					aria-label={t("settings:providers.bedrock.authMethod")}
				/>
			</div>
			{authMethod === "apiKey" ? (
				<VSCodeTextField
					id={`${id}-api-key`}
					type="password"
					value={apiConfiguration.awsApiKey ?? ""}
					onInput={update("awsApiKey")}
					aria-label={t("settings:providers.bedrock.apiKey")}
					className="w-full">
					<label htmlFor={`${id}-api-key`}>{t("settings:providers.bedrock.apiKey")}</label>
				</VSCodeTextField>
			) : authMethod === "profile" ? (
				<VSCodeTextField
					id={`${id}-profile`}
					value={apiConfiguration.awsProfile ?? ""}
					onInput={update("awsProfile")}
					aria-label={t("settings:providers.bedrock.profileName")}
					className="w-full">
					<label htmlFor={`${id}-profile`}>{t("settings:providers.bedrock.profileName")}</label>
				</VSCodeTextField>
			) : (
				<>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.bedrock.credentialsDescription")}
					</div>
					{(
						[
							["awsAccessKey", "accessKey"],
							["awsSecretKey", "secretKey"],
							["awsSessionToken", "sessionToken"],
						] as const
					).map(([field, label]) => (
						<VSCodeTextField
							key={field}
							id={`${id}-${field}`}
							type="password"
							value={apiConfiguration[field] ?? ""}
							onInput={update(field)}
							aria-label={t(`settings:providers.bedrock.${label}`)}
							className="w-full">
							<label htmlFor={`${id}-${field}`}>{t(`settings:providers.bedrock.${label}`)}</label>
						</VSCodeTextField>
					))}
				</>
			)}
			<VSCodeTextField
				id={`${id}-region`}
				value={apiConfiguration.awsRegion ?? bedrockDefaultRegion}
				onInput={update("awsRegion")}
				aria-label={t("settings:providers.bedrock.region")}
				className="w-full">
				<label htmlFor={`${id}-region`}>{t("settings:providers.bedrock.region")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				id={`${id}-inference-profile`}
				value={apiConfiguration.awsCustomArn ?? ""}
				onInput={update("awsCustomArn")}
				aria-label={t("settings:providers.bedrock.inferenceProfile")}
				aria-describedby={`${id}-inference-profile-description`}
				className="w-full">
				<label htmlFor={`${id}-inference-profile`}>{t("settings:providers.bedrock.inferenceProfile")}</label>
			</VSCodeTextField>
			<div id={`${id}-inference-profile-description`} className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.bedrock.inferenceProfileDescription")}
			</div>
		</div>
	)
}
