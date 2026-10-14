import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { Slider } from "@/components/ui"

interface TemperatureControlProps {
	value: number | undefined | null
	onChange: (value: number | undefined | null) => void
	maxValue?: number // Some providers like OpenAI use 0-2 range.
	defaultValue?: number // Default temperature from model configuration
}

export const TemperatureControl = ({ value, onChange, maxValue = 1, defaultValue }: TemperatureControlProps) => {
	const { t } = useAppTranslation()
	const isCustomTemperature = value !== undefined && value !== null

	return (
		<>
			<div>
				<VSCodeCheckbox
					checked={isCustomTemperature}
					onChange={(e: any) => {
						onChange(e.target.checked ? (value ?? defaultValue ?? 0) : null)
					}}>
					<label className="block font-medium mb-1">{t("settings:temperature.useCustom")}</label>
				</VSCodeCheckbox>
				<div className="text-sm text-vscode-descriptionForeground mt-1">
					{t("settings:temperature.description")}
				</div>
			</div>

			{isCustomTemperature && (
				<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
					<div>
						<div className="flex items-center gap-2">
							<Slider
								min={0}
								max={maxValue}
								step={0.01}
								value={[value ?? 0]}
								onValueChange={([nextValue]) => onChange(nextValue)}
							/>
							<span className="w-10">{value}</span>
						</div>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:temperature.rangeDescription")}
						</div>
					</div>
				</div>
			)}
		</>
	)
}
