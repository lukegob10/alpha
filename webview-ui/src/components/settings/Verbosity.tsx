import {
	type ProviderSettings,
	type ModelInfo,
	type VerbosityLevel,
	verbosityLevels,
	resolveModelParameterApplicability,
} from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { SettingsHelp } from "./SettingsHelp"

interface VerbosityProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	modelInfo?: ModelInfo
	modelId?: string
}

export const Verbosity = ({ apiConfiguration, setApiConfigurationField, modelInfo, modelId }: VerbosityProps) => {
	const { t } = useAppTranslation()

	const { supportsVerbosity } = resolveModelParameterApplicability({
		modelId: modelId ?? apiConfiguration.openAiModelId ?? apiConfiguration.apiModelId ?? "",
		model: modelInfo,
		settings: apiConfiguration,
	})
	if (!supportsVerbosity) {
		return null
	}

	return (
		<div className="flex flex-col gap-1" data-testid="verbosity">
			<div className="flex items-center gap-1">
				<label className="block font-medium">{t("settings:providers.verbosity.label")}</label>
				<SettingsHelp label={t("settings:providers.verbosity.label")}>
					{t("settings:providers.verbosity.description")}
				</SettingsHelp>
			</div>
			<Select
				value={apiConfiguration.verbosity ?? "default"}
				onValueChange={(value) =>
					setApiConfigurationField("verbosity", value === "default" ? undefined : (value as VerbosityLevel))
				}>
				<SelectTrigger className="w-full">
					<SelectValue placeholder={t("settings:common.select")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="default">{t("settings:providers.verbosity.default")}</SelectItem>
					{verbosityLevels.map((value) => (
						<SelectItem key={value} value={value}>
							{t(`settings:providers.verbosity.${value}`)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}
