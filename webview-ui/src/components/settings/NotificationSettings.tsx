import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { Slider } from "../ui"

type NotificationSettingsProps = HTMLAttributes<HTMLDivElement> & {
	soundEnabled?: boolean
	soundVolume?: number
	setCachedStateField: SetCachedStateField<"soundEnabled" | "soundVolume">
}

export const NotificationSettings = ({
	soundEnabled,
	soundVolume,
	setCachedStateField,
	...props
}: NotificationSettingsProps) => {
	const { t } = useAppTranslation()
	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.notifications")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="notifications-sound"
					section="notifications"
					label={t("settings:notifications.sound.label")}>
					<VSCodeCheckbox
						checked={soundEnabled}
						onChange={(e: any) => setCachedStateField("soundEnabled", e.target.checked)}
						data-testid="sound-enabled-checkbox">
						<span className="font-medium">{t("settings:notifications.sound.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:notifications.sound.description")}
					</div>
				</SearchableSetting>

				{soundEnabled && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="notifications-sound-volume"
							section="notifications"
							label={t("settings:notifications.sound.volumeLabel")}>
							<label className="block font-medium mb-1">
								{t("settings:notifications.sound.volumeLabel")}
							</label>
							<div className="flex items-center gap-2">
								<Slider
									aria-label={t("settings:notifications.sound.volumeLabel")}
									min={0}
									max={1}
									step={0.01}
									value={[soundVolume ?? 0.5]}
									onValueChange={([value]) => setCachedStateField("soundVolume", value)}
									data-testid="sound-volume-slider"
								/>
								<span className="w-10">{((soundVolume ?? 0.5) * 100).toFixed(0)}%</span>
							</div>
						</SearchableSetting>
					</div>
				)}
			</Section>
		</div>
	)
}
