import { useAppTranslation } from "@/i18n/TranslationContext"

import { Slider } from "@/components/ui"
import { SettingsHelp } from "./SettingsHelp"

interface RateLimitSecondsControlProps {
	value: number
	onChange: (value: number) => void
}

export const RateLimitSecondsControl = ({ value, onChange }: RateLimitSecondsControlProps) => {
	const { t } = useAppTranslation()

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<label className="block font-medium">{t("settings:providers.rateLimitSeconds.label")}</label>
				<SettingsHelp label={t("settings:providers.rateLimitSeconds.label")}>
					{t("settings:providers.rateLimitSeconds.description", { value })}
				</SettingsHelp>
			</div>
			<div className="flex items-center gap-2">
				<Slider
					aria-label={t("settings:providers.rateLimitSeconds.label")}
					value={[value]}
					min={0}
					max={60}
					step={1}
					onValueChange={(newValue) => onChange(newValue[0])}
				/>
				<span className="w-10">{value}s</span>
			</div>
		</div>
	)
}
