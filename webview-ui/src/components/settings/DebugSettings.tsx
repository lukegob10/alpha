import { useAppTranslation } from "@/i18n/TranslationContext"
import { Checkbox } from "@/components/ui"

import { Section, useSectionGroup } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"

export interface DebugSettingsProps {
	debug?: boolean
	setDebug: (debug: boolean) => void
	embedded?: boolean
}

export const DebugSettings = ({ debug = false, setDebug, embedded = true }: DebugSettingsProps) => {
	const { t } = useAppTranslation()
	const grouped = useSectionGroup()

	return (
		<div>
			{!embedded && <SectionHeader>{t("settings:debug.title")}</SectionHeader>}
			<Section>
				{embedded && !grouped && <h4 className="m-0 font-medium">{t("settings:debug.title")}</h4>}
				<SearchableSetting
					settingId="about-debug-mode"
					section="advanced"
					label={t("settings:about.debugMode.label")}>
					<div className="flex min-h-11 items-center justify-between gap-2">
						<div className="flex min-w-0 items-center gap-2">
							<Checkbox
								id="advanced-debug-mode"
								checked={debug}
								onCheckedChange={(checked) => setDebug(checked === true)}
							/>
							<label htmlFor="advanced-debug-mode" className="font-medium">
								{t("settings:about.debugMode.label")}
							</label>
						</div>
						<SettingsHelp label={t("settings:about.debugMode.label")}>
							{t("settings:about.debugMode.description")}
						</SettingsHelp>
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
