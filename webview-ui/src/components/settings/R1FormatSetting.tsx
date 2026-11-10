import { Checkbox } from "vscrui"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { SettingsHelp } from "./SettingsHelp"

interface R1FormatSettingProps {
	onChange: (value: boolean) => void
	openAiR1FormatEnabled?: boolean
}

export const R1FormatSetting = ({ onChange, openAiR1FormatEnabled }: R1FormatSettingProps) => {
	const { t } = useAppTranslation()

	return (
		<div className="flex items-center gap-1">
			<Checkbox checked={openAiR1FormatEnabled} onChange={onChange}>
				<span className="font-medium">{t("settings:modelInfo.enableR1Format")}</span>
			</Checkbox>
			<SettingsHelp label={t("settings:modelInfo.enableR1Format")}>
				{t("settings:modelInfo.enableR1FormatTips")}
			</SettingsHelp>
		</div>
	)
}
